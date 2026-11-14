BEGIN;
CREATE TABLE ai_latency_private.research_tasks(
 task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 participant_id uuid NOT NULL UNIQUE REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
 task_version text NOT NULL DEFAULT 'equipment-selection-draft-v1',
 started_at timestamptz, submitted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(participant_id,task_id)
);
CREATE TABLE ai_latency_private.research_events(
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 participant_id uuid NOT NULL REFERENCES ai_latency_private.participants ON DELETE RESTRICT,
 task_id uuid NOT NULL,
 condition_code text CHECK(condition_code IN('A','B','C')),
 event_type text NOT NULL,
 timestamp timestamptz NOT NULL,
 server_timestamp timestamptz NOT NULL DEFAULT clock_timestamp(),
 browser_timestamp timestamptz,
 page_id uuid, performance_ms double precision, performance_time_origin double precision,
 origin text NOT NULL CHECK(origin IN('server','browser','legacy')),
 timestamp_source text NOT NULL CHECK(timestamp_source IN('server','browser_reported','legacy_mixed')),
 late_after_end boolean NOT NULL DEFAULT false,
 related_type text, related_id uuid,
 payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(payload)='object'),
 dedup_key text,
 FOREIGN KEY(participant_id,task_id) REFERENCES ai_latency_private.research_tasks(participant_id,task_id),
 UNIQUE(participant_id,dedup_key),
 CHECK(origin='legacy' OR condition_code IS NOT NULL),
 CHECK(performance_ms IS NULL OR (performance_ms>=0 AND performance_ms<1e12)),
 CHECK(performance_time_origin IS NULL OR (performance_time_origin>0 AND performance_time_origin<1e15))
);
CREATE INDEX research_events_task_time_idx ON ai_latency_private.research_events(task_id,timestamp);
CREATE INDEX research_events_participant_type_idx ON ai_latency_private.research_events(participant_id,event_type,timestamp);
CREATE INDEX research_events_relation_idx ON ai_latency_private.research_events(participant_id,related_type,related_id);
CREATE INDEX research_events_page_perf_idx ON ai_latency_private.research_events(task_id,page_id,performance_ms);
DO $$ DECLARE tab text; DECLARE rol text; BEGIN
 FOREACH tab IN ARRAY ARRAY['research_tasks','research_events'] LOOP
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
CREATE POLICY analysis_owner ON ai_latency_private.final_decisions FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);
CREATE POLICY analysis_owner ON ai_latency_private.behavior_events FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);

CREATE FUNCTION ai_latency_private.research_task(p_pid uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result uuid; DECLARE started timestamptz;
BEGIN
 SELECT started_at INTO started FROM ai_latency_private.participant_steps WHERE participant_id=p_pid AND step='workspace';
 INSERT INTO ai_latency_private.research_tasks(participant_id,started_at) VALUES(p_pid,started)
 ON CONFLICT(participant_id) DO UPDATE SET started_at=coalesce(ai_latency_private.research_tasks.started_at,excluded.started_at)
 RETURNING task_id INTO result;
 RETURN result;
END $$;

CREATE FUNCTION ai_latency_private.research_emit(p_pid uuid,p_type text,p_related_type text,p_related_id uuid,p_at timestamptz,p_browser timestamptz,p_payload jsonb,p_origin text DEFAULT 'server') RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_at IS NULL THEN RETURN; END IF;
 INSERT INTO ai_latency_private.research_events(participant_id,task_id,condition_code,event_type,timestamp,browser_timestamp,origin,timestamp_source,related_type,related_id,payload,dedup_key)
 SELECT p_pid,ai_latency_private.research_task(p_pid),p.condition_code,p_type,p_at,p_browser,p_origin,
 CASE WHEN p_origin='legacy' THEN 'legacy_mixed' WHEN p_type IN('ai_first_character','ai_output_completed','source_access') THEN 'browser_reported' ELSE 'server' END,
 p_related_type,p_related_id,p_payload,p_type||':'||p_related_id::text
 FROM ai_latency_private.participants p WHERE p.participant_id=p_pid
 ON CONFLICT(participant_id,dedup_key) DO NOTHING;
END $$;

CREATE FUNCTION ai_latency_private.research_capture(p_table text,p_row jsonb,p_origin text DEFAULT 'server') RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid; DECLARE rid uuid; DECLARE tid uuid; DECLARE info jsonb;
BEGIN
 pid=(p_row->>'participant_id')::uuid;
 IF p_table='participant_steps' THEN
  IF p_row->>'step'='workspace' THEN
   rid=ai_latency_private.research_task(pid);
   PERFORM ai_latency_private.research_emit(pid,'task_started','task',rid,(p_row->>'started_at')::timestamptz,null,'{}',p_origin);
  END IF;
 ELSIF p_table='chat_timings' THEN
  rid=(p_row->>'attempt_id')::uuid;
  info=jsonb_build_object('request_id',p_row->>'request_id');
  PERFORM ai_latency_private.research_emit(pid,'question_received','chat_attempt',rid,(p_row->>'server_received_at')::timestamptz,(p_row->>'client_submitted_at')::timestamptz,info,p_origin);
  PERFORM ai_latency_private.research_emit(pid,'ai_response_ready','chat_attempt',rid,(p_row->>'response_ready_at')::timestamptz,null,info,p_origin);
  PERFORM ai_latency_private.research_emit(pid,'ai_first_character','chat_attempt',rid,(p_row->>'first_character_at')::timestamptz,(p_row->>'first_character_at')::timestamptz,info,p_origin);
  PERFORM ai_latency_private.research_emit(pid,'ai_output_completed','chat_attempt',rid,(p_row->>'output_completed_at')::timestamptz,(p_row->>'output_completed_at')::timestamptz,info,p_origin);
 ELSIF p_table='search_events' THEN
  rid=(p_row->>'search_event_id')::uuid;
  info=jsonb_build_object('request_id',p_row->>'request_id','query',p_row->>'query','status',p_row->>'status');
  PERFORM ai_latency_private.research_emit(pid,'search_executed','search_event',rid,(p_row->>'executed_at')::timestamptz,(p_row->>'client_submitted_at')::timestamptz,info,p_origin);
  PERFORM ai_latency_private.research_emit(pid,'search_api_requested','search_event',rid,(p_row->>'provider_requested_at')::timestamptz,null,info,p_origin);
  PERFORM ai_latency_private.research_emit(pid,CASE WHEN p_row->>'status'='completed' THEN 'search_completed' ELSE 'search_failed' END,'search_event',rid,(p_row->>'completed_at')::timestamptz,null,info,p_origin);
 ELSIF p_table='source_events' THEN
  rid=(p_row->>'request_id')::uuid;
  info=jsonb_build_object('source_event_id',p_row->>'source_event_id','search_event_id',p_row->>'search_event_id','url',p_row->>'source_url','rank',p_row->'result_rank');
  PERFORM ai_latency_private.research_emit(pid,'source_access','source_click',rid,(p_row->>'accessed_at')::timestamptz,(p_row->>'accessed_at')::timestamptz,info,p_origin);
  -- 클릭 전송이 늦어 복귀 이벤트가 먼저 도착했어도 연결한다.
  UPDATE ai_latency_private.source_events s SET returned_at=e.browser_timestamp
   FROM ai_latency_private.research_events e WHERE s.participant_id=pid AND s.request_id=rid AND s.returned_at IS NULL
    AND e.participant_id=pid AND e.related_id=rid AND e.event_type='source_return' AND e.browser_timestamp>=s.accessed_at;
 ELSIF p_table='final_decisions' THEN
  rid=(p_row->>'final_decision_id')::uuid;
  tid=ai_latency_private.research_task(pid);
  UPDATE ai_latency_private.research_tasks SET submitted_at=(p_row->>'submitted_at')::timestamptz WHERE task_id=tid;
  PERFORM ai_latency_private.research_emit(pid,'final_submitted','final_decision',rid,(p_row->>'submitted_at')::timestamptz,null,'{}',p_origin);
 END IF;
END $$;

CREATE FUNCTION ai_latency_private.research_capture_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM ai_latency_private.research_capture(TG_TABLE_NAME,to_jsonb(NEW)); RETURN NEW;
END $$;
CREATE TRIGGER analysis_step AFTER INSERT ON ai_latency_private.participant_steps FOR EACH ROW EXECUTE FUNCTION ai_latency_private.research_capture_trigger();
CREATE TRIGGER analysis_chat AFTER INSERT OR UPDATE ON ai_latency_private.chat_timings FOR EACH ROW EXECUTE FUNCTION ai_latency_private.research_capture_trigger();
CREATE TRIGGER analysis_search AFTER INSERT OR UPDATE ON ai_latency_private.search_events FOR EACH ROW EXECUTE FUNCTION ai_latency_private.research_capture_trigger();
CREATE TRIGGER analysis_source AFTER INSERT ON ai_latency_private.source_events FOR EACH ROW EXECUTE FUNCTION ai_latency_private.research_capture_trigger();
CREATE TRIGGER analysis_final AFTER INSERT ON ai_latency_private.final_decisions FOR EACH ROW EXECUTE FUNCTION ai_latency_private.research_capture_trigger();

CREATE FUNCTION ai_latency_private.research_context(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE; DECLARE task ai_latency_private.research_tasks%ROWTYPE;
BEGIN
 SELECT * INTO s FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash AND expires_at>clock_timestamp() AND revoked_at IS NULL;
 IF NOT FOUND OR s.participant_id IS NULL THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
 SELECT * INTO task FROM ai_latency_private.research_tasks WHERE participant_id=s.participant_id;
 RETURN jsonb_build_object('task_id',task.task_id,'active',s.disposition='active' AND task.started_at IS NOT NULL,'server_time',clock_timestamp());
END $$;

CREATE FUNCTION ai_latency_private.research_ingest(p_hash text,p_events jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ai_latency_private.participant_sessions%ROWTYPE; DECLARE task ai_latency_private.research_tasks%ROWTYPE;
DECLARE item jsonb; DECLARE old ai_latency_private.research_events%ROWTYPE; DECLARE eid uuid; DECLARE stamp timestamptz; DECLARE cond text;
BEGIN
 SELECT * INTO s FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash AND expires_at>clock_timestamp() AND revoked_at IS NULL FOR UPDATE;
 IF NOT FOUND OR s.participant_id IS NULL THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE='28000'; END IF;
 SELECT * INTO task FROM ai_latency_private.research_tasks WHERE participant_id=s.participant_id;
 SELECT condition_code INTO cond FROM ai_latency_private.participants WHERE participant_id=s.participant_id;
 IF task.started_at IS NULL OR cond IS NULL THEN RAISE EXCEPTION 'Task unavailable' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_events)<>'array' OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Invalid events' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
  eid=(item->>'event_id')::uuid; stamp=(item->>'browser_timestamp')::timestamptz;
  IF (item->>'task_id')::uuid IS DISTINCT FROM task.task_id OR stamp IS NULL OR
    item->>'type' NOT IN('question_sent','ai_first_character_observed','ai_output_completed_observed','search_submitted','search_results_presented','search_activity_start','search_activity_end','source_click','source_left','source_return','tab_hidden','tab_visible','window_blur','window_focus','offline','online','transport_failed','transport_restored','page_exit','page_start','heartbeat') THEN
    RAISE EXCEPTION 'Invalid event' USING ERRCODE='22023'; END IF;
  SELECT * INTO old FROM ai_latency_private.research_events WHERE event_id=eid;
  IF FOUND THEN
   IF old.participant_id IS DISTINCT FROM s.participant_id OR old.event_type IS DISTINCT FROM item->>'type' OR old.browser_timestamp IS DISTINCT FROM stamp OR old.page_id IS DISTINCT FROM (item->>'page_id')::uuid OR old.performance_ms IS DISTINCT FROM (item->>'performance_ms')::float8 OR old.performance_time_origin IS DISTINCT FROM (item->>'performance_time_origin')::float8 OR old.related_id IS DISTINCT FROM (item->>'related_id')::uuid OR old.related_type IS DISTINCT FROM item->>'related_type' OR old.payload IS DISTINCT FROM item->'payload' THEN
    RAISE EXCEPTION 'Event conflict' USING ERRCODE='22023'; END IF;
   CONTINUE;
  END IF;
  -- 서로 다른 시계를 비교해 재전송을 버리지 않는다. 종료 후 도착은 별도 표시한다.
  INSERT INTO ai_latency_private.research_events(event_id,participant_id,task_id,condition_code,event_type,timestamp,browser_timestamp,page_id,performance_ms,performance_time_origin,origin,timestamp_source,late_after_end,related_type,related_id,payload)
  VALUES(eid,s.participant_id,task.task_id,cond,item->>'type',stamp,stamp,(item->>'page_id')::uuid,(item->>'performance_ms')::float8,(item->>'performance_time_origin')::float8,'browser','browser_reported',s.disposition<>'active',item->>'related_type',(item->>'related_id')::uuid,item->'payload');
  IF item->>'type'='source_return' THEN
   UPDATE ai_latency_private.source_events SET returned_at=stamp WHERE participant_id=s.participant_id AND request_id=(item->>'related_id')::uuid AND returned_at IS NULL AND stamp>=accessed_at AND s.disposition='active';
  END IF;
 END LOOP;
 RETURN jsonb_build_object('acknowledged',(SELECT jsonb_agg(value->'event_id') FROM jsonb_array_elements(p_events)));
END $$;

-- 과거 기록은 삭제·수정하지 않고 원래 시각을 가진 legacy 사본만 추가한다.
DO $$ DECLARE tab text; DECLARE row_data jsonb; BEGIN
 FOREACH tab IN ARRAY ARRAY['participant_steps','chat_timings','search_events','source_events','final_decisions'] LOOP
  FOR row_data IN EXECUTE format('SELECT to_jsonb(t) FROM ai_latency_private.%I t',tab) LOOP
   PERFORM ai_latency_private.research_capture(tab,row_data,'legacy');
  END LOOP;
 END LOOP;
 INSERT INTO ai_latency_private.research_events(event_id,participant_id,task_id,condition_code,event_type,timestamp,origin,timestamp_source,payload,dedup_key)
 SELECT b.behavior_event_id,b.participant_id,ai_latency_private.research_task(b.participant_id),p.condition_code,b.event_type,b.occurred_at,'legacy','legacy_mixed',b.payload,'legacy:'||b.behavior_event_id::text
 FROM ai_latency_private.behavior_events b JOIN ai_latency_private.participants p USING(participant_id) ON CONFLICT DO NOTHING;
END $$;

CREATE VIEW ai_latency_private.research_task_summary WITH(security_invoker=true) AS
 SELECT t.task_id,t.participant_id,p.condition_code,t.started_at,t.submitted_at,
 CASE WHEN t.submitted_at>=t.started_at THEN extract(epoch FROM(t.submitted_at-t.started_at))*1000 END AS total_task_ms,
 (SELECT count(*) FROM ai_latency_private.search_events s WHERE s.participant_id=t.participant_id) AS search_attempt_count,
 (SELECT count(*) FROM ai_latency_private.search_events s WHERE s.participant_id=t.participant_id AND s.provider_requested_at IS NOT NULL) AS search_api_count,
 (SELECT count(*) FROM ai_latency_private.source_events s WHERE s.participant_id=t.participant_id) AS source_click_count,
 (SELECT count(DISTINCT source_url) FROM ai_latency_private.source_events s WHERE s.participant_id=t.participant_id) AS distinct_source_url_count
 FROM ai_latency_private.research_tasks t JOIN ai_latency_private.participants p USING(participant_id);
REVOKE ALL ON ai_latency_private.research_task_summary FROM PUBLIC,ai_latency_app;
GRANT SELECT ON ai_latency_private.research_task_summary TO ai_latency_admin;

DO $$ DECLARE signature text; DECLARE rol text; BEGIN
 FOREACH signature IN ARRAY ARRAY['research_task(uuid)','research_emit(uuid,text,text,uuid,timestamptz,timestamptz,jsonb,text)','research_capture(text,jsonb,text)','research_capture_trigger()','research_context(text)','research_ingest(text,jsonb)'] LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM PUBLIC';
  IF signature IN('research_context(text)','research_ingest(text,jsonb)') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION ai_latency_private.'||signature||' TO ai_latency_app'; END IF;
  FOREACH rol IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=rol) THEN EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM '||quote_ident(rol); END IF;
  END LOOP;
 END LOOP;
END $$;
ALTER TABLE ai_latency_private.deployment_context DROP CONSTRAINT deployment_context_schema_version_check;
ALTER TABLE ai_latency_private.deployment_context ALTER COLUMN schema_version SET DEFAULT 8;
UPDATE ai_latency_private.deployment_context SET schema_version=8;
ALTER TABLE ai_latency_private.deployment_context ADD CHECK(schema_version=8);
COMMIT;
