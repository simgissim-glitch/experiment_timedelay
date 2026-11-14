BEGIN;
ALTER TABLE ai_latency_private.search_events
  ADD COLUMN status text NOT NULL DEFAULT 'completed' CHECK(status IN('pending','completed','failed')),
  ADD COLUMN results jsonb,
  ADD COLUMN provider text,
  ADD COLUMN policy jsonb,
  ADD COLUMN error_code text CHECK(error_code IN('SEARCH_NOT_CONFIGURED','SEARCH_RATE_LIMITED','SEARCH_TIMEOUT','SEARCH_UNAVAILABLE','SEARCH_INVALID_RESPONSE')),
  ADD COLUMN client_submitted_at timestamptz,
  ADD COLUMN provider_requested_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN lease_expires_at timestamptz,
  ADD CHECK(results IS NULL OR (jsonb_typeof(results)='array' AND jsonb_array_length(results)<=20));
ALTER TABLE ai_latency_private.source_events ADD COLUMN result_rank integer CHECK(result_rank BETWEEN 1 AND 20);
CREATE POLICY search_owner ON ai_latency_private.search_events FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);
CREATE POLICY source_owner ON ai_latency_private.source_events FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);

CREATE FUNCTION ai_latency_private.search_participant(p_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid;
BEGIN
  PERFORM ai_latency_private.workflow_access(p_hash,'workspace');
  SELECT s.participant_id INTO pid FROM ai_latency_private.participant_sessions s JOIN ai_latency_private.participants p USING(participant_id)
    WHERE s.token_hash=p_hash AND p.current_step='workspace';
  IF pid IS NULL THEN RAISE EXCEPTION 'Wrong step' USING ERRCODE='42501'; END IF;
  RETURN pid;
END $$;

CREATE FUNCTION ai_latency_private.search_state(p_hash text,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid; DECLARE e ai_latency_private.search_events%ROWTYPE;
BEGIN
  pid=ai_latency_private.search_participant(p_hash);
  SELECT * INTO e FROM ai_latency_private.search_events WHERE participant_id=pid AND (p_request IS NULL OR request_id=p_request)
    ORDER BY recorded_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('search_event_id',e.search_event_id,'request_id',e.request_id,'query',e.query,'executed_at',e.executed_at,
    'status',CASE WHEN (e.status='pending' AND e.lease_expires_at<=clock_timestamp()) OR (e.status='completed' AND e.results IS NULL) THEN 'failed' ELSE e.status END,
    'error_code',CASE WHEN e.status='pending' AND e.lease_expires_at<=clock_timestamp() THEN 'SEARCH_TIMEOUT' WHEN e.status='completed' AND e.results IS NULL THEN 'SEARCH_INVALID_RESPONSE' ELSE e.error_code END,
    'results',CASE WHEN e.status='completed' THEN coalesce(e.results,'[]'::jsonb) ELSE '[]'::jsonb END);
END $$;

CREATE FUNCTION ai_latency_private.search_claim(p_hash text,p_request uuid,p_query text,p_submitted timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid; DECLARE e ai_latency_private.search_events%ROWTYPE;
BEGIN
  PERFORM 1 FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash FOR UPDATE;
  pid=ai_latency_private.search_participant(p_hash);
  IF p_request IS NULL OR p_query IS NULL OR char_length(btrim(p_query)) NOT BETWEEN 1 AND 600 THEN RAISE EXCEPTION 'Invalid search' USING ERRCODE='22023'; END IF;
  SELECT * INTO e FROM ai_latency_private.search_events WHERE participant_id=pid AND request_id=p_request;
  IF FOUND THEN
    IF e.query IS DISTINCT FROM p_query THEN RETURN jsonb_build_object('execute',false,'error','SEARCH_REQUEST_CONFLICT'); END IF;
    RETURN jsonb_build_object('execute',false);
  END IF;
  PERFORM pg_advisory_xact_lock(811026,3);
  IF (SELECT count(*) FROM ai_latency_private.search_events WHERE participant_id=pid AND recorded_at>clock_timestamp()-interval '1 minute')>=10 OR
     (SELECT count(*) FROM ai_latency_private.search_events WHERE participant_id=pid)>=200 OR
     (SELECT count(*) FROM ai_latency_private.search_events WHERE recorded_at>clock_timestamp()-interval '1 minute')>=60 THEN
    RETURN jsonb_build_object('execute',false,'error','SEARCH_RATE_LIMITED'); END IF;
  INSERT INTO ai_latency_private.search_events(participant_id,request_id,query,status,client_submitted_at,lease_expires_at)
    VALUES(pid,p_request,p_query,'pending',p_submitted,clock_timestamp()+interval '45 seconds');
  RETURN jsonb_build_object('execute',true);
END $$;

CREATE FUNCTION ai_latency_private.search_requested(p_hash text,p_request uuid,p_provider text,p_policy jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid;
BEGIN
  pid=ai_latency_private.search_participant(p_hash);
  IF p_provider IS NULL OR char_length(p_provider)>100 OR jsonb_typeof(p_policy)<>'object' THEN RAISE EXCEPTION 'Invalid provider' USING ERRCODE='22023'; END IF;
  UPDATE ai_latency_private.search_events SET provider=p_provider,policy=p_policy,provider_requested_at=clock_timestamp()
    WHERE participant_id=pid AND request_id=p_request AND status='pending' AND provider_requested_at IS NULL;
  RETURN FOUND;
END $$;

CREATE FUNCTION ai_latency_private.search_finish(p_hash text,p_request uuid,p_results jsonb,p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid;
BEGIN
  PERFORM 1 FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash FOR UPDATE;
  pid=ai_latency_private.search_participant(p_hash);
  IF p_error IS NULL AND (p_results IS NULL OR jsonb_typeof(p_results)<>'array' OR jsonb_array_length(p_results)>20) THEN
    RAISE EXCEPTION 'Invalid results' USING ERRCODE='22023'; END IF;
  UPDATE ai_latency_private.search_events SET status=CASE WHEN p_error IS NULL THEN 'completed' ELSE 'failed' END,
    results=CASE WHEN p_error IS NULL THEN p_results ELSE NULL END,error_code=p_error,completed_at=clock_timestamp()
    WHERE participant_id=pid AND request_id=p_request AND status='pending' AND lease_expires_at>clock_timestamp();
  RETURN FOUND;
END $$;

CREATE FUNCTION ai_latency_private.search_click(p_hash text,p_search uuid,p_request uuid,p_rank integer,p_url text,p_clicked timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pid uuid; DECLARE e ai_latency_private.source_events%ROWTYPE;
BEGIN
  PERFORM 1 FROM ai_latency_private.participant_sessions WHERE token_hash=p_hash FOR UPDATE;
  pid=ai_latency_private.search_participant(p_hash);
  IF p_request IS NULL OR p_clicked IS NULL OR p_rank NOT BETWEEN 1 AND 20 OR p_url IS NULL OR char_length(p_url)>4096 OR p_url !~* '^https?://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'Invalid click' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ai_latency_private.search_events s CROSS JOIN LATERAL jsonb_array_elements(s.results) result
    WHERE s.participant_id=pid AND s.search_event_id=p_search AND s.status='completed' AND (result->>'rank')::integer=p_rank AND result->>'url'=p_url) THEN
    RAISE EXCEPTION 'Unknown source' USING ERRCODE='42501'; END IF;
  SELECT * INTO e FROM ai_latency_private.source_events WHERE participant_id=pid AND request_id=p_request;
  IF FOUND THEN
    IF e.search_event_id IS DISTINCT FROM p_search OR e.source_url IS DISTINCT FROM p_url OR e.result_rank IS DISTINCT FROM p_rank OR e.accessed_at IS DISTINCT FROM p_clicked THEN
      RAISE EXCEPTION 'Click conflict' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('recorded',true);
  END IF;
  INSERT INTO ai_latency_private.source_events(participant_id,search_event_id,request_id,source_url,accessed_at,result_rank)
    VALUES(pid,p_search,p_request,p_url,p_clicked,p_rank);
  RETURN jsonb_build_object('recorded',true);
END $$;

DO $$ DECLARE signature text; DECLARE rol text; BEGIN
  FOREACH signature IN ARRAY ARRAY['search_participant(text)','search_state(text,uuid)','search_claim(text,uuid,text,timestamptz)',
    'search_requested(text,uuid,text,jsonb)','search_finish(text,uuid,jsonb,text)','search_click(text,uuid,uuid,integer,text,timestamptz)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM PUBLIC';
    IF signature<>'search_participant(text)' THEN EXECUTE 'GRANT EXECUTE ON FUNCTION ai_latency_private.'||signature||' TO ai_latency_app'; END IF;
    FOREACH rol IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=rol) THEN EXECUTE 'REVOKE ALL ON FUNCTION ai_latency_private.'||signature||' FROM '||quote_ident(rol); END IF;
    END LOOP;
  END LOOP;
END $$;
ALTER TABLE ai_latency_private.deployment_context DROP CONSTRAINT deployment_context_schema_version_check;
ALTER TABLE ai_latency_private.deployment_context ALTER COLUMN schema_version SET DEFAULT 7;
UPDATE ai_latency_private.deployment_context SET schema_version=7;
ALTER TABLE ai_latency_private.deployment_context ADD CHECK(schema_version=7);
COMMIT;
