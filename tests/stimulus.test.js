const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {createApp}=require('../server');
const {EnrollmentRepository,createEnrollmentService,tokenHash}=require('../backend/services/enrollment');
const {createChatService}=require('../backend/services/chat');
const {loadStimulus,validateStimulus}=require('../backend/stimuli');
const {createOpenAIProvider,createClient,INSTRUCTIONS}=require('../backend/ai/openai');
const stimulus=loadStimulus('test'),origin='http://localhost:3000';
let db,repo,server,base,draw=0,calls=[];
const providers=()=>createOpenAIProvider({apiKey:'test-only-key',model:'gpt-6-luna'},{client:createClient('test-only-key',{fetch:async(url,options)=>{
  calls.push(JSON.parse(options.body));return new Response(JSON.stringify({object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'맞습니다. 앞선 계산은 잘못되었습니다. 4 × 2 = 8시간으로 정정합니다.',annotations:[]}]}]}),{headers:{'Content-Type':'application/json'}});
}})});
async function api(route,cookie,body){return fetch(base+'/api/participant/'+route,{method:body?'POST':'GET',headers:{Cookie:cookie||'',...(body?{'Content-Type':'application/json',Origin:origin,'X-Experiment-Request':'1'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
async function ready(condition=0){
  draw=condition;const res=await api('session',null,{}),cookie=res.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('participants',cookie,{consent:true,eligibility:{testEligible:true}})).status,200);
  assert.equal((await api('surveys/pre',cookie,{answers:{aiExperience:'some',aiFrequency:'weekly',priorKnowledge:'medium'},mode:'submit',revision:0})).status,200);
  assert.equal((await api('progress/task-guide/complete',cookie,{acknowledged:true})).status,200);return cookie;
}
async function presentation(cookie,message){
  for(const event of ['first-character','output-completed']){
    assert.equal((await api('conversations/presentation',cookie,{delivery_id:message.delivery_id,event,at:new Date().toISOString(),elapsed_ms:null,restored:true})).status,200);
    if(event==='first-character'){
      const row=(await db.query('SELECT initial_exposed_at,initial_display_started_at FROM ai_latency_private.participant_stimuli WHERE exposure_delivery_id=$1',[message.delivery_id])).rows[0];
      assert.ok(row.initial_display_started_at);assert.equal(row.initial_exposed_at,null);
    }
  }
}
before(async()=>{
  db=new PGlite();await db.exec("SET ai_latency.environment='test'");
  for(const file of ['001_initial_schema.sql','002_enrollment_sessions.sql','003_early_workflow.sql','004_chat.sql','005_response_timing.sql','006_initial_stimulus.sql','007_web_search.sql','008_research_events.sql','009_final_workflow.sql','010_admin_dashboard.sql'])await db.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations',file),'utf8'));
  repo=new EnrollmentRepository(db,'test');const service=createEnrollmentService({repository:repo,environment:'test',eligibilityPolicy:'development-only',draw:()=>draw});
  const chat=createChatService({repository:repo,getProvider:providers,getStimulus:()=>stimulus});
  server=createApp({getEnrollment:()=>({service,repository:repo,config:{origin,cookieName:'ai_latency_session',secure:false,ttlSeconds:3600}}),getChat:()=>chat}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();});
test('실제 연구 TODO와 테스트 환경 혼용을 차단한다',()=>{
  assert.throws(()=>loadStimulus('research'),{code:'CHAT_NOT_CONFIGURED'});
  assert.throws(()=>validateStimulus({...require('../backend/stimuli/development.json')},'research'),{code:'CHAT_NOT_CONFIGURED'});
});
test('A/B/C 동일 질문·답변, DB 버전·지연·최초 노출과 중복 방지',async(t)=>{
  const cookies=[];for(let i=0;i<3;i++)cookies.push(await ready(i));
  const results=await Promise.all(cookies.map(async(cookie,i)=>{
    const state=await(await api('conversations',cookie)).json();assert.equal(state.initial_question,stimulus.question);assert.equal(state.initial_required,true);
    const initialJSON=JSON.stringify(state);for(const secret of ['answer_origin','fixed_initial',stimulus.answer,stimulus.version,stimulus.errorKey,stimulus.expectedTruth,'target_delay_ms'])assert.ok(!initialJSON.includes(secret));
    assert.equal((await api('conversations',cookie,{request_id:randomUUID(),message:'임의 첫 질문'})).status,400);
    const request={request_id:randomUUID(),message:state.initial_question,submitted_at:new Date().toISOString()};
    const start=performance.now(),responsePromise=api('conversations',cookie,request);
    await new Promise(resolve=>setTimeout(resolve,100));
    const hidden=await(await api('conversations',cookie)).json();assert.equal(hidden.messages.filter(m=>m.role==='assistant').length,0);
    const duplicatePromise=api('conversations',cookie,request);
    const response=await responsePromise;assert.equal(response.status,200);const data=await response.json();const elapsed=performance.now()-start;
    const answer=data.messages.find(m=>m.role==='assistant');assert.equal(answer.content,stimulus.answer);
    assert.equal((await duplicatePromise).status,200);assert.ok(elapsed>=[2000,9000,20000][i]);
    assert.equal(data.initial_required,false);assert.equal((await api('conversations',cookie,{request_id:randomUUID(),message:'아직 표시 확인 전'})).status,409);
    await presentation(cookie,answer);
    const rows=(await db.query('SELECT b.*,r.answer_origin,r.stimulus_version,t.target_delay_ms FROM ai_latency_private.participant_stimuli b JOIN ai_latency_private.chat_requests r ON r.participant_id=b.participant_id AND r.request_id=b.first_request_id JOIN ai_latency_private.chat_timings t USING(attempt_id) WHERE r.request_id=$1',[request.request_id])).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].answer_origin,'fixed_initial');assert.equal(rows[0].stimulus_version,stimulus.version);assert.equal(rows[0].target_delay_ms,[2000,9000,20000][i]);assert.ok(rows[0].initial_exposed_at);assert.equal(rows[0].correction_status,'not_assessed');
    assert.equal((await(await api('conversations',cookie)).json()).messages.length,2);
    return {condition:['A','B','C'][i],elapsed_ms:Math.round(elapsed),cookie,answer};
  }));
  assert.equal(calls.length,0,'최초 답변에 OpenAI 호출 없음');t.diagnostic(JSON.stringify(results.map(({condition,elapsed_ms})=>({condition,elapsed_ms}))));
  const cookie=results[0].cookie;
  const response=await api('conversations',cookie,{request_id:randomUUID(),message:'4시간짜리 배터리 두 개면 8시간 아닌가요? 이전 답변을 검토해 주세요.'});
  assert.equal(response.status,200);const data=await response.json();assert.match(data.messages.at(-1).content,/8시간/);
  assert.equal(calls.length,1);assert.deepEqual(calls[0].input.slice(0,2),[{role:'user',content:stimulus.question},{role:'assistant',content:stimulus.answer}]);assert.equal(calls[0].model,'gpt-6-luna');assert.match(INSTRUCTIONS,/정정/);assert.ok(!calls[0].instructions.includes(stimulus.errorKey));
  const reset=createChatService({repository:new EnrollmentRepository(db,'test'),getProvider:providers,getStimulus:()=>stimulus});
  assert.equal((await reset.history(cookie.split('=')[1])).messages.length,4);
});
test('변경된 자극물 혼입·직접 테이블 조회·다른 참가자의 노출 조작을 막는다',async()=>{
  const cookie=await ready(),token=cookie.split('=')[1];await api('conversations',cookie);
  const changed=validateStimulus({...require('../backend/stimuli/development.json'),answer:'변경된 텍스트'},'test');
  const service=createChatService({repository:repo,getProvider:providers,getStimulus:()=>changed});await assert.rejects(service.history(token),{code:'PARTICIPATION_LOCKED'});
  const other=await ready();
  const delivery=(await db.query('SELECT exposure_delivery_id FROM ai_latency_private.participant_stimuli WHERE exposure_delivery_id IS NOT NULL LIMIT 1')).rows[0].exposure_delivery_id;
  assert.equal((await api('conversations/presentation',other,{delivery_id:delivery,event:'first-character',at:new Date().toISOString(),elapsed_ms:1,restored:false})).status,403);
  await db.exec('SET ROLE ai_latency_app');try{await assert.rejects(db.query('SELECT * FROM ai_latency_private.stimulus_versions'));await assert.rejects(db.query('SELECT * FROM ai_latency_private.participant_stimuli'));}finally{await db.exec('RESET ROLE');}
});


