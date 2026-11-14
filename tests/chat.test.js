const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {createApp}=require('../server');
const {EnrollmentRepository,createEnrollmentService,tokenHash}=require('../backend/services/enrollment');
const {createChatService}=require('../backend/services/chat');
const {createClient,createOpenAIProvider,INSTRUCTIONS}=require('../backend/ai/openai');
let db,server,base,repo,calls=[],behavior;
const origin='http://localhost:3000';
async function api(route,cookie,body){return fetch(base+'/api/participant/'+route,{method:body?'POST':'GET',headers:{Cookie:cookie||'',...(body?{'Content-Type':'application/json',Origin:origin,'X-Experiment-Request':'1'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
async function ready(){
  let res=await api('session',null,{});const cookie=res.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('participants',cookie,{consent:true,eligibility:{testEligible:true}})).status,200);
  assert.equal((await api('surveys/pre',cookie,{answers:{aiExperience:'some',aiFrequency:'weekly',priorKnowledge:'medium'},mode:'submit',revision:0})).status,200);
  assert.equal((await api('progress/task-guide/complete',cookie,{acknowledged:true})).status,200);return cookie;
}
const body=(message='장비를 비교해 주세요')=>({request_id:randomUUID(),message});
before(async()=>{
  db=new PGlite();await db.exec("SET ai_latency.environment='test'");
  for(const file of ['001_initial_schema.sql','002_enrollment_sessions.sql','003_early_workflow.sql','004_chat.sql','005_response_timing.sql','006_initial_stimulus.sql','007_web_search.sql','008_research_events.sql','009_final_workflow.sql','010_admin_dashboard.sql'])await db.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations',file),'utf8'));
  repo=new EnrollmentRepository(db,'test');
  const service=createEnrollmentService({repository:repo,environment:'test',eligibilityPolicy:'development-only',draw:()=>0});
  const client=createClient('test-key-never-real',{fetch:async(url,options)=>{
    const request=JSON.parse(options.body);calls.push(request);
    if(behavior)return behavior(request,options);
    return new Response(JSON.stringify({id:'resp_test',object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'확인한 범위에서 비교하겠습니다.',annotations:[]}]}]}),{status:200,headers:{'Content-Type':'application/json'}});
  }});
  const provider=createOpenAIProvider({apiKey:'test-key-never-real',model:'gpt-6-luna'},{client});
  const chat=createChatService({repository:repo,getProvider:()=>provider});
  server=createApp({getEnrollment:()=>({service,repository:repo,config:{origin,cookieName:'ai_latency_session',secure:false,ttlSeconds:3600}}),getChat:()=>chat}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();});
test('공식 SDK 요청과 DB 순서, 후속 문맥, 동일 요청 중복 방지 및 새 서비스 복원',async()=>{
  const cookie=await ready(),request=body();const start=calls.length;
  let response=await api('conversations',cookie,request);assert.equal(response.status,200);let data=await response.json();
  assert.deepEqual(data.messages.map(m=>m.role),['user','assistant']);assert.deepEqual(data.messages.map(m=>m.sequence_number),[1,2]);
  assert.equal((await api('conversations',cookie,request)).status,200);assert.equal(calls.length,start+1);
  response=await api('conversations',cookie,body('앞선 답변을 다시 검토해 주세요'));assert.equal(response.status,200);
  assert.deepEqual(calls.at(-1).input.map(m=>m.role),['user','assistant','user']);
  assert.equal(calls.at(-1).store,false);assert.equal(calls.at(-1).model,'gpt-6-luna');assert.match(INSTRUCTIONS,/정정/);
  const restored=await createChatService({repository:new EnrollmentRepository(db,'test'),getProvider:()=>{throw Error('history needs no key');}}).history(cookie.split('=')[1]);
  assert.equal(restored.messages.length,4);assert.ok(!JSON.stringify(restored).includes('gpt-6-luna'));assert.ok(!JSON.stringify(restored).includes('test-key'));
  assert.equal((await api('conversations',cookie,{...request,message:'different'})).status,409);
});
test('동시 요청은 하나만 실행하며 다른 참가자 대화는 조회하지 않는다',async()=>{
  const cookie=await ready(),other=await ready(),request=body();let release,started;
  const began=new Promise(resolve=>started=resolve);
  behavior=async()=>{started();await new Promise(resolve=>release=resolve);return new Response(JSON.stringify({object:'response',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'응답',annotations:[]}]}]}),{headers:{'Content-Type':'application/json'}});};
  const first=api('conversations',cookie,request);await began;
  assert.equal((await api('conversations',cookie,request)).status,202);
  assert.equal((await api('conversations',cookie,body())).status,409);
  assert.equal((await (await api('conversations',other)).json()).messages.length,0);
  release();assert.equal((await first).status,200);behavior=null;
});
test('429는 안전하게 기록하며 명시적 재시도는 사용자 메시지를 중복 저장하지 않는다',async()=>{
  const cookie=await ready(),request=body();
  behavior=async()=>new Response(JSON.stringify({error:{message:'secret-test-key upstream raw error',type:'rate_limit_error'}}),{status:429,headers:{'Content-Type':'application/json'}});
  let response=await api('conversations',cookie,request);assert.equal(response.status,429);assert.ok(!(await response.text()).includes('secret-test-key'));
  let state=await (await api('conversations',cookie)).json();assert.equal(state.requests[0].status,'failed');assert.equal(state.messages.length,1);
  const count=calls.length;assert.equal((await api('conversations',cookie,request)).status,200);assert.equal(calls.length,count);
  behavior=null;response=await api('conversations',cookie,{...request,retry:true});assert.equal(response.status,200);
  state=await response.json();assert.equal(state.messages.length,2);assert.equal(state.requests[0].attempts,2);
});
test('미완성 응답은 답변으로 저장하지 않고 참가자 호출 한도를 적용한다',async()=>{
  const cookie=await ready();behavior=async()=>new Response(JSON.stringify({status:'incomplete',output:[]}),{headers:{'Content-Type':'application/json'}});
  assert.equal((await api('conversations',cookie,body())).status,502);behavior=null;
  for(let i=0;i<4;i++)assert.equal((await api('conversations',cookie,body())).status,200);
  assert.equal((await api('conversations',cookie,body())).status,429);
  const state=await (await api('conversations',cookie)).json();assert.equal(state.messages.filter(m=>m.role==='assistant').length,4);
});
test('세션과 단계 및 CSRF 경계를 강제하고 앱 역할은 테이블을 직접 읽지 못한다',async()=>{
  assert.equal((await api('conversations')).status,401);
  const draft=await api('session',null,{}),cookie=draft.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('conversations',cookie,body())).status,403);
  const enrolled=await ready();
  const csrf=await fetch(base+'/api/participant/conversations',{method:'POST',headers:{Cookie:enrolled,'Content-Type':'application/json',Origin:'https://other.example','X-Experiment-Request':'1'},body:JSON.stringify(body())});
  assert.equal(csrf.status,403);
  await db.exec('SET ROLE ai_latency_app');
  try{
    assert.equal((await repo.chat('state',tokenHash(enrolled.split('=')[1]))).messages.length,0);
    await assert.rejects(db.query('SELECT * FROM ai_latency_private.chat_requests'));
  }finally{await db.exec('RESET ROLE');}
});
test('실패 요청 재시도는 세 번으로 제한하고 실패한 이전 질문은 후속 문맥에서 제외한다',async()=>{
  const cookie=await ready(),request=body('실패할 질문');
  behavior=async()=>new Response(JSON.stringify({error:{message:'upstream',type:'server_error'}}),{status:500,headers:{'Content-Type':'application/json'}});
  for(let i=0;i<3;i++)assert.equal((await api('conversations',cookie,{...request,retry:i>0})).status,502);
  assert.equal((await api('conversations',cookie,{...request,retry:true})).status,429);
  behavior=null;assert.equal((await api('conversations',cookie,body('새 질문'))).status,200);
  assert.deepEqual(calls.at(-1).input,[{role:'user',content:'새 질문'}]);
});
test('중단·시간 제한과 오래된 시도 결과는 완료된 답변으로 저장하지 않는다',async()=>{
  const cookie=await ready(),token=cookie.split('=')[1],h=tokenHash(token),request=body();
  const claim=await repo.chat('claim',h,[request.request_id,request.message,false,'gpt-6-luna']);
  await db.query("UPDATE ai_latency_private.chat_requests SET lease_expires_at=now()-interval '1 second' WHERE request_id=$1",[request.request_id]);
  assert.equal(await repo.chat('finish',h,[request.request_id,claim.attempt_id,'늦은 답변',null]),false);
  assert.equal((await repo.chat('state',h)).messages.length,1);
  const retry=await repo.chat('claim',h,[request.request_id,request.message,true,'gpt-6-luna']);
  assert.equal(await repo.chat('finish',h,[request.request_id,claim.attempt_id,'이전 시도',null]),false);
  assert.equal((await api('progress/end',cookie,{reason:'withdrawn'})).status,200);
  assert.equal(await repo.chat('finish',h,[request.request_id,retry.attempt_id,'중단 뒤 답변',null]),false);
  const provider=createOpenAIProvider({apiKey:'test',model:'gpt-6-luna'},{timeoutMs:10,client:{responses:{create:()=>new Promise(()=>{})}}});
  await assert.rejects(provider.complete([{role:'user',content:'test'}]),{code:'AI_TIMEOUT'});
  const controller=new AbortController();controller.abort();
  const aborted=createOpenAIProvider({apiKey:'test',model:'gpt-6-luna'},{client:{responses:{create:async()=>{throw Object.assign(Error('private'),{name:'AbortError'});}}}});
  await assert.rejects(aborted.complete([],{signal:controller.signal}),{code:'AI_INTERRUPTED'});
});




