BEGIN;
ALTER TABLE ai_latency_private.final_decisions
 ADD COLUMN coding_revision integer NOT NULL DEFAULT 0 CHECK(coding_revision>=0),
 ADD COLUMN adjudication_notes text NOT NULL DEFAULT '' CHECK(length(adjudication_notes)<=2000);
CREATE OR REPLACE FUNCTION ai_latency_private.lock_final_answer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Final answer locked' USING ERRCODE='55000'; END IF;
 IF (to_jsonb(NEW)-ARRAY['misinformation_acceptance','assessed_at','assessed_by','coding_revision','adjudication_notes']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['misinformation_acceptance','assessed_at','assessed_by','coding_revision','adjudication_notes']) THEN
  RAISE EXCEPTION 'Final answer locked' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TABLE ai_latency_private.final_decision_codings (
 request_id uuid PRIMARY KEY,
 participant_id uuid NOT NULL REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
 final_decision_id uuid NOT NULL REFERENCES ai_latency_private.final_decisions ON DELETE RESTRICT,
 previous_code text NOT NULL, code text NOT NULL CHECK(code IN('not_assessed','accepted','rejected','unclear')),
 notes text NOT NULL CHECK(length(notes)<=2000), researcher text NOT NULL CHECK(length(researcher) BETWEEN 1 AND 100),
 revision integer NOT NULL, coded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(participant_id,revision)
);
CREATE INDEX final_decision_codings_participant_time ON ai_latency_private.final_decision_codings(participant_id,coded_at);
ALTER TABLE ai_latency_private.final_decision_codings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_latency_private.final_decision_codings FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_all ON ai_latency_private.final_decision_codings FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);
CREATE POLICY admin_read ON ai_latency_private.final_decision_codings FOR SELECT TO ai_latency_admin USING(true);
REVOKE ALL ON ai_latency_private.final_decision_codings FROM PUBLIC,ai_latency_app;
GRANT SELECT ON ai_latency_private.final_decision_codings TO ai_latency_admin;

CREATE FUNCTION ai_latency_private.admin_code_final(p_pid uuid,p_code text,p_notes text,p_revision integer,p_actor text,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d ai_latency_private.final_decisions%ROWTYPE; a ai_latency_private.final_decision_codings%ROWTYPE; t timestamptz=clock_timestamp();
BEGIN
 IF p_code IS NULL OR p_code NOT IN('not_assessed','accepted','rejected','unclear') OR p_notes IS NULL OR length(p_notes)>2000
 OR p_revision IS NULL OR p_revision<0 OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 100 OR p_request IS NULL THEN
  RAISE EXCEPTION 'Invalid coding' USING ERRCODE='22023'; END IF;
 SELECT * INTO d FROM ai_latency_private.final_decisions WHERE participant_id=p_pid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Final answer not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO a FROM ai_latency_private.final_decision_codings WHERE request_id=p_request;
 IF FOUND THEN
  IF a.participant_id<>p_pid OR a.code<>p_code OR a.notes<>p_notes OR a.researcher<>p_actor OR a.revision<>p_revision+1 THEN
   RAISE EXCEPTION 'Conflicting retry' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('recorded',true,'revision',a.revision,'coded_at',a.coded_at);
 END IF;
 IF d.coding_revision<>p_revision THEN RAISE EXCEPTION 'Stale coding' USING ERRCODE='40001'; END IF;
 UPDATE ai_latency_private.final_decisions SET misinformation_acceptance=p_code,adjudication_notes=p_notes,
  assessed_at=t,assessed_by=p_actor,coding_revision=p_revision+1 WHERE participant_id=p_pid;
 INSERT INTO ai_latency_private.final_decision_codings(request_id,participant_id,final_decision_id,previous_code,code,notes,researcher,revision,coded_at)
 VALUES(p_request,p_pid,d.final_decision_id,d.misinformation_acceptance,p_code,p_notes,p_actor,p_revision+1,t);
 RETURN jsonb_build_object('recorded',true,'revision',p_revision+1,'coded_at',t);
END $$;
REVOKE ALL ON FUNCTION ai_latency_private.admin_code_final(uuid,text,text,integer,text,uuid) FROM PUBLIC,ai_latency_app;
GRANT EXECUTE ON FUNCTION ai_latency_private.admin_code_final(uuid,text,text,integer,text,uuid) TO ai_latency_admin;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON ai_latency_private.final_decision_codings FROM %I',r);
   EXECUTE format('REVOKE ALL ON FUNCTION ai_latency_private.admin_code_final(uuid,text,text,integer,text,uuid) FROM %I',r);
  END IF;
 END LOOP;
END $$;
ALTER TABLE ai_latency_private.deployment_context DROP CONSTRAINT deployment_context_schema_version_check;
ALTER TABLE ai_latency_private.deployment_context ALTER COLUMN schema_version SET DEFAULT 10;
UPDATE ai_latency_private.deployment_context SET schema_version=10;
ALTER TABLE ai_latency_private.deployment_context ADD CHECK(schema_version=10);
COMMIT;
