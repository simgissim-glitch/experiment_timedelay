-- Supabase SQL Editor 또는 psql에서 관리자(마이그레이션 전용 계정)로 실행한다.
-- 실행 전 별도로 SET ai_latency.environment = 'test'; 또는 'research'; 를 설정한다.
-- 앱 시작/연결 점검에서는 실행하지 않는다. 재실행 시 실패하며 기존 테이블을 덮어쓰지 않는다.
BEGIN;

DO $$
BEGIN
  IF current_setting('ai_latency.environment', true) IS NULL
     OR current_setting('ai_latency.environment', true) NOT IN ('test', 'research') THEN
    RAISE EXCEPTION 'Set ai_latency.environment to test or research before migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_latency_app') THEN
    CREATE ROLE ai_latency_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_latency_admin') THEN
    CREATE ROLE ai_latency_admin NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('ai_latency_app', 'ai_latency_admin')
             AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Existing application group roles have unsafe privileges';
  END IF;
END $$;

CREATE SCHEMA ai_latency_private;
REVOKE ALL ON SCHEMA ai_latency_private FROM PUBLIC;
GRANT USAGE ON SCHEMA ai_latency_private TO ai_latency_app, ai_latency_admin;

-- 프로젝트 분리 실수를 감지하기 위한 운영 메타데이터. 연구 데이터가 아니다.
CREATE TABLE ai_latency_private.deployment_context (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('test', 'research')),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_latency_private.deployment_context (environment)
VALUES (current_setting('ai_latency.environment'));

-- participant_id 자체가 직접 식별정보와 연결되지 않는 익명 UUID다.
CREATE TABLE ai_latency_private.participants (
  participant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  consent boolean NOT NULL,
  consented_at timestamptz,
  condition_code text CHECK (condition_code IN ('c1', 'c2', 'c3')),
  progress_status text NOT NULL DEFAULT 'registered' CHECK (progress_status IN
    ('registered', 'pre_survey', 'task_guide', 'workspace', 'final_decision', 'post_survey', 'completed', 'withdrawn', 'declined')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (consented_at IS NULL OR consented_at >= started_at),
  CHECK ((consent AND consented_at IS NOT NULL AND progress_status <> 'declined') OR
         (NOT consent AND consented_at IS NULL AND condition_code IS NULL AND progress_status = 'declined')),
  CHECK ((progress_status IN ('completed', 'withdrawn', 'declined')) = (ended_at IS NOT NULL)),
  CHECK (progress_status IN ('registered', 'withdrawn', 'declined') OR condition_code IS NOT NULL)
);
CREATE INDEX participants_progress_started_idx ON ai_latency_private.participants (progress_status, started_at);

CREATE TABLE ai_latency_private.survey_responses (
  survey_response_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('pre', 'post')),
  questionnaire_version text NOT NULL CHECK (char_length(btrim(questionnaire_version)) BETWEEN 1 AND 100),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object' AND answers <> '{}'::jsonb),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (participant_id, phase),
  UNIQUE (participant_id, request_id)
);

CREATE TABLE ai_latency_private.chat_messages (
  chat_message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (char_length(btrim(content)) > 0 AND char_length(content) <= 50000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (participant_id, sequence_number),
  UNIQUE (participant_id, request_id)
);

CREATE TABLE ai_latency_private.search_events (
  search_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  query text NOT NULL CHECK (char_length(btrim(query)) > 0 AND char_length(query) <= 1000),
  executed_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (participant_id, request_id),
  UNIQUE (participant_id, search_event_id)
);
CREATE INDEX search_events_participant_time_idx ON ai_latency_private.search_events (participant_id, executed_at);

CREATE TABLE ai_latency_private.source_events (
  source_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  search_event_id uuid,
  request_id uuid NOT NULL,
  source_url text NOT NULL CHECK (char_length(source_url) <= 4096 AND source_url ~* '^https?://[^[:space:]]+$'),
  accessed_at timestamptz NOT NULL DEFAULT now(),
  returned_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (returned_at IS NULL OR returned_at >= accessed_at),
  UNIQUE (participant_id, request_id),
  FOREIGN KEY (participant_id, search_event_id)
    REFERENCES ai_latency_private.search_events (participant_id, search_event_id) ON DELETE RESTRICT
);
CREATE INDEX source_events_participant_time_idx ON ai_latency_private.source_events (participant_id, accessed_at);
CREATE INDEX source_events_search_idx ON ai_latency_private.source_events (participant_id, search_event_id);

CREATE TABLE ai_latency_private.behavior_events (
  behavior_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  event_type text NOT NULL CHECK (char_length(btrim(event_type)) BETWEEN 1 AND 100),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (participant_id, request_id)
);
CREATE INDEX behavior_events_participant_time_idx ON ai_latency_private.behavior_events (participant_id, occurred_at);
CREATE INDEX behavior_events_type_time_idx ON ai_latency_private.behavior_events (event_type, occurred_at);

CREATE TABLE ai_latency_private.final_decisions (
  final_decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL UNIQUE REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  product_code text NOT NULL CHECK (char_length(btrim(product_code)) BETWEEN 1 AND 100),
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) > 0 AND char_length(rationale) <= 10000),
  reference_notes text CHECK (char_length(reference_notes) <= 10000),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (participant_id, request_id)
);

CREATE FUNCTION ai_latency_private.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai_latency_private.touch_updated_at() FROM PUBLIC;
CREATE TRIGGER participants_updated_at BEFORE UPDATE ON ai_latency_private.participants
FOR EACH ROW EXECUTE FUNCTION ai_latency_private.touch_updated_at();

-- 비동의 참가자에게 연구 데이터가 추가되는 것을 DB에서도 거절한다.
CREATE FUNCTION ai_latency_private.require_consent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ai_latency_private.participants
                 WHERE participant_id = NEW.participant_id AND consent AND progress_status <> 'declined') THEN
    RAISE EXCEPTION 'Participant consent required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai_latency_private.require_consent() FROM PUBLIC;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['survey_responses', 'chat_messages', 'search_events', 'source_events', 'behavior_events', 'final_decisions'] LOOP
    EXECUTE format('CREATE TRIGGER require_participant_consent BEFORE INSERT OR UPDATE ON ai_latency_private.%I FOR EACH ROW EXECUTE FUNCTION ai_latency_private.require_consent()', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['deployment_context', 'participants', 'survey_responses', 'chat_messages', 'search_events', 'source_events', 'behavior_events', 'final_decisions'] LOOP
    EXECUTE format('ALTER TABLE ai_latency_private.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE ai_latency_private.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON ai_latency_private.%I FROM PUBLIC, ai_latency_app', table_name);
    EXECUTE format('GRANT SELECT ON ai_latency_private.%I TO ai_latency_admin', table_name);
    EXECUTE format('CREATE POLICY admin_read ON ai_latency_private.%I FOR SELECT TO ai_latency_admin USING (true)', table_name);
  END LOOP;
END $$;

-- 앱 계정은 환경 표식만 읽을 수 있다. 참가자별 접근 정책과 쓰기 권한은 다음 단계에 추가한다.
GRANT SELECT ON ai_latency_private.deployment_context TO ai_latency_app;
CREATE POLICY app_environment_read ON ai_latency_private.deployment_context
FOR SELECT TO ai_latency_app USING (true);

-- Supabase의 공개·인증 사용자·서비스 역할에 자동 부여된 권한도 제거한다.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA ai_latency_private FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ai_latency_private FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ai_latency_private FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA ai_latency_private REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA ai_latency_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
