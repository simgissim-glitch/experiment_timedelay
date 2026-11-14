BEGIN;
CREATE TABLE ai_latency_private.chat_requests (
  chat_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  user_sequence bigint NOT NULL CHECK (user_sequence>0),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('pending','completed','failed','interrupted')),
  error_code text,
  attempt_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL DEFAULT now()+interval '2 minutes',
  completed_at timestamptz,
  UNIQUE (participant_id,request_id), UNIQUE (participant_id,chat_request_id),
  CHECK ((status='pending') = (completed_at IS NULL)),
  CHECK (error_code IS NULL OR error_code IN ('AI_RATE_LIMITED','AI_ACCESS_DENIED','AI_TIMEOUT','AI_INTERRUPTED','AI_UNAVAILABLE','AI_EMPTY_RESPONSE','CHAT_HISTORY_TOO_LONG'))
);
CREATE UNIQUE INDEX chat_one_pending_per_participant ON ai_latency_private.chat_requests (participant_id) WHERE status='pending';
CREATE INDEX chat_requests_participant_created_idx ON ai_latency_private.chat_requests (participant_id,created_at);
CREATE TABLE ai_latency_private.chat_attempts (
  attempt_id uuid PRIMARY KEY,
  chat_request_id uuid NOT NULL REFERENCES ai_latency_private.chat_requests ON DELETE RESTRICT,
  participant_id uuid NOT NULL REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_attempts_participant_time_idx ON ai_latency_private.chat_attempts (participant_id,started_at);
CREATE INDEX chat_attempts_time_idx ON ai_latency_private.chat_attempts (started_at);
ALTER TABLE ai_latency_private.chat_messages ADD COLUMN chat_request_id uuid,
  ADD FOREIGN KEY (participant_id,chat_request_id) REFERENCES ai_latency_private.chat_requests (participant_id,chat_request_id) ON DELETE RESTRICT,
  ADD UNIQUE (chat_request_id,role);
CREATE POLICY chat_owner ON ai_latency_private.chat_messages FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['chat_requests','chat_attempts'] LOOP
    EXECUTE format('ALTER TABLE ai_latency_private.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE ai_latency_private.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON ai_latency_private.%I FROM PUBLIC,ai_latency_app',table_name);
    EXECUTE format('GRANT SELECT ON ai_latency_private.%I TO ai_latency_admin',table_name);
    EXECUTE format('CREATE POLICY admin_read ON ai_latency_private.%I FOR SELECT TO ai_latency_admin USING (true)',table_name);
    EXECUTE format('CREATE POLICY chat_owner ON ai_latency_private.%I FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)',table_name);
  END LOOP;
END $$;

CREATE FUNCTION ai_latency_private.chat_state(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid; DECLARE messages jsonb; DECLARE requests jsonb;
BEGIN
  PERFORM ai_latency_private.workflow_access(p_hash,'workspace');
  SELECT participant_id INTO pid FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash;
  SELECT jsonb_agg(jsonb_build_object('id',chat_message_id,'request_id',r.request_id,'role',m.role,
    'content',m.content,'sequence_number',sequence_number,'created_at',m.created_at) ORDER BY sequence_number)
  INTO messages FROM ai_latency_private.chat_messages m LEFT JOIN ai_latency_private.chat_requests r USING(chat_request_id)
  WHERE m.participant_id=pid;
  SELECT jsonb_agg(jsonb_build_object('request_id',request_id,'status',
    CASE WHEN status='pending' AND lease_expires_at<=now() THEN 'interrupted' ELSE status END,
    'error_code',CASE WHEN status='pending' AND lease_expires_at<=now() THEN 'AI_INTERRUPTED' ELSE error_code END,
    'attempts',attempts,'user_sequence',user_sequence) ORDER BY user_sequence)
  INTO requests FROM ai_latency_private.chat_requests WHERE participant_id=pid;
  RETURN jsonb_build_object('messages',coalesce(messages,'[]'::jsonb),'requests',coalesce(requests,'[]'::jsonb));
END $$;

CREATE FUNCTION ai_latency_private.chat_claim(p_hash text,p_request uuid,p_message text,p_retry boolean,p_model text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE;
DECLARE r ai_latency_private.chat_requests%ROWTYPE;
DECLARE seq bigint; DECLARE aid uuid; DECLARE previous_content text;
BEGIN
  IF p_message IS NULL OR char_length(btrim(p_message))=0 OR char_length(p_message)>10000 OR p_request IS NULL OR p_retry IS NULL OR
     p_model IS NULL OR char_length(p_model) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid message' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash AND expires_at>now() AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
  PERFORM ai_latency_private.workflow_access(p_hash,'workspace');
  IF NOT EXISTS (SELECT 1 FROM ai_latency_private.participants WHERE participant_id=s.participant_id AND current_step='workspace') THEN
    RAISE EXCEPTION 'Wrong step' USING ERRCODE='42501'; END IF;
  UPDATE ai_latency_private.chat_requests SET status='interrupted',error_code='AI_INTERRUPTED',completed_at=now()
  WHERE participant_id=s.participant_id AND status='pending' AND lease_expires_at<=now();
  SELECT * INTO r FROM ai_latency_private.chat_requests WHERE participant_id=s.participant_id AND request_id=p_request;
  IF FOUND THEN
    SELECT content INTO previous_content FROM ai_latency_private.chat_messages WHERE chat_request_id=r.chat_request_id AND role='user';
    IF previous_content IS DISTINCT FROM p_message THEN RETURN jsonb_build_object('execute',false,'error','CHAT_REQUEST_CONFLICT'); END IF;
    IF r.status IN ('completed','pending') OR NOT p_retry THEN
      RETURN jsonb_build_object('execute',false,'status',r.status,'error_code',r.error_code);
    END IF;
    IF r.model<>p_model OR EXISTS (SELECT 1 FROM ai_latency_private.chat_requests WHERE participant_id=s.participant_id AND user_sequence>r.user_sequence) THEN
      RETURN jsonb_build_object('execute',false,'error','CHAT_REQUEST_CONFLICT'); END IF;
    IF r.attempts>=3 THEN RETURN jsonb_build_object('execute',false,'error','CHAT_RETRY_LIMIT'); END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM ai_latency_private.chat_requests WHERE participant_id=s.participant_id AND status='pending') THEN
    RETURN jsonb_build_object('execute',false,'error','CHAT_BUSY'); END IF;
  -- 짧은 전역 잠금으로 여러 서버 인스턴스에서도 청구 가능한 호출량을 제한한다.
  PERFORM pg_advisory_xact_lock(811026,1);
  IF (SELECT count(*) FROM ai_latency_private.chat_attempts WHERE participant_id=s.participant_id)>=100 THEN
    RETURN jsonb_build_object('execute',false,'error','CHAT_LIMIT_REACHED'); END IF;
  IF (SELECT count(*) FROM ai_latency_private.chat_attempts WHERE participant_id=s.participant_id AND started_at>now()-interval '1 minute')>=5 OR
     (SELECT count(*) FROM ai_latency_private.chat_attempts WHERE started_at>now()-interval '1 minute')>=60 OR
     (SELECT count(*) FROM ai_latency_private.chat_requests WHERE status='pending' AND lease_expires_at>now())>=10 THEN
    RETURN jsonb_build_object('execute',false,'error','CHAT_RATE_LIMITED'); END IF;
  aid=gen_random_uuid();
  IF r.chat_request_id IS NULL THEN
    SELECT coalesce(max(sequence_number),0)+1 INTO seq FROM ai_latency_private.chat_messages WHERE participant_id=s.participant_id;
    INSERT INTO ai_latency_private.chat_requests (participant_id,request_id,user_sequence,model,status,attempt_id)
    VALUES (s.participant_id,p_request,seq,p_model,'pending',aid) RETURNING * INTO r;
    INSERT INTO ai_latency_private.chat_messages (participant_id,request_id,sequence_number,role,content,chat_request_id)
    VALUES (s.participant_id,p_request,seq,'user',p_message,r.chat_request_id);
  ELSE
    UPDATE ai_latency_private.chat_requests SET status='pending',error_code=null,attempt_id=aid,attempts=attempts+1,
      started_at=now(),lease_expires_at=now()+interval '2 minutes',completed_at=null
    WHERE chat_request_id=r.chat_request_id;
  END IF;
  INSERT INTO ai_latency_private.chat_attempts (attempt_id,chat_request_id,participant_id) VALUES (aid,r.chat_request_id,s.participant_id);
  RETURN jsonb_build_object('execute',true,'attempt_id',aid);
END $$;

CREATE FUNCTION ai_latency_private.chat_context(p_hash text,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid; DECLARE result jsonb;
BEGIN
  PERFORM ai_latency_private.workflow_access(p_hash,'workspace');
  SELECT participant_id INTO pid FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash;
  SELECT jsonb_agg(jsonb_build_object('role',m.role,'content',m.content) ORDER BY sequence_number) INTO result
  FROM ai_latency_private.chat_messages m JOIN ai_latency_private.chat_requests r USING(chat_request_id)
  WHERE m.participant_id=pid AND (r.status='completed' OR (r.request_id=p_request AND r.status='pending' AND m.role='user'));
  RETURN coalesce(result,'[]'::jsonb);
END $$;

CREATE FUNCTION ai_latency_private.chat_finish(p_hash text,p_request uuid,p_attempt uuid,p_content text,p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE; DECLARE r ai_latency_private.chat_requests%ROWTYPE;
DECLARE seq bigint; DECLARE failure text;
BEGIN
  SELECT * INTO s FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
  SELECT * INTO r FROM ai_latency_private.chat_requests WHERE participant_id=s.participant_id AND request_id=p_request FOR UPDATE;
  IF NOT FOUND OR r.status<>'pending' OR r.attempt_id IS DISTINCT FROM p_attempt THEN RETURN false; END IF;
  failure=p_error;
  IF s.disposition<>'active' OR s.expires_at<=now() OR s.revoked_at IS NOT NULL OR r.lease_expires_at<=now() THEN failure='AI_INTERRUPTED'; END IF;
  IF failure IS NULL THEN
    IF p_content IS NULL OR char_length(btrim(p_content))=0 OR char_length(p_content)>50000 THEN RAISE EXCEPTION 'Invalid response' USING ERRCODE='22023'; END IF;
    PERFORM ai_latency_private.workflow_access(p_hash,'workspace');
    SELECT coalesce(max(sequence_number),0)+1 INTO seq FROM ai_latency_private.chat_messages WHERE participant_id=s.participant_id;
    INSERT INTO ai_latency_private.chat_messages (participant_id,request_id,sequence_number,role,content,chat_request_id)
    VALUES (s.participant_id,gen_random_uuid(),seq,'assistant',p_content,r.chat_request_id);
  END IF;
  UPDATE ai_latency_private.chat_requests SET
    status=CASE WHEN failure IS NULL THEN 'completed' WHEN failure IN ('AI_INTERRUPTED','AI_TIMEOUT') THEN 'interrupted' ELSE 'failed' END,
    error_code=failure,completed_at=now() WHERE chat_request_id=r.chat_request_id;
  RETURN failure IS NULL;
END $$;

DO $$ DECLARE signature text; DECLARE role_name text; BEGIN
  FOREACH signature IN ARRAY ARRAY['chat_state(text)','chat_claim(text,uuid,text,boolean,text)','chat_context(text,uuid)','chat_finish(text,uuid,uuid,text,text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ai_latency_private.'||signature||' TO ai_latency_app';
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM '||quote_ident(role_name); END IF;
    END LOOP;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ai_latency_private.chat_requests,ai_latency_private.chat_attempts FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
ALTER TABLE ai_latency_private.deployment_context DROP CONSTRAINT deployment_context_schema_version_check;
ALTER TABLE ai_latency_private.deployment_context ALTER COLUMN schema_version SET DEFAULT 4;
UPDATE ai_latency_private.deployment_context SET schema_version=4;
ALTER TABLE ai_latency_private.deployment_context ADD CHECK (schema_version=4);
COMMIT;
