BEGIN;
ALTER TABLE ai_latency_private.final_decisions
 ADD COLUMN key_specifications text CHECK(length(key_specifications) BETWEEN 1 AND 10000),
 ADD COLUMN misinformation_acceptance text NOT NULL DEFAULT 'not_assessed'
 CHECK(misinformation_acceptance IN ('not_assessed','accepted','rejected','unclear')),
 ADD COLUMN assessed_at timestamptz,
 ADD COLUMN assessed_by text;
ALTER TABLE ai_latency_private.participants ADD COLUMN debriefing_version text, ADD COLUMN debriefing_snapshot jsonb;

-- Submitted participant answers are immutable, including privileged accidental edits.
-- Researcher adjudication is separate and never returned by participant functions.
CREATE FUNCTION ai_latency_private.lock_final_answer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Final answer locked' USING ERRCODE='55000'; END IF;
 IF (to_jsonb(NEW)-ARRAY['misinformation_acceptance','assessed_at','assessed_by']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['misinformation_acceptance','assessed_at','assessed_by']) THEN
  RAISE EXCEPTION 'Final answer locked' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lock_final_answer BEFORE UPDATE OR DELETE ON ai_latency_private.final_decisions
 FOR EACH ROW EXECUTE FUNCTION ai_latency_private.lock_final_answer();
DROP TRIGGER require_participant_consent ON ai_latency_private.final_decisions;
CREATE TRIGGER require_participant_consent BEFORE INSERT ON ai_latency_private.final_decisions
 FOR EACH ROW EXECUTE FUNCTION ai_latency_private.require_consent();

ALTER FUNCTION ai_latency_private.workflow_state(text) RENAME TO workflow_state_v3;
REVOKE ALL ON FUNCTION ai_latency_private.workflow_state_v3(text) FROM PUBLIC,ai_latency_app;
CREATE FUNCTION ai_latency_private.workflow_state(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; pid uuid; decision jsonb; post jsonb; status text;
BEGIN
 result=ai_latency_private.workflow_state_v3(p_hash); pid=(result->>'participant_id')::uuid;
 SELECT jsonb_build_object('product',product_code,'specifications',key_specifications,'rationale',rationale,
  'references',reference_notes,'submitted_at',submitted_at) INTO decision
 FROM ai_latency_private.final_decisions WHERE participant_id=pid;
 SELECT jsonb_build_object('answers',answers,'submitted_at',submitted_at,'version',questionnaire_version)
 INTO post FROM ai_latency_private.survey_responses WHERE participant_id=pid AND phase='post';
 SELECT progress_status INTO status FROM ai_latency_private.participants WHERE participant_id=pid;
 RETURN result||jsonb_build_object('final_decision',decision,'post_survey',post,'completed',status='completed',
  'debriefing',CASE WHEN result->>'current_step'='debriefing' THEN (SELECT debriefing_snapshot FROM ai_latency_private.participants WHERE participant_id=pid) ELSE NULL END);
END $$;

-- One session-row lock serializes progression and duplicate submissions across tabs.
CREATE FUNCTION ai_latency_private.workflow_final(p_hash text,p_action text,p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE;
 p ai_latency_private.participants%ROWTYPE; d ai_latency_private.final_decisions%ROWTYPE;
 r ai_latency_private.survey_responses%ROWTYPE; t timestamptz=clock_timestamp();
BEGIN
 SELECT * INTO s FROM ai_latency_private.participant_sessions
 WHERE token_hash=p_hash AND expires_at>now() AND revoked_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
 IF s.disposition<>'active' OR s.participant_id IS NULL THEN RAISE EXCEPTION 'Participation unavailable' USING ERRCODE='55000'; END IF;
 SELECT * INTO p FROM ai_latency_private.participants WHERE participant_id=s.participant_id FOR UPDATE;
 SELECT * INTO d FROM ai_latency_private.final_decisions WHERE participant_id=s.participant_id;
 IF p_action='decision' AND d.final_decision_id IS NOT NULL THEN
  IF d.product_code=p_data->>'product' AND d.key_specifications=p_data->>'specifications'
   AND d.rationale=p_data->>'rationale' AND coalesce(d.reference_notes,'')=coalesce(p_data->>'references','') THEN
   RETURN ai_latency_private.workflow_state(p_hash);
  END IF;
  RAISE EXCEPTION 'Submitted answer locked' USING ERRCODE='55000';
 END IF;
 SELECT * INTO r FROM ai_latency_private.survey_responses WHERE participant_id=s.participant_id AND phase='post';
 IF p_action='post' AND r.survey_response_id IS NOT NULL THEN
  IF r.answers=p_data->'answers' THEN RETURN ai_latency_private.workflow_state(p_hash); END IF;
  RAISE EXCEPTION 'Submitted survey locked' USING ERRCODE='55000';
 END IF;
 IF p_action='finish' AND p.progress_status='completed' THEN RETURN ai_latency_private.workflow_state(p_hash); END IF;
 IF p.progress_status='completed' THEN RAISE EXCEPTION 'Completed' USING ERRCODE='55000'; END IF;
 IF p_action='open' THEN
  IF p.current_step='decision' AND d.final_decision_id IS NULL THEN RETURN ai_latency_private.workflow_state(p_hash); END IF;
  IF p.current_step<>'workspace' OR d.final_decision_id IS NOT NULL THEN RAISE EXCEPTION 'Wrong step' USING ERRCODE='42501'; END IF;
  PERFORM ai_latency_private.workflow_access(p_hash,'workspace');
  IF EXISTS(SELECT 1 FROM ai_latency_private.chat_requests WHERE participant_id=s.participant_id AND status='pending' AND lease_expires_at>now())
   OR EXISTS(SELECT 1 FROM ai_latency_private.search_events WHERE participant_id=s.participant_id AND status='pending' AND lease_expires_at>now()) THEN
   RAISE EXCEPTION 'Request in progress' USING ERRCODE='55000';
  END IF;
  UPDATE ai_latency_private.participant_steps SET completed_at=coalesce(completed_at,t) WHERE participant_id=s.participant_id AND step='workspace';
  INSERT INTO ai_latency_private.participant_steps(participant_id,step,started_at) VALUES(s.participant_id,'decision',t) ON CONFLICT DO NOTHING;
  UPDATE ai_latency_private.participants SET current_step='decision',progress_status='final_decision' WHERE participant_id=s.participant_id;
 ELSIF p_action='decision' THEN
  IF p.current_step<>'decision' THEN RAISE EXCEPTION 'Wrong step' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_data)<>'object' OR coalesce(length(btrim(p_data->>'product')),0) NOT BETWEEN 1 AND 100
   OR coalesce(length(btrim(p_data->>'specifications')),0) NOT BETWEEN 1 AND 10000
   OR coalesce(length(btrim(p_data->>'rationale')),0) NOT BETWEEN 1 AND 10000
   OR length(coalesce(p_data->>'references',''))>10000 THEN RAISE EXCEPTION 'Invalid answer' USING ERRCODE='22023'; END IF;
  INSERT INTO ai_latency_private.final_decisions(participant_id,request_id,product_code,key_specifications,rationale,reference_notes,submitted_at)
   VALUES(s.participant_id,(p_data->>'request_id')::uuid,p_data->>'product',p_data->>'specifications',p_data->>'rationale',coalesce(p_data->>'references',''),t);
  UPDATE ai_latency_private.participant_steps SET completed_at=t WHERE participant_id=s.participant_id AND step='decision';
  INSERT INTO ai_latency_private.participant_steps(participant_id,step,started_at) VALUES(s.participant_id,'post-survey',t);
  UPDATE ai_latency_private.participants SET current_step='post-survey',progress_status='post_survey' WHERE participant_id=s.participant_id;
 ELSIF p_action='post' THEN
  IF p.current_step<>'post-survey' OR d.final_decision_id IS NULL THEN RAISE EXCEPTION 'Wrong step' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_data->'answers')<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_data->'answers'))<>4
   OR NOT(coalesce(p_data->'answers'->>'perceivedDelay','') IN ('1','2','3','4','5'))
   OR NOT(coalesce(p_data->'answers'->>'naturalness','') IN ('1','2','3','4','5'))
   OR NOT(coalesce(p_data->'answers'->>'suspectedDelay','') IN ('yes','no','unsure'))
   OR NOT(coalesce(p_data->'answers'->>'suspectedPrewritten','') IN ('yes','no','unsure')) THEN RAISE EXCEPTION 'Invalid survey' USING ERRCODE='22023'; END IF;
  INSERT INTO ai_latency_private.survey_responses(participant_id,request_id,phase,questionnaire_version,answers,is_draft,submitted_at)
   VALUES(s.participant_id,(p_data->>'request_id')::uuid,'post',p_data->>'survey_version',p_data->'answers',false,t);
  UPDATE ai_latency_private.participant_steps SET completed_at=t WHERE participant_id=s.participant_id AND step='post-survey';
  INSERT INTO ai_latency_private.participant_steps(participant_id,step,started_at) VALUES(s.participant_id,'debriefing',t);
  UPDATE ai_latency_private.participants SET current_step='debriefing',debriefing_version=p_data->>'debriefing_version',debriefing_snapshot=p_data->'debriefing' WHERE participant_id=s.participant_id;
 ELSIF p_action='finish' THEN
  IF p.current_step<>'debriefing' OR r.survey_response_id IS NULL THEN RAISE EXCEPTION 'Wrong step' USING ERRCODE='42501'; END IF;
  UPDATE ai_latency_private.participant_steps SET completed_at=t WHERE participant_id=s.participant_id AND step='debriefing';
  UPDATE ai_latency_private.participants SET progress_status='completed',ended_at=t WHERE participant_id=s.participant_id;
 ELSE RAISE EXCEPTION 'Invalid action' USING ERRCODE='22023'; END IF;
 RETURN ai_latency_private.workflow_state(p_hash);
END $$;

-- Reviewed answers remain accessible; finalized participants cannot re-enter work.
ALTER FUNCTION ai_latency_private.workflow_access(text,text) RENAME TO workflow_access_v3;
REVOKE ALL ON FUNCTION ai_latency_private.workflow_access_v3(text,text) FROM PUBLIC,ai_latency_app;
CREATE FUNCTION ai_latency_private.workflow_access(p_hash text,p_step text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid;
BEGIN
 PERFORM ai_latency_private.workflow_access_v3(p_hash,p_step);
 SELECT participant_id INTO pid FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash;
 IF EXISTS(SELECT 1 FROM ai_latency_private.final_decisions WHERE participant_id=pid)
  AND p_step NOT IN ('decision','post-survey','debriefing') THEN RAISE EXCEPTION 'Task submitted' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM ai_latency_private.participants WHERE participant_id=pid AND progress_status='completed')
  AND p_step<>'debriefing' THEN RAISE EXCEPTION 'Completed' USING ERRCODE='42501'; END IF;
 RETURN true;
END $$;
ALTER FUNCTION ai_latency_private.workflow_terminate(text,text) RENAME TO workflow_terminate_v3;
REVOKE ALL ON FUNCTION ai_latency_private.workflow_terminate_v3(text,text) FROM PUBLIC,ai_latency_app;
CREATE FUNCTION ai_latency_private.workflow_terminate(p_hash text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM 1 FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash FOR UPDATE;
 IF EXISTS(SELECT 1 FROM ai_latency_private.participants p JOIN ai_latency_private.participant_sessions s USING(participant_id)
  WHERE s.token_hash=p_hash AND p.progress_status='completed') THEN RAISE EXCEPTION 'Completed' USING ERRCODE='55000'; END IF;
 RETURN ai_latency_private.workflow_terminate_v3(p_hash,p_reason);
END $$;
CREATE OR REPLACE FUNCTION ai_latency_private.workflow_navigate(p_hash text,p_step text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE;
BEGIN
 SELECT * INTO s FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash AND expires_at>now() AND revoked_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
 PERFORM ai_latency_private.workflow_access(p_hash,p_step);
 IF EXISTS(SELECT 1 FROM ai_latency_private.final_decisions WHERE participant_id=s.participant_id)
  AND p_step NOT IN ('decision','post-survey','debriefing') THEN RAISE EXCEPTION 'Task submitted' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM ai_latency_private.participants WHERE participant_id=s.participant_id AND progress_status='completed') THEN
  IF p_step<>'debriefing' THEN RAISE EXCEPTION 'Completed' USING ERRCODE='42501'; END IF;
 END IF;
 UPDATE ai_latency_private.participants SET current_step=p_step WHERE participant_id=s.participant_id;
 RETURN ai_latency_private.workflow_state(p_hash);
END $$;
REVOKE ALL ON FUNCTION ai_latency_private.lock_final_answer(),ai_latency_private.workflow_state(text),ai_latency_private.workflow_final(text,text,jsonb),ai_latency_private.workflow_access(text,text),ai_latency_private.workflow_terminate(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_latency_private.workflow_state(text),ai_latency_private.workflow_final(text,text,jsonb),ai_latency_private.workflow_access(text,text),ai_latency_private.workflow_terminate(text,text) TO ai_latency_app;
ALTER TABLE ai_latency_private.deployment_context DROP CONSTRAINT deployment_context_schema_version_check;
ALTER TABLE ai_latency_private.deployment_context ALTER COLUMN schema_version SET DEFAULT 9;
UPDATE ai_latency_private.deployment_context SET schema_version=9;
ALTER TABLE ai_latency_private.deployment_context ADD CHECK(schema_version=9);
COMMIT;
