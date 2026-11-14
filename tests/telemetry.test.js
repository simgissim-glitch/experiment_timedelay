const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {createApp}=require('../server');
const {EnrollmentRepository,createEnrollmentService,tokenHash}=require('../backend/services/enrollment');
const {createSearchService}=require('../backend/services/search');
const {analyzeTask,duration,merge,subtract}=require('../backend/analysis/metrics');
let db,repo,server,base;
const origin='http://localhost:3000';
async function api(route,cookie,body){return fetch(base+'/api/participant/'+route,{method:body?'POST':'GET',headers:{Cookie:cookie||'',...(body?{'Content-Type':'application/json',Origin:origin,'X-Experiment-Request':'1'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
async function ready(){
 const res=await api('session',null,{}),cookie=res.headers.get('set-cookie').split(';')[0];
 await api('participants',cookie,{consent:true,eligibility:{testEligible:true}});
 await api('surveys/pre',cookie,{answers:{aiExperience:'some',aiFrequency:'weekly',priorKnowledge:'medium'},mode:'submit',revision:0});
 await api('progress/task-guide/complete',cookie,{acknowledged:true});
 const context=await(await api('logs/context',cookie)).json();return {cookie,context};
}
function event(task,type='heartbeat',overrides={}){return {event_id:randomUUID(),task_id:task,type,browser_timestamp:new Date().toISOString(),page_id:randomUUID(),performance_ms:10,performance_time_origin:Date.now()-10,related_type:null,related_id:null,payload:{},...overrides};}
before(async()=>{
 db=new PGlite();await db.exec("SET ai_latency.environment='test'");
 for(const file of ['001_initial_schema.sql','002_enrollment_sessions.sql','003_early_workflow.sql','004_chat.sql','005_response_timing.sql','006_initial_stimulus.sql','007_web_search.sql','008_research_events.sql','009_final_workflow.sql','010_admin_dashboard.sql'])await db.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations',file),'utf8'));
 repo=new EnrollmentRepository(db,'test');const service=createEnrollmentService({repository:repo,environment:'test',eligibilityPolicy:'development-only',draw:()=>0});
 const search=createSearchService({repository:repo,getProvider:()=>({id:'test-only',policy:{fixture:true},search:async()=>[{rank:1,title:'테스트 출처',description:'테스트 대역',url:'https://example.org/doc'}]})});
 server=createApp({getEnrollment:()=>({service,repository:repo,config:{origin,cookieName:'ai_latency_session',secure:false,ttlSeconds:3600}}),getSearch:()=>search}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();});
test('서버가 참가자·조건·task_id를 결정하고 이벤트 중복과 변조·타인 접근을 거절한다',async()=>{
 const {cookie,context}=await ready(),other=await ready();assert.ok(context.task_id);assert.equal(context.active,true);assert.ok(!JSON.stringify(context).includes('condition'));
 const e=event(context.task_id,'tab_hidden',{payload:{visibility:'hidden'}});
 for(let i=0;i<2;i++){const response=await api('logs',cookie,{events:[e]});assert.equal(response.status,200);assert.deepEqual((await response.json()).acknowledged,[e.event_id]);}
 const rows=(await db.query('SELECT * FROM ai_latency_private.research_events WHERE event_id=$1',[e.event_id])).rows;assert.equal(rows.length,1);assert.equal(rows[0].condition_code,'A');assert.equal(rows[0].timestamp_source,'browser_reported');assert.ok(rows[0].server_timestamp);assert.equal(rows[0].performance_ms,10);
 assert.equal((await api('logs',cookie,{events:[{...e,payload:{visibility:'visible'}}]})).status,400);
 assert.equal((await api('logs',other.cookie,{events:[e]})).status,400);
 assert.equal((await api('logs',cookie,{events:[{...e,event_id:randomUUID(),participant_id:randomUUID()}]})).status,400);
 assert.equal((await api('logs',cookie,{events:[event(context.task_id,'final_submitted')]})).status,400);
 assert.equal((await api('logs',cookie,{events:[event(context.task_id,'heartbeat',{performance_ms:Infinity})]})).status,400);
 assert.equal((await api('logs',undefined,{events:[e]})).status,401);
 const before=event(context.task_id);await api('progress/end',cookie,{reason:'withdrawn'});
 assert.equal((await api('logs',cookie,{events:[before]})).status,200);const late=(await db.query('SELECT late_after_end FROM ai_latency_private.research_events WHERE event_id=$1',[before.event_id])).rows[0];assert.equal(late.late_after_end,true);
});
test('검색·출처·복귀와 실제 최종 저장의 공통 이벤트가 분리되며 횟수와 제출 시각은 저장 근거만 사용한다',async()=>{
 const {cookie,context}=await ready();
 const result=await(await api('searches',cookie,{request_id:randomUUID(),query:'자료',submitted_at:new Date().toISOString()})).json();
 const click={request_id:randomUUID(),search_event_id:result.search_event_id,rank:1,source_url:result.results[0].url,clicked_at:new Date().toISOString()};
 // 오프라인 클릭 재전송이 복귀 이벤트보다 늦게 도착하는 순서도 지원한다.
 const ret=event(context.task_id,'source_return',{related_type:'source_click',related_id:click.request_id,browser_timestamp:new Date(Date.now()+10).toISOString(),payload:{url:click.source_url}});
 assert.equal((await api('logs',cookie,{events:[ret]})).status,200);
 assert.equal((await api('searches/sources',cookie,click)).status,200);
 const source=(await db.query('SELECT * FROM ai_latency_private.source_events WHERE request_id=$1',[click.request_id])).rows[0];assert.equal(new Date(source.returned_at).toISOString(),ret.browser_timestamp);
 let summary=(await db.query('SELECT * FROM ai_latency_private.research_task_summary WHERE task_id=$1',[context.task_id])).rows[0];assert.equal(summary.submitted_at,null);assert.equal(summary.total_task_ms,null);assert.equal(Number(summary.search_attempt_count),1);assert.equal(Number(summary.source_click_count),1);
 const saved=await db.query("INSERT INTO ai_latency_private.final_decisions(participant_id,request_id,product_code,rationale) VALUES($1,$2,'fictional-test','테스트용 실제 저장') RETURNING submitted_at",[summary.participant_id,randomUUID()]);
 summary=(await db.query('SELECT * FROM ai_latency_private.research_task_summary WHERE task_id=$1',[context.task_id])).rows[0];assert.equal(new Date(summary.submitted_at).getTime(),new Date(saved.rows[0].submitted_at).getTime());assert.ok(Number(summary.total_task_ms)>=0);
 const events=(await db.query('SELECT * FROM ai_latency_private.research_events WHERE task_id=$1',[context.task_id])).rows;
 for(const type of ['task_started','search_executed','search_api_requested','search_completed','source_access','source_return','final_submitted'])assert.equal(events.filter(e=>e.event_type===type).length,1,type);
 for(const e of events){assert.equal(e.participant_id,summary.participant_id);assert.equal(e.task_id,context.task_id);assert.ok(e.event_id&&e.timestamp&&e.server_timestamp);}
 await db.exec('SET ROLE ai_latency_app');try{await assert.rejects(db.query('SELECT * FROM ai_latency_private.research_events'));await assert.rejects(db.query('SELECT * FROM ai_latency_private.research_task_summary'));}finally{await db.exec('RESET ROLE');}
});
test('기존 데이터가 있는 007→008 이관은 원문·원래 시각·ID를 보존하고 legacy로 구분한다',async()=>{
 const old=new PGlite();try{
  await old.exec("SET ai_latency.environment='test'");for(const file of ['001_initial_schema.sql','002_enrollment_sessions.sql','003_early_workflow.sql','004_chat.sql','005_response_timing.sql','006_initial_stimulus.sql','007_web_search.sql'])await old.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations',file),'utf8'));
  const h='a'.repeat(64);await old.query('SELECT ai_latency_private.enrollment_create_session($1,3600)',[h]);await old.query("SELECT ai_latency_private.enrollment_register($1,'B','development-only-v1')",[h]);
  const pid=(await old.query('SELECT participant_id FROM ai_latency_private.participants')).rows[0].participant_id;
  const original=(await old.query("INSERT INTO ai_latency_private.behavior_events(participant_id,request_id,event_type,payload) VALUES($1,$2,'old_event','{\"unchanged\":true}') RETURNING *",[pid,randomUUID()])).rows[0];
  await old.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations/008_research_events.sql'),'utf8'));
  const retained=(await old.query('SELECT * FROM ai_latency_private.behavior_events')).rows[0];assert.deepEqual(retained,original);
  const copied=(await old.query('SELECT * FROM ai_latency_private.research_events WHERE event_id=$1',[original.behavior_event_id])).rows[0];assert.equal(copied.origin,'legacy');assert.equal(copied.condition_code,'B');assert.deepEqual(copied.payload,original.payload);assert.equal(new Date(copied.timestamp).getTime(),new Date(original.occurred_at).getTime());assert.ok(copied.task_id);
 }finally{await old.close();}
});
test('분석은 단조 시간·중첩 구간·검색 대기를 구분하고 미복귀/미제출을 0으로 만들지 않는다',()=>{
 const pid=randomUUID(),tid=randomUUID(),page=randomUUID(),request=randomUUID(),attempt=randomUUID(),searchId=randomUUID(),searchRequest=randomUUID(),source=randomUUID(),activity=randomUUID();
 const stamp=ms=>new Date(1000000+ms).toISOString();
 const make=(type,ms,related,payload={})=>({event_id:randomUUID(),participant_id:pid,task_id:tid,origin:'browser',event_type:type,page_id:page,performance_ms:ms,performance_time_origin:1000000,browser_timestamp:stamp(ms),related_id:related,payload});
 const events=[make('question_sent',0,request),make('ai_first_character_observed',10000,attempt),make('ai_output_completed_observed',11000,attempt),make('search_activity_start',1000,activity),make('search_submitted',2000,searchRequest),make('search_results_presented',3000,searchId),make('search_activity_end',4000,activity),make('source_click',4000,source),make('source_left',4100,source),make('source_return',8100,source)];
 const output=analyzeTask({task:{task_id:tid,participant_id:pid,condition_code:'C',started_at:stamp(0),submitted_at:null},events,timings:[{participant_id:pid,attempt_id:attempt,request_id:request,client_submitted_at:stamp(0)}],searches:[{participant_id:pid,search_event_id:searchId,request_id:searchRequest,client_submitted_at:stamp(2000),query:'자료',status:'completed'}],sources:[{participant_id:pid,request_id:source,source_url:'https://example.org/doc'}],appOrigin:origin});
 assert.equal(output.chats[0].ai_wait_ms,10000);assert.equal(output.chats[0].first_search_after_display_ms,null);assert.equal(output.chats[0].search_before_display,true);
 assert.equal(output.searches[0].results_render_latency_ms,1000);assert.equal(output.observed_search_panel_active_ms,3000);assert.equal(output.observed_search_activity_excluding_result_wait_ms,2000);
 assert.equal(output.observed_source_away_ms,4000);assert.equal(output.observed_information_activity_ms,6000);assert.equal(output.information_activity_during_ai_wait_ms,6000);assert.equal(output.ai_wait_without_observed_information_activity_ms,4000);
 assert.equal(output.sources[0].click_to_return_ms,4100);assert.equal(output.total_task_ms,null);assert.equal(output.sources[0].reading_confirmed,false);
 const dated=analyzeTask({task:{task_id:tid,participant_id:pid,started_at:new Date(1000123),submitted_at:new Date(1000500)}});assert.equal(dated.total_task_ms,377,'pg Date 객체의 밀리초 정밀도 유지');
 assert.deepEqual(merge([[0,10],[5,20],[30,40]]),[[0,20],[30,40]]);assert.deepEqual(subtract([[0,10]],[[2,4]]),[[0,2],[4,10]]);
 const a={page_id:page,performance_ms:1,browser_timestamp:stamp(10000)},b={page_id:page,performance_ms:51,browser_timestamp:stamp(5000)};assert.equal(duration(a,b).ms,50);assert.equal(duration(a,{...b,page_id:randomUUID()}).ms,null);
});
