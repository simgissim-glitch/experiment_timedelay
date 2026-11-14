BEGIN;
CREATE TABLE ai_latency_private.stimulus_versions(
  version text PRIMARY KEY CHECK(char_length(version) BETWEEN 1 AND 100),
  fingerprint text NOT NULL UNIQUE CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  environment text NOT NULL CHECK(environment IN('test','research')),
  question text NOT NULL CHECK(char_length(btrim(question)) BETWEEN 1 AND 10000),
  answer text NOT NULL CHECK(char_length(btrim(answer)) BETWEEN 1 AND 50000),
  error_key text NOT NULL, expected_truth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ai_latency_private.stimulus_deployment(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  version text NOT NULL REFERENCES ai_latency_private.stimulus_versions
);
ALTER TABLE ai_latency_private.chat_messages ADD UNIQUE(participant_id,chat_message_id);
ALTER TABLE ai_latency_private.chat_attempts ADD UNIQUE(participant_id,attempt_id);
CREATE TABLE ai_latency_private.participant_stimuli(
  participant_id uuid PRIMARY KEY REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  version text NOT NULL REFERENCES ai_latency_private.stimulus_versions,
  first_request_id uuid,
  initial_display_started_at timestamptz,
  initial_exposed_at timestamptz,
  exposure_delivery_id uuid,
  correction_status text NOT NULL DEFAULT 'not_assessed' CHECK(correction_status IN('not_assessed','corrected','not_corrected','unclear')),
  correction_message_id uuid,
  correction_assessed_at timestamptz, correction_assessor_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(participant_id,first_request_id) REFERENCES ai_latency_private.chat_requests(participant_id,request_id),
  FOREIGN KEY(participant_id,exposure_delivery_id) REFERENCES ai_latency_private.chat_attempts(participant_id,attempt_id),
  FOREIGN KEY(participant_id,correction_message_id) REFERENCES ai_latency_private.chat_messages(participant_id,chat_message_id)
);
ALTER TABLE ai_latency_private.chat_requests ADD COLUMN answer_origin text NOT NULL DEFAULT 'live_llm' CHECK(answer_origin IN('live_llm','fixed_initial')),
  ADD COLUMN stimulus_version text REFERENCES ai_latency_private.stimulus_versions;
CREATE INDEX participant_stimuli_exposure_idx ON ai_latency_private.participant_stimuli(initial_exposed_at);
DO $$ DECLARE tab text; DECLARE rol text; BEGIN
  FOREACH tab IN ARRAY ARRAY['stimulus_versions','stimulus_deployment','participant_stimuli'] LOOP
    EXECUTE format('ALTER TABLE ai_latency_private.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE ai_latency_private.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY owner_all ON ai_latency_private.%I FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true)',tab);
    EXECUTE format('CREATE POLICY admin_read ON ai_latency_private.%I FOR SELECT TO ai_latency_admin USING(true)',tab);
    EXECUTE format('GRANT SELECT ON ai_latency_private.%I TO ai_latency_admin',tab);
    EXECUTE format('REVOKE ALL ON ai_latency_private.%I FROM PUBLIC,ai_latency_app',tab);
    FOREACH rol IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=rol) THEN EXECUTE format('REVOKE ALL ON ai_latency_private.%I FROM %I',tab,rol); END IF;
    END LOOP;
  END LOOP;
END $$;

CREATE FUNCTION ai_latency_private.chat_stimulus(p_hash text,p_config jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE; DECLARE v ai_latency_private.stimulus_versions%ROWTYPE;
DECLARE binding ai_latency_private.participant_stimuli%ROWTYPE; DECLARE env text; DECLARE required boolean;
BEGIN
  SELECT * INTO s FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash FOR UPDATE;
  PERFORM ai_latency_private.workflow_access(p_hash,'workspace');
  SELECT environment INTO env FROM ai_latency_private.deployment_context WHERE singleton;
  IF p_config->>'environment' IS DISTINCT FROM env OR p_config->>'fingerprint' IS NULL OR p_config->>'version' IS NULL THEN
    RAISE EXCEPTION 'Invalid stimulus' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(811026,2);
  SELECT sv.* INTO v FROM ai_latency_private.stimulus_deployment d JOIN ai_latency_private.stimulus_versions sv USING(version) WHERE d.singleton;
  IF FOUND THEN
    IF v.fingerprint IS DISTINCT FROM p_config->>'fingerprint' OR v.question IS DISTINCT FROM p_config->>'question' OR v.answer IS DISTINCT FROM p_config->>'answer' OR
      v.version IS DISTINCT FROM p_config->>'version' OR v.error_key IS DISTINCT FROM p_config->>'errorKey' OR v.expected_truth IS DISTINCT FROM p_config->>'expectedTruth' THEN
      RAISE EXCEPTION 'Stimulus deployment mismatch' USING ERRCODE='55000'; END IF;
  ELSE
    INSERT INTO ai_latency_private.stimulus_versions(version,fingerprint,environment,question,answer,error_key,expected_truth)
    VALUES(p_config->>'version',p_config->>'fingerprint',env,p_config->>'question',p_config->>'answer',p_config->>'errorKey',p_config->>'expectedTruth') RETURNING * INTO v;
    INSERT INTO ai_latency_private.stimulus_deployment(singleton,version) VALUES(true,v.version);
  END IF;
  SELECT * INTO binding FROM ai_latency_private.participant_stimuli WHERE participant_id=s.participant_id;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM ai_latency_private.chat_requests WHERE participant_id=s.participant_id) THEN
      RAISE EXCEPTION 'Legacy conversation requires a separate study session' USING ERRCODE='55000'; END IF;
    INSERT INTO ai_latency_private.participant_stimuli(participant_id,version) VALUES(s.participant_id,v.version) RETURNING * INTO binding;
  END IF;
  required=NOT EXISTS(SELECT 1 FROM ai_latency_private.chat_requests WHERE participant_id=s.participant_id AND request_id=binding.first_request_id AND status='completed');
  RETURN jsonb_build_object('question',v.question,'answer',v.answer,'version',v.version,'initial_required',required,'first_request_id',binding.first_request_id);
END $$;

ALTER FUNCTION ai_latency_private.chat_claim(text,uuid,text,boolean,text,timestamptz,timestamptz) RENAME TO chat_claim_v5;
REVOKE ALL ON FUNCTION ai_latency_private.chat_claim_v5(text,uuid,text,boolean,text,timestamptz,timestamptz) FROM ai_latency_app;
CREATE FUNCTION ai_latency_private.chat_claim(p_hash text,p_request uuid,p_message text,p_retry boolean,p_model text,p_received timestamptz,p_submitted timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid; DECLARE binding ai_latency_private.participant_stimuli%ROWTYPE;
DECLARE result jsonb; DECLARE first boolean; DECLARE question_text text;
BEGIN
  SELECT participant_id INTO pid FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash FOR UPDATE;
  SELECT * INTO binding FROM ai_latency_private.participant_stimuli WHERE participant_id=pid;
  IF FOUND THEN
    first=binding.first_request_id IS NULL OR binding.first_request_id=p_request;
    IF first THEN
      SELECT question INTO question_text FROM ai_latency_private.stimulus_versions WHERE version=binding.version;
      IF p_message IS DISTINCT FROM question_text THEN RAISE EXCEPTION 'Initial question mismatch' USING ERRCODE='22023'; END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM ai_latency_private.chat_requests r JOIN ai_latency_private.chat_timings t USING(attempt_id)
      WHERE r.participant_id=pid AND r.request_id=binding.first_request_id AND r.status='completed' AND t.output_completed_at IS NOT NULL) THEN
      RETURN jsonb_build_object('execute',false,'error','CHAT_BUSY');
    END IF;
  END IF;
  result=ai_latency_private.chat_claim_v5(p_hash,p_request,p_message,p_retry,p_model,p_received,p_submitted);
  IF (result->>'execute')::boolean AND binding.participant_id IS NOT NULL AND first THEN
    UPDATE ai_latency_private.participant_stimuli SET first_request_id=p_request WHERE participant_id=pid;
    UPDATE ai_latency_private.chat_requests SET answer_origin='fixed_initial',stimulus_version=binding.version WHERE participant_id=pid AND request_id=p_request;
  END IF;
  RETURN result;
END $$;

ALTER FUNCTION ai_latency_private.chat_finish(text,uuid,uuid,text,text) RENAME TO chat_finish_v4;
REVOKE ALL ON FUNCTION ai_latency_private.chat_finish_v4(text,uuid,uuid,text,text) FROM ai_latency_app;
CREATE FUNCTION ai_latency_private.chat_finish(p_hash text,p_request uuid,p_attempt uuid,p_content text,p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expected text;
BEGIN
  SELECT v.answer INTO expected FROM ai_latency_private.participant_stimuli b JOIN ai_latency_private.stimulus_versions v USING(version)
    JOIN ai_latency_private.participant_sessions s USING(participant_id) WHERE s.token_hash=p_hash AND b.first_request_id=p_request;
  IF expected IS NOT NULL AND p_error IS NULL AND p_content IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Initial answer mismatch' USING ERRCODE='22023'; END IF;
  RETURN ai_latency_private.chat_finish_v4(p_hash,p_request,p_attempt,p_content,p_error);
END $$;

ALTER FUNCTION ai_latency_private.chat_presentation(text,uuid,text,timestamptz,double precision,boolean) RENAME TO chat_presentation_v5;
REVOKE ALL ON FUNCTION ai_latency_private.chat_presentation_v5(text,uuid,text,timestamptz,double precision,boolean) FROM ai_latency_app;
CREATE FUNCTION ai_latency_private.chat_presentation(p_hash text,p_delivery uuid,p_event text,p_at timestamptz,p_elapsed double precision,p_restored boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM ai_latency_private.chat_presentation_v5(p_hash,p_delivery,p_event,p_at,p_elapsed,p_restored);
  IF p_event='first-character' THEN
    UPDATE ai_latency_private.participant_stimuli b SET initial_display_started_at=t.first_character_at,exposure_delivery_id=t.attempt_id
    FROM ai_latency_private.chat_timings t,ai_latency_private.participant_sessions s
    WHERE s.token_hash=p_hash AND b.participant_id=s.participant_id AND t.participant_id=b.participant_id
      AND t.request_id=b.first_request_id AND t.attempt_id=p_delivery AND b.initial_display_started_at IS NULL;
  ELSIF p_event='output-completed' THEN
    UPDATE ai_latency_private.participant_stimuli b SET initial_exposed_at=t.output_completed_at,exposure_delivery_id=t.attempt_id
    FROM ai_latency_private.chat_timings t,ai_latency_private.participant_sessions s
    WHERE s.token_hash=p_hash AND b.participant_id=s.participant_id AND t.participant_id=b.participant_id
      AND t.request_id=b.first_request_id AND t.attempt_id=p_delivery AND b.initial_exposed_at IS NULL;
  END IF;
  RETURN true;
END $$;
DO $$ DECLARE signature text; DECLARE rol text; BEGIN
  FOREACH signature IN ARRAY ARRAY['chat_stimulus(text,jsonb)','chat_claim(text,uuid,text,boolean,text,timestamptz,timestamptz)',
    'chat_finish(text,uuid,uuid,text,text)','chat_presentation(text,uuid,text,timestamptz,double precision,boolean)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ai_latency_private.'||signature||' TO ai_latency_app';
    FOREACH rol IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=rol) THEN EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM '||quote_ident(rol); END IF;
    END LOOP;
  END LOOP;
END $$;
ALTER TABLE ai_latency_private.deployment_context DROP CONSTRAINT deployment_context_schema_version_check;
ALTER TABLE ai_latency_private.deployment_context ALTER COLUMN schema_version SET DEFAULT 6;
UPDATE ai_latency_private.deployment_context SET schema_version=6;
ALTER TABLE ai_latency_private.deployment_context ADD CHECK(schema_version=6);
COMMIT;
