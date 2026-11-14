BEGIN;
CREATE TABLE ai_latency_private.chat_timings (
  attempt_id uuid PRIMARY KEY REFERENCES ai_latency_private.chat_attempts ON DELETE RESTRICT,
  participant_id uuid NOT NULL REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  target_delay_ms integer NOT NULL CHECK(target_delay_ms IN(2000,9000,20000)),
  client_submitted_at timestamptz,
  server_received_at timestamptz NOT NULL,
  response_ready_at timestamptz,
  release_at timestamptz NOT NULL,
  first_character_at timestamptz,
  output_completed_at timestamptz,
  first_elapsed_ms double precision,
  completed_elapsed_ms double precision,
  first_event_received_at timestamptz,
  completed_event_received_at timestamptz,
  restored boolean,
  completion_restored boolean,
  CHECK(output_completed_at IS NULL OR first_character_at IS NOT NULL)
);
CREATE INDEX chat_timings_participant_time_idx ON ai_latency_private.chat_timings(participant_id,server_received_at);
ALTER TABLE ai_latency_private.chat_timings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_latency_private.chat_timings FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_all ON ai_latency_private.chat_timings FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);
CREATE POLICY admin_read ON ai_latency_private.chat_timings FOR SELECT TO ai_latency_admin USING(true);
GRANT SELECT ON ai_latency_private.chat_timings TO ai_latency_admin;
REVOKE ALL ON ai_latency_private.chat_timings FROM PUBLIC,ai_latency_app;

ALTER FUNCTION ai_latency_private.chat_claim(text,uuid,text,boolean,text) RENAME TO chat_claim_v4;
REVOKE ALL ON FUNCTION ai_latency_private.chat_claim_v4(text,uuid,text,boolean,text) FROM ai_latency_app;
CREATE FUNCTION ai_latency_private.chat_claim(p_hash text,p_request uuid,p_message text,p_retry boolean,p_model text,
  p_received timestamptz,p_submitted timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; DECLARE pid uuid; DECLARE delay_ms integer;
BEGIN
  -- 클라이언트 시계는 측정용이다. 공개 시각은 서버 수신 시각과 DB 조건으로만 결정한다.
  IF p_received IS NULL OR p_received>clock_timestamp()+interval '1 second' OR p_received<clock_timestamp()-interval '2 minutes' THEN
    RAISE EXCEPTION 'Invalid receive time' USING ERRCODE='22023'; END IF;
  SELECT participant_id INTO pid FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash;
  IF EXISTS(SELECT 1 FROM ai_latency_private.chat_requests r JOIN ai_latency_private.chat_timings t USING(attempt_id)
    WHERE r.participant_id=pid AND r.request_id<>p_request AND r.status='completed' AND t.release_at>clock_timestamp()) THEN
    RETURN jsonb_build_object('execute',false,'error','CHAT_BUSY'); END IF;
  result=ai_latency_private.chat_claim_v4(p_hash,p_request,p_message,p_retry,p_model);
  IF (result->>'execute')::boolean THEN
    SELECT CASE condition_code WHEN 'A' THEN 2000 WHEN 'B' THEN 9000 WHEN 'C' THEN 20000 END INTO delay_ms
      FROM ai_latency_private.participants WHERE participant_id=pid;
    INSERT INTO ai_latency_private.chat_timings(attempt_id,participant_id,request_id,target_delay_ms,client_submitted_at,server_received_at,release_at)
    VALUES((result->>'attempt_id')::uuid,pid,p_request,delay_ms,p_submitted,p_received,p_received+delay_ms*interval '1 millisecond');
  END IF;
  RETURN result;
END $$;

CREATE FUNCTION ai_latency_private.chat_ready(p_hash text,p_request uuid,p_attempt uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM ai_latency_private.workflow_access(p_hash,'workspace');
  UPDATE ai_latency_private.chat_timings t SET response_ready_at=clock_timestamp(),release_at=greatest(release_at,clock_timestamp())
  FROM ai_latency_private.participant_sessions s,ai_latency_private.chat_requests r
  WHERE s.token_hash=p_hash AND t.participant_id=s.participant_id AND t.attempt_id=p_attempt AND t.request_id=p_request
    AND r.attempt_id=t.attempt_id AND r.status='pending' AND t.response_ready_at IS NULL;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION ai_latency_private.chat_state(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid; DECLARE messages jsonb; DECLARE requests jsonb;
BEGIN
  PERFORM ai_latency_private.workflow_access(p_hash,'workspace');
  SELECT participant_id INTO pid FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash;
  SELECT jsonb_agg(jsonb_build_object('id',m.chat_message_id,'request_id',r.request_id,'role',m.role,'content',m.content,
    'sequence_number',m.sequence_number,'created_at',m.created_at,'delivery_id',t.attempt_id,'submitted_at',t.client_submitted_at,
    'presented',t.first_character_at IS NOT NULL,'output_completed',t.output_completed_at IS NOT NULL) ORDER BY m.sequence_number)
  INTO messages FROM ai_latency_private.chat_messages m LEFT JOIN ai_latency_private.chat_requests r USING(chat_request_id)
    LEFT JOIN ai_latency_private.chat_timings t ON t.attempt_id=r.attempt_id
  WHERE m.participant_id=pid AND (m.role='user' OR t.attempt_id IS NULL OR (t.response_ready_at IS NOT NULL AND t.release_at<=clock_timestamp()));
  SELECT jsonb_agg(jsonb_build_object('request_id',r.request_id,'status',
    CASE WHEN r.status='completed' AND t.release_at>clock_timestamp() THEN 'pending'
    WHEN r.status='pending' AND r.lease_expires_at<=clock_timestamp() THEN 'interrupted' ELSE r.status END,
    'error_code',CASE WHEN r.status='pending' AND r.lease_expires_at<=clock_timestamp() THEN 'AI_INTERRUPTED' ELSE r.error_code END,
    'attempts',r.attempts,'user_sequence',r.user_sequence) ORDER BY r.user_sequence)
  INTO requests FROM ai_latency_private.chat_requests r LEFT JOIN ai_latency_private.chat_timings t USING(attempt_id) WHERE r.participant_id=pid;
  RETURN jsonb_build_object('messages',coalesce(messages,'[]'::jsonb),'requests',coalesce(requests,'[]'::jsonb));
END $$;

CREATE FUNCTION ai_latency_private.chat_release(p_hash text,p_request uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result timestamptz;
BEGIN
  PERFORM ai_latency_private.workflow_access(p_hash,'workspace');
  SELECT t.release_at INTO result FROM ai_latency_private.chat_timings t JOIN ai_latency_private.chat_requests r USING(attempt_id)
    JOIN ai_latency_private.participant_sessions s ON s.participant_id=t.participant_id
  WHERE s.token_hash=p_hash AND r.request_id=p_request AND r.status='completed';
  RETURN result;
END $$;

CREATE FUNCTION ai_latency_private.chat_presentation(p_hash text,p_delivery uuid,p_event text,p_at timestamptz,p_elapsed double precision,p_restored boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t ai_latency_private.chat_timings%ROWTYPE;
BEGIN
  PERFORM ai_latency_private.workflow_access(p_hash,'workspace');
  IF p_event NOT IN('first-character','output-completed') OR p_at IS NULL OR p_restored IS NULL OR
    (p_elapsed IS NOT NULL AND (p_elapsed<0 OR p_elapsed>86400000 OR p_elapsed='NaN'::float8)) THEN
    RAISE EXCEPTION 'Invalid presentation event' USING ERRCODE='22023'; END IF;
  SELECT timing.* INTO t FROM ai_latency_private.chat_timings timing JOIN ai_latency_private.participant_sessions s USING(participant_id)
    JOIN ai_latency_private.chat_requests r USING(attempt_id)
  WHERE s.token_hash=p_hash AND timing.attempt_id=p_delivery AND r.status='completed' FOR UPDATE OF timing;
  IF NOT FOUND OR t.release_at>clock_timestamp() OR t.response_ready_at IS NULL THEN
    RAISE EXCEPTION 'Response not released' USING ERRCODE='42501'; END IF;
  IF p_event='first-character' AND t.first_character_at IS NULL THEN
    UPDATE ai_latency_private.chat_timings SET first_character_at=p_at,first_elapsed_ms=p_elapsed,
      first_event_received_at=clock_timestamp(),restored=p_restored WHERE attempt_id=p_delivery;
  ELSIF p_event='output-completed' AND t.output_completed_at IS NULL THEN
    IF t.first_character_at IS NULL OR p_at<t.first_character_at OR (p_elapsed IS NOT NULL AND p_elapsed<t.first_elapsed_ms) THEN
      RAISE EXCEPTION 'Invalid event order' USING ERRCODE='22023'; END IF;
    UPDATE ai_latency_private.chat_timings SET output_completed_at=p_at,completed_elapsed_ms=p_elapsed,
      completed_event_received_at=clock_timestamp(),completion_restored=p_restored WHERE attempt_id=p_delivery;
  END IF;
  RETURN true;
END $$;
DO $$ DECLARE signature text; DECLARE role_name text; BEGIN
  FOREACH signature IN ARRAY ARRAY['chat_claim(text,uuid,text,boolean,text,timestamptz,timestamptz)','chat_ready(text,uuid,uuid)',
    'chat_state(text)','chat_release(text,uuid)','chat_presentation(text,uuid,text,timestamptz,double precision,boolean)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ai_latency_private.'||signature||' TO ai_latency_app';
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM '||quote_ident(role_name);
        EXECUTE format('REVOKE ALL ON ai_latency_private.chat_timings FROM %I',role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
ALTER TABLE ai_latency_private.deployment_context DROP CONSTRAINT deployment_context_schema_version_check;
ALTER TABLE ai_latency_private.deployment_context ALTER COLUMN schema_version SET DEFAULT 5;
UPDATE ai_latency_private.deployment_context SET schema_version=5;
ALTER TABLE ai_latency_private.deployment_context ADD CHECK(schema_version=5);
COMMIT;
