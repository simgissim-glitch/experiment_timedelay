-- 001 적용 후 실행. 기존 참가자 데이터가 있으면 자동 변환하지 않고 중단한다.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ai_latency_private.participants) THEN
    RAISE EXCEPTION 'Existing participant data requires an explicit reviewed migration';
  END IF;
END $$;
ALTER TABLE ai_latency_private.participants DROP CONSTRAINT participants_condition_code_check;
ALTER TABLE ai_latency_private.participants
  ADD CONSTRAINT participants_condition_code_check CHECK (condition_code IN ('A', 'B', 'C')),
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN eligible boolean,
  ADD COLUMN eligibility_version text,
  ADD CONSTRAINT assignment_complete CHECK (
    (condition_code IS NULL AND assigned_at IS NULL) OR
    (condition_code IS NOT NULL AND assigned_at IS NOT NULL AND eligible IS TRUE AND consent IS TRUE AND eligibility_version IS NOT NULL)),
  ADD CONSTRAINT assignment_time CHECK (assigned_at IS NULL OR assigned_at >= consented_at);

CREATE TABLE ai_latency_private.participant_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  participant_id uuid UNIQUE REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX participant_sessions_expiry_idx ON ai_latency_private.participant_sessions (expires_at);
ALTER TABLE ai_latency_private.participant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_latency_private.participant_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ai_latency_private.participant_sessions FROM PUBLIC, ai_latency_app, ai_latency_admin;

-- 정의자 권한은 마이그레이션 관리자에게만 있으며 앱에는 아래 함수 실행만 허용한다.
CREATE POLICY enrollment_owner ON ai_latency_private.participant_sessions
FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY enrollment_owner ON ai_latency_private.participants
FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

CREATE FUNCTION ai_latency_private.enrollment_create_session(p_hash text, p_ttl_seconds integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 2592000 THEN
    RAISE EXCEPTION 'Invalid session lifetime' USING ERRCODE = '22023';
  END IF;
  INSERT INTO ai_latency_private.participant_sessions (token_hash, expires_at)
  VALUES (p_hash, now() + p_ttl_seconds * interval '1 second');
END $$;

CREATE FUNCTION ai_latency_private.enrollment_session_status(p_hash text)
RETURNS TABLE (participant_id uuid, progress_status text, registered boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT p.participant_id, p.progress_status, p.participant_id IS NOT NULL
  FROM ai_latency_private.participant_sessions s
  LEFT JOIN ai_latency_private.participants p ON p.participant_id = s.participant_id
  WHERE s.token_hash = p_hash AND s.expires_at > now() AND s.revoked_at IS NULL
$$;

CREATE FUNCTION ai_latency_private.enrollment_register(p_hash text, p_condition text, p_eligibility_version text)
RETURNS TABLE (participant_id uuid, progress_status text, registered boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE session_row ai_latency_private.participant_sessions%ROWTYPE;
DECLARE new_participant uuid;
BEGIN
  IF p_condition IS NULL OR p_condition NOT IN ('A','B','C') OR p_eligibility_version IS NULL
     OR char_length(p_eligibility_version) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid enrollment data' USING ERRCODE = '22023';
  END IF;
  IF p_eligibility_version = 'development-only-v1' AND NOT EXISTS (
    SELECT 1 FROM ai_latency_private.deployment_context WHERE environment = 'test'
  ) THEN
    RAISE EXCEPTION 'Development eligibility is not allowed in research' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO session_row FROM ai_latency_private.participant_sessions s
  WHERE s.token_hash = p_hash AND s.expires_at > now() AND s.revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE = '28000'; END IF;
  IF session_row.participant_id IS NULL THEN
    INSERT INTO ai_latency_private.participants
      (request_id, consent, consented_at, condition_code, assigned_at, eligible, eligibility_version, progress_status)
    VALUES (session_row.session_id, true, now(), p_condition, now(), true, p_eligibility_version, 'pre_survey')
    RETURNING ai_latency_private.participants.participant_id INTO new_participant;
    UPDATE ai_latency_private.participant_sessions s SET participant_id = new_participant
    WHERE s.session_id = session_row.session_id;
  END IF;
  RETURN QUERY SELECT * FROM ai_latency_private.enrollment_session_status(p_hash);
END $$;

CREATE FUNCTION ai_latency_private.protect_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.participant_id IS DISTINCT FROM OLD.participant_id OR
     (OLD.condition_code IS NOT NULL AND
       (NEW.condition_code IS DISTINCT FROM OLD.condition_code OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
        OR NEW.eligible IS DISTINCT FROM OLD.eligible OR NEW.eligibility_version IS DISTINCT FROM OLD.eligibility_version)) THEN
    RAISE EXCEPTION 'Participant assignment is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_assignment BEFORE UPDATE ON ai_latency_private.participants
FOR EACH ROW EXECUTE FUNCTION ai_latency_private.protect_assignment();

REVOKE ALL ON FUNCTION ai_latency_private.enrollment_create_session(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_latency_private.enrollment_session_status(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_latency_private.enrollment_register(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_latency_private.protect_assignment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_latency_private.enrollment_create_session(text, integer) TO ai_latency_app;
GRANT EXECUTE ON FUNCTION ai_latency_private.enrollment_session_status(text) TO ai_latency_app;
GRANT EXECUTE ON FUNCTION ai_latency_private.enrollment_register(text, text, text) TO ai_latency_app;

DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON ai_latency_private.participant_sessions FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION ai_latency_private.enrollment_create_session(text, integer) FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION ai_latency_private.enrollment_session_status(text) FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION ai_latency_private.enrollment_register(text, text, text) FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
ALTER TABLE ai_latency_private.deployment_context DROP CONSTRAINT deployment_context_schema_version_check;
ALTER TABLE ai_latency_private.deployment_context ALTER COLUMN schema_version SET DEFAULT 2;
UPDATE ai_latency_private.deployment_context SET schema_version = 2;
ALTER TABLE ai_latency_private.deployment_context ADD CHECK (schema_version = 2);
COMMIT;
