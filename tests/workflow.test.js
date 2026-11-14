const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createApp } = require('../server');
const { EnrollmentRepository, createEnrollmentService, tokenHash } = require('../backend/services/enrollment');
let db, server, base, repository;
const origin = 'http://localhost:3000';
const full = { aiExperience:'some', aiFrequency:'weekly', priorKnowledge:'medium' };
const config = { origin, cookieName:'ai_latency_session', secure:false, ttlSeconds:2592000 };
async function request(route,cookie,body) {
  return fetch(base+route, {
    method:body === undefined ? 'GET':'POST',
    headers:{ Cookie:cookie || '', ...(body === undefined?{}:{'Content-Type':'application/json',Origin:origin,'X-Experiment-Request':'1'}) },
    ...(body === undefined?{}:{body:JSON.stringify(body)}),
  });
}
const api = (route,cookie,body) => request('/api/participant/'+route,cookie,body);
async function prepare(enroll=true) {
  const response=await api('session',null,{});
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  if (enroll) assert.equal((await api('participants',cookie,{consent:true,eligibility:{testEligible:true}})).status,200);
  return cookie;
}
async function state(cookie) {
  const response=await api('progress',cookie); assert.equal(response.status,200); return response.json();
}
async function save(cookie,answers=full,mode='submit',revision=0) { return api('surveys/pre',cookie,{answers,mode,revision}); }
before(async () => {
  db=new PGlite(); await db.exec("SET ai_latency.environment='test'");
  for (const file of ['001_initial_schema.sql','002_enrollment_sessions.sql','003_early_workflow.sql','004_chat.sql','005_response_timing.sql','006_initial_stimulus.sql','007_web_search.sql','008_research_events.sql','009_final_workflow.sql','010_admin_dashboard.sql']) {
    await db.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations',file),'utf8'));
  }
  repository=new EnrollmentRepository(db,'test');
  const service=createEnrollmentService({repository,environment:'test',eligibilityPolicy:'development-only'});
  server=createApp({getEnrollment:()=>({repository,service,config})}).listen(0,'127.0.0.1');
  await new Promise((resolve)=>server.once('listening',resolve)); base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{ server.closeAllConnections(); await new Promise((resolve)=>server.close(resolve)); await db.close(); });

test('최종 제출·사후 설문·디브리핑은 서버에서 순서를 검사하고 일곱 단계 시각과 종료를 복원한다',async()=>{
  const {randomUUID}=require('node:crypto');
  const cookie=await prepare();
  const decision={request_id:randomUUID(),product:'가상 제품',specifications:'가상 사양 4시간',rationale:'업무 조건 충족',references:''};
  const post={request_id:randomUUID(),answers:{perceivedDelay:'2',naturalness:'4',suspectedDelay:'unsure',suspectedPrewritten:'no'}};
  assert.equal((await api('decisions',cookie,decision)).status,403);
  assert.equal((await api('surveys/post',cookie,post)).status,403);
  assert.equal((await api('progress/debriefing/complete',cookie,{acknowledged:true})).status,403);
  await save(cookie);await api('progress/task-guide/complete',cookie,{acknowledged:true});
  assert.equal((await api('progress/navigate',cookie,{step:'post-survey'})).status,403);
  assert.equal((await api('progress/workspace/complete',cookie,{acknowledged:true})).status,200);
  assert.equal((await api('decisions',cookie,{...decision,specifications:' '})).status,400);
  assert.equal((await api('decisions',cookie,decision)).status,200);
  const submitted=await state(cookie);assert.equal(submitted.current_step,'post-survey');
  assert.equal((await api('decisions',cookie,decision)).status,200);
  assert.equal((await api('decisions',cookie,{...decision,rationale:'변경'})).status,409);
  assert.equal((await request('/experiment/workspace',cookie)).status,403);
  assert.equal((await api('surveys/post',cookie,{...post,answers:{...post.answers,perceivedDelay:'999'}})).status,400);
  assert.equal((await api('surveys/post',cookie,post)).status,200);
  const debrief=await state(cookie);assert.equal(debrief.current_step,'debriefing');
  assert.ok(debrief.debriefing.correction.includes('8시간'));assert.equal(debrief.debriefing.draft,true);
  assert.equal((await api('surveys/post',cookie,post)).status,200);
  assert.equal((await api('surveys/post',cookie,{...post,answers:{...post.answers,naturalness:'1'}})).status,409);
  assert.equal((await api('progress/debriefing/complete',cookie,{acknowledged:true})).status,200);
  const finished=await state(cookie);assert.equal(finished.completed,true);
  assert.ok(finished.steps.length===7&&finished.steps.every(step=>step.started_at&&step.completed_at));
  assert.equal((await api('progress/debriefing/complete',cookie,{acknowledged:true})).status,200);
  assert.equal((await api('progress/end',cookie,{reason:'withdrawn'})).status,409);
  assert.equal((await request('/experiment/debriefing',cookie)).status,200);
  assert.ok(!JSON.stringify(finished).includes('misinformation_acceptance'));
  const pid=finished.participant_id;
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM ai_latency_private.final_decisions WHERE participant_id=$1',[pid])).rows[0].n,1);
  await assert.rejects(db.query("UPDATE ai_latency_private.final_decisions SET rationale='modified' WHERE participant_id=$1",[pid]),error=>error.code==='55000');
  await db.query("UPDATE ai_latency_private.final_decisions SET misinformation_acceptance='unclear',assessed_at=now(),assessed_by='researcher-test' WHERE participant_id=$1",[pid]);
  assert.ok(!JSON.stringify(await state(cookie)).includes('researcher-test'));
  const task=(await db.query('SELECT submitted_at FROM ai_latency_private.research_tasks WHERE participant_id=$1',[pid])).rows[0];assert.ok(task.submitted_at);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM ai_latency_private.research_events WHERE participant_id=$1 AND event_type='final_submitted'",[pid])).rows[0].n,1);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM ai_latency_private.survey_responses WHERE participant_id=$1 AND phase='post'",[pid])).rows[0].n,1);
});

test('미승인 연구 자료는 실제 연구 환경에서 거절한다',()=>{
  const {validateMaterials,loadMaterials}=require('../backend/study');
  assert.throws(()=>loadMaterials('research'),error=>error.code==='STUDY_NOT_APPROVED');
  assert.throws(()=>validateMaterials({...require('../backend/study/development.json'),environment:'research'},'research'),error=>error.code==='STUDY_NOT_APPROVED');
});

test('정상 진행은 동의·설문·과제 안내 시각과 current_step을 DB에 저장한다',async()=>{
  const cookie=await prepare(); let current=await state(cookie);
  assert.equal(current.current_step,'pre-survey'); assert.equal(current.consent.decision,true);
  assert.equal(current.consent.version,'draft-consent-v1');
  assert.equal((await save(cookie)).status,200); current=await state(cookie);
  assert.equal(current.current_step,'task-guide'); assert.deepEqual(current.pre_survey.answers,full);
  assert.equal(current.pre_survey.is_draft,false); assert.ok(current.pre_survey.submitted_at);
  assert.equal((await api('progress/task-guide/complete',cookie,{acknowledged:true})).status,200);
  current=await state(cookie); assert.equal(current.current_step,'workspace');
  for (const step of ['consent','pre-survey','task-guide']) {
    const time=current.steps.find((item)=>item.step===step);
    assert.ok(time.started_at && time.completed_at);
    assert.ok(Date.parse(time.completed_at)>=Date.parse(time.started_at));
  }
  assert.equal(current.steps.find((item)=>item.step==='workspace').completed_at,null);
  const row=(await db.query('SELECT current_step,progress_status,task_guide_version,ended_at FROM ai_latency_private.participants WHERE participant_id=$1',[current.participant_id])).rows[0];
  assert.equal(row.current_step,'workspace'); assert.equal(row.progress_status,'workspace'); assert.equal(row.ended_at,null);
  assert.equal(row.task_guide_version,'task-guide-draft-v1');
  const before=JSON.stringify(current.steps);
  await api('progress/task-guide/complete',cookie,{acknowledged:true});
  assert.equal(JSON.stringify((await state(cookie)).steps),before);
  assert.ok(!JSON.stringify(current).includes('condition_code'));
});
test('비동의는 참가자를 생성하지 않고 세션에 종료와 동의 완료 시각만 기록한다',async()=>{
  const cookie=await prepare(false);
  const result=await api('progress/end',cookie,{reason:'declined'}); assert.equal(result.status,200);
  const current=await result.json(); assert.equal(current.registered,false); assert.equal(current.disposition,'declined');
  assert.equal(current.consent.decision,false); assert.ok(current.consent.completed_at);
  assert.deepEqual(await state(cookie),current);
  assert.equal((await api('participants',cookie,{consent:true,eligibility:{testEligible:true}})).status,409);
  assert.equal((await api('progress/navigate',cookie,{step:'workspace'})).status,409);
  const row=(await db.query('SELECT participant_id,terminated_at FROM ai_latency_private.participant_sessions WHERE token_hash=$1',[tokenHash(cookie.split('=')[1])])).rows[0];
  assert.equal(row.participant_id,null); assert.ok(row.terminated_at);
});
test('AI 이용 경험 없음은 응답을 저장한 후 적격성 종료로 구분하고 과제 진입을 막는다',async()=>{
  const cookie=await prepare(); const response=await save(cookie,{aiExperience:'none'});
  assert.equal(response.status,200); const current=await response.json();
  assert.equal(current.disposition,'ineligible'); assert.equal(current.screening_status,'failed');
  assert.deepEqual(current.pre_survey.answers,{aiExperience:'none',aiFrequency:'never'});
  const row=(await db.query('SELECT progress_status,termination_reason,ended_at FROM ai_latency_private.participants WHERE participant_id=$1',[current.participant_id])).rows[0];
  assert.equal(row.progress_status,'ineligible'); assert.equal(row.termination_reason,'no_ai_experience'); assert.ok(row.ended_at);
  assert.equal((await api('progress/navigate',cookie,{step:'task-guide'})).status,409);
  assert.equal((await request('/experiment/workspace',cookie)).status,409);
  assert.equal((await api('participants/'+current.participant_id,cookie)).status,403);
});
test('임시 응답과 완료 응답·진행 단계는 서비스 재생성 후에도 복원된다',async()=>{
  const cookie=await prepare();
  assert.equal((await save(cookie,{aiExperience:'some'},'draft')).status,200);
  let current=await state(cookie); assert.equal(current.current_step,'pre-survey');
  assert.equal(current.pre_survey.is_draft,true); assert.equal(current.pre_survey.revision,1);
  assert.equal(current.pre_survey.submitted_at,null);
  const {createWorkflowService}=require('../backend/services/workflow');
  const restarted=createWorkflowService(new EnrollmentRepository(db,'test'));
  assert.deepEqual(await restarted.state(cookie.split('=')[1]),current);
  assert.equal((await save(cookie,full,'submit',1)).status,200);
  current=await state(cookie); assert.equal(current.current_step,'task-guide');
  assert.deepEqual(await restarted.state(cookie.split('=')[1]),current);
  assert.equal((await api('progress/navigate',cookie,{step:'pre-survey'})).status,200);
  assert.equal((await state(cookie)).current_step,'pre-survey');
  assert.equal((await api('progress/navigate',cookie,{step:'task-guide'})).status,200);
});
test('해시가 아닌 실제 URL과 API 직접 요청도 서버가 단계 건너뛰기를 거절한다',async()=>{
  const cookie=await prepare(false);
  assert.equal((await request('/experiment/workspace',cookie)).status,403);
  assert.equal((await save(cookie)).status,403);
  await api('participants',cookie,{consent:true,eligibility:{testEligible:true}});
  for(const step of ['task-guide','workspace','decision','post-survey','debriefing']) {
    assert.equal((await request('/experiment/'+step,cookie)).status,403);
    assert.equal((await api('progress/navigate',cookie,{step})).status,403);
  }
  assert.equal((await api('progress/task-guide/complete',cookie,{acknowledged:true})).status,403);
  assert.equal((await save(cookie)).status,200);
  assert.equal((await request('/experiment/task-guide',cookie)).status,200);
  assert.equal((await request('/experiment/workspace',cookie)).status,403);
  assert.equal((await api('progress/navigate',cookie,{step:'workspace'})).status,403);
  assert.equal((await state(cookie)).current_step,'task-guide');
});
test('명시적 중단과 단순 미완료를 구분하고 중단은 미완료 단계를 완료 처리하지 않는다',async()=>{
  const active=await prepare(); let current=await state(active);
  let row=(await db.query('SELECT progress_status,ended_at FROM ai_latency_private.participants WHERE participant_id=$1',[current.participant_id])).rows[0];
  assert.equal(row.progress_status,'pre_survey'); assert.equal(row.ended_at,null);
  assert.equal(current.disposition,'active');
  const response=await api('progress/end',active,{reason:'withdrawn'}); assert.equal(response.status,200);
  current=await response.json(); assert.equal(current.disposition,'withdrawn');
  assert.equal(current.steps.find((item)=>item.step==='pre-survey').completed_at,null);
  row=(await db.query('SELECT progress_status,ended_at,termination_reason FROM ai_latency_private.participants WHERE participant_id=$1',[current.participant_id])).rows[0];
  assert.equal(row.progress_status,'withdrawn'); assert.ok(row.ended_at); assert.equal(row.termination_reason,'voluntary_withdrawal');
  assert.deepEqual(await state(active),current);
  assert.equal((await save(active)).status,409);
  assert.equal((await api('participants',active,{consent:true,eligibility:{testEligible:true}})).status,409);
  assert.equal((await api('progress/task-guide/complete',active,{acknowledged:true})).status,409);
  await assert.rejects(db.query("INSERT INTO ai_latency_private.behavior_events (participant_id,request_id,event_type) VALUES ($1,gen_random_uuid(),'late-event')",[current.participant_id]),{code:'23514'});
});
test('제출 재시도는 중복 레코드를 만들지 않고 다른 응답 덮어쓰기와 오래된 초안 저장을 거절한다',async()=>{
  const cookie=await prepare();
  assert.equal((await save(cookie,{aiExperience:'some'},'draft')).status,200);
  assert.equal((await save(cookie,full,'draft',0)).status,409);
  assert.equal((await save(cookie,full,'submit',1)).status,200);
  const current=await state(cookie);
  assert.equal((await save(cookie,full,'submit',1)).status,200);
  assert.deepEqual(await state(cookie),current);
  assert.equal((await save(cookie,{...full,priorKnowledge:'high'},'submit',2)).status,403);
  const count=(await db.query("SELECT count(*) AS n FROM ai_latency_private.survey_responses WHERE participant_id=$1 AND phase='pre'",[current.participant_id])).rows[0];
  assert.equal(Number(count.n),1);
});
test('서버는 누락·임의 척도·다른 참가자 지정·클라이언트 시각을 거절한다',async()=>{
  const cookie=await prepare();
  for(const body of [
    {answers:{aiExperience:'some'},mode:'submit',revision:0},
    {answers:{aiExperience:'some',aiFrequency:'always',priorKnowledge:'high'},mode:'submit',revision:0},
    {answers:{...full,participant_id:'someone'},mode:'submit',revision:0},
    {answers:full,mode:'submit',revision:0,started_at:'2026-01-01'},
    {answers:full,mode:'submit',revision:Number.MAX_SAFE_INTEGER},
  ]) assert.equal((await api('surveys/pre',cookie,body)).status,400);
  assert.equal((await state(cookie)).pre_survey.revision,0);
});
test('초안 응답 삭제와 동일 초안 재시도를 정확히 저장하고 중복으로 세지 않는다',async()=>{
  const cookie=await prepare();
  await save(cookie,{aiExperience:'some'},'draft');
  assert.equal((await save(cookie,{aiExperience:'some'},'draft',0)).status,200);
  assert.equal((await state(cookie)).pre_survey.revision,1);
  assert.equal((await save(cookie,{},'draft',1)).status,200);
  const current=await state(cookie); assert.deepEqual(current.pre_survey.answers,{});
  assert.equal(current.pre_survey.is_draft,true); assert.equal(current.pre_survey.revision,2);
  assert.equal((await save(cookie,{},'submit',2)).status,400);
});
test('최소 권한 앱 역할은 본인 세션 함수만 쓰고 다른 참가자의 설문 전체를 읽지 못한다',async()=>{
  const cookie=await prepare(); await db.exec('SET ROLE ai_latency_app');
  try {
    const {createWorkflowService}=require('../backend/services/workflow');
    const workflow=createWorkflowService(repository);
    const result=await workflow.savePre(cookie.split('=')[1],{answers:full,mode:'submit',revision:0});
    assert.equal(result.current_step,'task-guide');
    await assert.rejects(db.query('SELECT * FROM ai_latency_private.survey_responses'),{code:'42501'});
    await assert.rejects(db.query('SELECT * FROM ai_latency_private.participant_steps'),{code:'42501'});
  } finally { await db.exec('RESET ROLE'); }
});
test('003은 기존 등록 참가자의 ID·배정·시각을 보존하며 기존 시각의 출처를 표시한다',async()=>{
  const legacy=new PGlite();
  try {
    await legacy.exec("SET ai_latency.environment='test'");
    for(const file of ['001_initial_schema.sql','002_enrollment_sessions.sql']) await legacy.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations',file),'utf8'));
    const hash='a'.repeat(64);
    await legacy.query('SELECT ai_latency_private.enrollment_create_session($1,2592000)',[hash]);
    await legacy.query("SELECT * FROM ai_latency_private.enrollment_register($1,'B','development-only-v1')",[hash]);
    const before=(await legacy.query('SELECT participant_id,condition_code,assigned_at FROM ai_latency_private.participants')).rows[0];
    await legacy.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations/003_early_workflow.sql'),'utf8'));
    assert.deepEqual((await legacy.query('SELECT participant_id,condition_code,assigned_at FROM ai_latency_private.participants')).rows[0],before);
    const result=(await legacy.query('SELECT ai_latency_private.workflow_state($1) AS state',[hash])).rows[0].state;
    assert.equal(result.current_step,'pre-survey');assert.equal(result.consent.version,'legacy-unspecified');
    assert.ok(result.steps.every((step)=>step.timing_source==='legacy-derived'));
  } finally {await legacy.close();}
});




