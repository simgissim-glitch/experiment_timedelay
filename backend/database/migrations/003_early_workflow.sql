-- 001, 002 이후 관리자 계정으로 적용한다. 화면/설문 문구는 아직 연구자 미확정 초안이다.
BEGIN;
ALTER TABLE ai_latency_private.participants
  ADD COLUMN current_step text NOT NULL DEFAULT 'pre-survey'
    CHECK (current_step IN ('consent','pre-survey','task-guide','workspace','decision','post-survey','debriefing')),
  ADD COLUMN screening_status text NOT NULL DEFAULT 'pending' CHECK (screening_status IN ('pending','passed','failed')),
  ADD COLUMN termination_reason text CHECK (termination_reason IN ('no_ai_experience','voluntary_withdrawal')),
  ADD COLUMN task_guide_version text;
ALTER TABLE ai_latency_private.participants DROP CONSTRAINT participants_progress_status_check;
ALTER TABLE ai_latency_private.participants ADD CONSTRAINT participants_progress_status_check
  CHECK (progress_status IN ('registered','pre_survey','task_guide','workspace','final_decision','post_survey','completed','withdrawn','declined','ineligible'));
DO $$ DECLARE constraint_name text; BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'ai_latency_private.participants'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%progress_status%'
      AND pg_get_constraintdef(oid) LIKE '%ended_at IS NOT NULL%'
  LOOP EXECUTE format('ALTER TABLE ai_latency_private.participants DROP CONSTRAINT %I', constraint_name); END LOOP;
END $$;
ALTER TABLE ai_latency_private.participants ADD CONSTRAINT participant_terminal_time
  CHECK ((progress_status IN ('completed','withdrawn','declined','ineligible')) = (ended_at IS NOT NULL));

ALTER TABLE ai_latency_private.participant_sessions
  ADD COLUMN disposition text NOT NULL DEFAULT 'active' CHECK (disposition IN ('active','declined','withdrawn','ineligible')),
  ADD COLUMN consent_decision boolean,
  ADD COLUMN consent_version text,
  ADD COLUMN consent_completed_at timestamptz,
  ADD COLUMN terminated_at timestamptz,
  ADD CHECK (consent_completed_at IS NULL OR consent_completed_at >= created_at),
  ADD CHECK ((disposition = 'active') = (terminated_at IS NULL));

CREATE TABLE ai_latency_private.participant_steps (
  participant_id uuid NOT NULL REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
  step text NOT NULL CHECK (step IN ('consent','pre-survey','task-guide','workspace','decision','post-survey','debriefing')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  timing_source text NOT NULL DEFAULT 'observed' CHECK (timing_source IN ('observed','legacy-derived')),
  PRIMARY KEY (participant_id, step),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);
CREATE INDEX participant_steps_step_time_idx ON ai_latency_private.participant_steps (step, started_at);
ALTER TABLE ai_latency_private.participant_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_latency_private.participant_steps FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ai_latency_private.participant_steps FROM PUBLIC, ai_latency_app;
GRANT SELECT ON ai_latency_private.participant_steps TO ai_latency_admin;
CREATE POLICY admin_read ON ai_latency_private.participant_steps FOR SELECT TO ai_latency_admin USING (true);
CREATE POLICY workflow_owner ON ai_latency_private.participant_steps FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY workflow_owner ON ai_latency_private.survey_responses FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION ai_latency_private.require_consent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ai_latency_private.participants WHERE participant_id=NEW.participant_id
    AND consent AND progress_status NOT IN ('declined','withdrawn','ineligible','completed')) THEN
    RAISE EXCEPTION 'Active consent required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE ai_latency_private.survey_responses
  ADD COLUMN is_draft boolean NOT NULL DEFAULT false,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ALTER COLUMN submitted_at DROP NOT NULL,
  ALTER COLUMN submitted_at DROP DEFAULT,
  ADD CHECK (is_draft = (submitted_at IS NULL));
ALTER TABLE ai_latency_private.survey_responses DROP CONSTRAINT survey_responses_answers_check;
ALTER TABLE ai_latency_private.survey_responses ADD CONSTRAINT survey_answers_shape
  CHECK (jsonb_typeof(answers)='object' AND (is_draft OR answers<>'{}'::jsonb));

-- 기존의 입증 가능한 DB 기록만 이관한다. 과거 화면 표시 시각으로 가장하지 않는다.
UPDATE ai_latency_private.participants SET current_step = CASE progress_status
  WHEN 'task_guide' THEN 'task-guide' WHEN 'workspace' THEN 'workspace'
  WHEN 'final_decision' THEN 'decision' WHEN 'post_survey' THEN 'post-survey'
  WHEN 'completed' THEN 'debriefing' ELSE 'pre-survey' END;
UPDATE ai_latency_private.participant_sessions s SET consent_decision=p.consent,
  consent_version='legacy-unspecified', consent_completed_at=p.consented_at,
  disposition=CASE WHEN p.progress_status='withdrawn' THEN 'withdrawn' ELSE 'active' END,
  terminated_at=CASE WHEN p.progress_status='withdrawn' THEN p.ended_at END
FROM ai_latency_private.participants p WHERE p.participant_id=s.participant_id;
INSERT INTO ai_latency_private.participant_steps (participant_id,step,started_at,completed_at,timing_source)
SELECT participant_id,'consent',started_at,consented_at,'legacy-derived'
FROM ai_latency_private.participants WHERE consent;
INSERT INTO ai_latency_private.participant_steps (participant_id,step,started_at,timing_source)
SELECT participant_id,current_step,updated_at,'legacy-derived' FROM ai_latency_private.participants;

CREATE FUNCTION ai_latency_private.workflow_state(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE;
DECLARE p ai_latency_private.participants%ROWTYPE;
DECLARE survey jsonb;
DECLARE step_times jsonb;
BEGIN
  SELECT * INTO s FROM ai_latency_private.participant_sessions
  WHERE token_hash=p_hash AND expires_at>now() AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
  IF s.participant_id IS NOT NULL THEN
    SELECT * INTO p FROM ai_latency_private.participants WHERE participant_id=s.participant_id;
    SELECT jsonb_build_object('answers',answers,'is_draft',is_draft,'revision',revision,
      'version',questionnaire_version,'submitted_at',submitted_at) INTO survey
    FROM ai_latency_private.survey_responses WHERE participant_id=s.participant_id AND phase='pre';
    SELECT jsonb_agg(jsonb_build_object('step',step,'started_at',started_at,
      'completed_at',completed_at,'timing_source',timing_source) ORDER BY started_at,step) INTO step_times
    FROM ai_latency_private.participant_steps WHERE participant_id=s.participant_id;
  END IF;
  RETURN jsonb_build_object('registered',s.participant_id IS NOT NULL,'participant_id',s.participant_id,
    'current_step',coalesce(p.current_step,'consent'),'disposition',s.disposition,
    'screening_status',coalesce(p.screening_status,'pending'),
    'consent',jsonb_build_object('decision',s.consent_decision,'version',s.consent_version,
      'started_at',s.created_at,'completed_at',s.consent_completed_at,'document_is_draft',true),
    'pre_survey',coalesce(survey,jsonb_build_object('answers','{}'::jsonb,'is_draft',true,'revision',0,'version','pre-draft-v1','submitted_at',null)),
    'steps',coalesce(step_times,'[]'::jsonb));
END $$;

-- 002 함수는 외부 실행을 막고, 같은 트랜잭션에서 동의·단계 기록까지 함께 처리한다.
ALTER FUNCTION ai_latency_private.enrollment_register(text,text,text) RENAME TO enrollment_register_v2;
REVOKE ALL ON FUNCTION ai_latency_private.enrollment_register_v2(text,text,text) FROM ai_latency_app, PUBLIC;
CREATE FUNCTION ai_latency_private.enrollment_register(p_hash text,p_condition text,p_eligibility_version text)
RETURNS TABLE (participant_id uuid,progress_status text,registered boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE;
DECLARE result_id uuid;
BEGIN
  SELECT * INTO s FROM ai_latency_private.participant_sessions
  WHERE token_hash=p_hash AND expires_at>now() AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
  IF s.disposition<>'active' THEN RAISE EXCEPTION 'Participation ended' USING ERRCODE='55000'; END IF;
  PERFORM * FROM ai_latency_private.enrollment_register_v2(p_hash,p_condition,p_eligibility_version);
  SELECT x.participant_id INTO result_id FROM ai_latency_private.participant_sessions x WHERE x.session_id=s.session_id;
  IF s.participant_id IS NULL THEN
    UPDATE ai_latency_private.participant_sessions SET consent_decision=true,consent_version='draft-consent-v1',consent_completed_at=now()
    WHERE session_id=s.session_id;
    UPDATE ai_latency_private.participants SET started_at=s.created_at WHERE ai_latency_private.participants.participant_id=result_id;
    INSERT INTO ai_latency_private.participant_steps (participant_id,step,started_at,completed_at)
    VALUES (result_id,'consent',s.created_at,now()),(result_id,'pre-survey',now(),null);
  END IF;
  RETURN QUERY SELECT * FROM ai_latency_private.enrollment_session_status(p_hash);
END $$;

CREATE FUNCTION ai_latency_private.workflow_terminate(p_hash text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('declined','withdrawn') THEN RAISE EXCEPTION 'Invalid reason' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash AND expires_at>now() AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
  IF s.disposition<>'active' THEN RETURN ai_latency_private.workflow_state(p_hash); END IF;
  IF p_reason='declined' AND s.participant_id IS NOT NULL THEN RAISE EXCEPTION 'Use withdrawal for registered participants' USING ERRCODE='22023'; END IF;
  IF s.participant_id IS NOT NULL THEN
    UPDATE ai_latency_private.participants SET progress_status='withdrawn',termination_reason='voluntary_withdrawal',ended_at=now()
    WHERE participant_id=s.participant_id;
    -- 미완료 단계를 완료로 가장하지 않는다. 중단 시각은 ended_at에만 기록한다.
  END IF;
  UPDATE ai_latency_private.participant_sessions SET disposition=p_reason,terminated_at=now(),
    consent_decision=CASE WHEN p_reason='declined' THEN false ELSE consent_decision END,
    consent_version=CASE WHEN p_reason='declined' THEN 'draft-consent-v1' ELSE consent_version END,
    consent_completed_at=CASE WHEN p_reason='declined' THEN now() ELSE consent_completed_at END
  WHERE session_id=s.session_id;
  RETURN ai_latency_private.workflow_state(p_hash);
END $$;

CREATE FUNCTION ai_latency_private.workflow_save_pre(p_hash text,p_answers jsonb,p_submit boolean,p_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE;
DECLARE p ai_latency_private.participants%ROWTYPE;
DECLARE r ai_latency_private.survey_responses%ROWTYPE;
DECLARE old_revision integer;
BEGIN
  IF p_submit IS NULL OR p_revision IS NULL OR p_revision<0 OR p_answers IS NULL OR jsonb_typeof(p_answers)<>'object' OR (p_submit AND p_answers='{}'::jsonb)
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_answers) k WHERE k NOT IN ('aiExperience','aiFrequency','priorKnowledge')) THEN
    RAISE EXCEPTION 'Invalid survey data' USING ERRCODE='22023';
  END IF;
  IF (p_answers ? 'aiExperience' AND (jsonb_typeof(p_answers->'aiExperience')<>'string' OR p_answers->>'aiExperience' NOT IN ('some','none')))
     OR (p_answers ? 'aiFrequency' AND (jsonb_typeof(p_answers->'aiFrequency')<>'string' OR p_answers->>'aiFrequency' NOT IN ('never','rarely','monthly','weekly','daily')))
     OR (p_answers ? 'priorKnowledge' AND (jsonb_typeof(p_answers->'priorKnowledge')<>'string' OR p_answers->>'priorKnowledge' NOT IN ('low','medium','high'))) THEN
    RAISE EXCEPTION 'Invalid response value' USING ERRCODE='22023';
  END IF;
  IF p_submit AND (NOT p_answers ? 'aiExperience' OR
      (p_answers->>'aiExperience'='some' AND (NOT p_answers ?& ARRAY['aiFrequency','priorKnowledge'] OR p_answers->>'aiFrequency'='never'))) THEN
    RAISE EXCEPTION 'Required responses missing' USING ERRCODE='22023';
  END IF;
  SELECT * INTO s FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash AND expires_at>now() AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
  IF s.participant_id IS NULL THEN RAISE EXCEPTION 'Consent required' USING ERRCODE='42501'; END IF;
  SELECT * INTO p FROM ai_latency_private.participants WHERE participant_id=s.participant_id FOR UPDATE;
  SELECT * INTO r FROM ai_latency_private.survey_responses WHERE participant_id=s.participant_id AND phase='pre';
  -- 동일 최종 제출의 응답 손실 재시도는 단계와 무관하게 기존 상태를 반환한다.
  IF p_submit AND r.survey_response_id IS NOT NULL AND NOT r.is_draft AND r.answers=p_answers THEN
    RETURN ai_latency_private.workflow_state(p_hash);
  END IF;
  IF s.disposition<>'active' THEN RAISE EXCEPTION 'Participation ended' USING ERRCODE='55000'; END IF;
  IF p.current_step<>'pre-survey' OR NOT p.consent THEN RAISE EXCEPTION 'Wrong step' USING ERRCODE='42501'; END IF;
  IF r.survey_response_id IS NOT NULL AND NOT r.is_draft THEN RAISE EXCEPTION 'Submitted response is locked' USING ERRCODE='55000'; END IF;
  IF NOT p_submit AND r.survey_response_id IS NOT NULL AND r.answers=p_answers THEN RETURN ai_latency_private.workflow_state(p_hash); END IF;
  old_revision=coalesce(r.revision,0);
  IF p_revision<>old_revision THEN RAISE EXCEPTION 'Stale response revision' USING ERRCODE='40001'; END IF;
  INSERT INTO ai_latency_private.survey_responses (participant_id,request_id,phase,questionnaire_version,answers,is_draft,revision,submitted_at)
  VALUES (s.participant_id,s.session_id,'pre','pre-draft-v1',p_answers,NOT p_submit,old_revision+1,CASE WHEN p_submit THEN now() END)
  ON CONFLICT (participant_id,phase) DO UPDATE SET answers=EXCLUDED.answers,is_draft=EXCLUDED.is_draft,
    revision=EXCLUDED.revision,submitted_at=EXCLUDED.submitted_at,updated_at=now();
  IF p_submit THEN
    UPDATE ai_latency_private.participant_steps SET completed_at=coalesce(completed_at,now()) WHERE participant_id=s.participant_id AND step='pre-survey';
    IF p_answers->>'aiExperience'='none' THEN
      UPDATE ai_latency_private.participants SET screening_status='failed',progress_status='ineligible',termination_reason='no_ai_experience',ended_at=now()
      WHERE participant_id=s.participant_id;
      UPDATE ai_latency_private.participant_sessions SET disposition='ineligible',terminated_at=now() WHERE session_id=s.session_id;
    ELSE
      UPDATE ai_latency_private.participants SET screening_status='passed',current_step='task-guide',progress_status='task_guide' WHERE participant_id=s.participant_id;
      INSERT INTO ai_latency_private.participant_steps (participant_id,step) VALUES (s.participant_id,'task-guide');
    END IF;
  END IF;
  RETURN ai_latency_private.workflow_state(p_hash);
END $$;

CREATE FUNCTION ai_latency_private.workflow_access(p_hash text,p_step text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash AND expires_at>now() AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
  IF s.disposition<>'active' THEN RAISE EXCEPTION 'Participation ended' USING ERRCODE='55000'; END IF;
  IF p_step='consent' THEN RETURN true; END IF;
  IF s.participant_id IS NULL OR NOT EXISTS (SELECT 1 FROM ai_latency_private.participants WHERE participant_id=s.participant_id AND consent) THEN
    RAISE EXCEPTION 'Consent required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ai_latency_private.participant_steps WHERE participant_id=s.participant_id AND step=p_step) THEN
    RAISE EXCEPTION 'Step unavailable' USING ERRCODE='42501';
  END IF;
  IF p_step IN ('task-guide','workspace','decision','post-survey','debriefing') AND NOT EXISTS (
    SELECT 1 FROM ai_latency_private.survey_responses r JOIN ai_latency_private.participants p USING(participant_id)
    WHERE r.participant_id=s.participant_id AND r.phase='pre' AND NOT r.is_draft AND p.screening_status='passed'
  ) THEN RAISE EXCEPTION 'Pre survey required' USING ERRCODE='42501'; END IF;
  IF p_step IN ('workspace','decision','post-survey','debriefing') AND NOT EXISTS (
    SELECT 1 FROM ai_latency_private.participant_steps WHERE participant_id=s.participant_id AND step='task-guide' AND completed_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'Task acknowledgment required' USING ERRCODE='42501'; END IF;
  RETURN true;
END $$;

CREATE FUNCTION ai_latency_private.workflow_navigate(p_hash text,p_step text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash AND expires_at>now() AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
  PERFORM ai_latency_private.workflow_access(p_hash,p_step);
  IF s.participant_id IS NOT NULL THEN UPDATE ai_latency_private.participants SET current_step=p_step WHERE participant_id=s.participant_id; END IF;
  RETURN ai_latency_private.workflow_state(p_hash);
END $$;

CREATE FUNCTION ai_latency_private.workflow_complete_task(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE;
DECLARE p ai_latency_private.participants%ROWTYPE;
BEGIN
  SELECT * INTO s FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash AND expires_at>now() AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
  PERFORM ai_latency_private.workflow_access(p_hash,'task-guide');
  SELECT * INTO p FROM ai_latency_private.participants WHERE participant_id=s.participant_id FOR UPDATE;
  IF p.current_step NOT IN ('task-guide','workspace') THEN RAISE EXCEPTION 'Wrong step' USING ERRCODE='42501'; END IF;
  UPDATE ai_latency_private.participant_steps SET completed_at=coalesce(completed_at,now()) WHERE participant_id=s.participant_id AND step='task-guide';
  UPDATE ai_latency_private.participants SET current_step='workspace',progress_status='workspace',task_guide_version='task-guide-draft-v1' WHERE participant_id=s.participant_id;
  INSERT INTO ai_latency_private.participant_steps (participant_id,step) VALUES (s.participant_id,'workspace') ON CONFLICT DO NOTHING;
  RETURN ai_latency_private.workflow_state(p_hash);
END $$;

DO $$ DECLARE signature text; DECLARE role_name text; BEGIN
  FOREACH signature IN ARRAY ARRAY['workflow_state(text)','enrollment_register(text,text,text)','workflow_terminate(text,text)',
    'workflow_save_pre(text,jsonb,boolean,integer)','workflow_access(text,text)','workflow_navigate(text,text)','workflow_complete_task(text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ai_latency_private.'||signature||' TO ai_latency_app';
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM '||quote_ident(role_name);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ai_latency_private.participant_steps FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
ALTER TABLE ai_latency_private.deployment_context DROP CONSTRAINT deployment_context_schema_version_check;
ALTER TABLE ai_latency_private.deployment_context ALTER COLUMN schema_version SET DEFAULT 3;
UPDATE ai_latency_private.deployment_context SET schema_version=3;
ALTER TABLE ai_latency_private.deployment_context ADD CHECK (schema_version=3);
COMMIT;
