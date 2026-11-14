const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {createApp}=require('../server');
const {EnrollmentRepository,createEnrollmentService,tokenHash}=require('../backend/services/enrollment');
const {createSearchService}=require('../backend/services/search');
const {parseSearchConfig,createBraveProvider,searchError,validSourceURL}=require('../backend/search/provider');
let db,repo,server,base,draw=0,calls=[],mode='success',gate,started;
const origin='http://localhost:3000';
const config=parseSearchConfig({SEARCH_PROVIDER:'brave',SEARCH_API_KEY:'test-secret-not-real'});
const payload=query=>({request_id:randomUUID(),query,submitted_at:new Date().toISOString()});
async function api(route,cookie,body){return fetch(base+'/api/participant/'+route,{method:body?'POST':'GET',headers:{Cookie:cookie||'',...(body?{'Content-Type':'application/json',Origin:origin,'X-Experiment-Request':'1'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
async function ready(condition=0){
  draw=condition;const res=await api('session',null,{}),cookie=res.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('participants',cookie,{consent:true,eligibility:{testEligible:true}})).status,200);
  assert.equal((await api('surveys/pre',cookie,{answers:{aiExperience:'some',aiFrequency:'weekly',priorKnowledge:'medium'},mode:'submit',revision:0})).status,200);
  assert.equal((await api('progress/task-guide/complete',cookie,{acknowledged:true})).status,200);return cookie;
}
before(async()=>{
  db=new PGlite();await db.exec("SET ai_latency.environment='test'");
  for(const file of ['001_initial_schema.sql','002_enrollment_sessions.sql','003_early_workflow.sql','004_chat.sql','005_response_timing.sql','006_initial_stimulus.sql','007_web_search.sql','008_research_events.sql','009_final_workflow.sql','010_admin_dashboard.sql'])await db.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations',file),'utf8'));
  repo=new EnrollmentRepository(db,'test');const service=createEnrollmentService({repository:repo,environment:'test',eligibilityPolicy:'development-only',draw:()=>draw});
  const provider=createBraveProvider(config,{fetchImpl:async(url,options)=>{
    calls.push({url:String(url),headers:options.headers});if(gate){started();await gate;}
    if(mode==='rate')return new Response('private-upstream-test-secret-not-real',{status:429});
    if(mode==='error')throw Error('private upstream raw error');
    if(mode==='malformed')return new Response('{}',{headers:{'Content-Type':'application/json'}});
    return new Response(JSON.stringify({type:'search',web:{results:mode==='empty'?[]:[
      {title:'공식 문서 (테스트 대역)',description:'<strong>테스트</strong> 설명',url:'https://example.org/doc'},
      {title:'실행하지 않을 주소',description:'',url:'javascript:alert(1)'},
      {title:'두 번째 문서 (테스트 대역)',description:'설명 &amp; 정보',url:'https://example.org/second'},
    ]}}),{headers:{'Content-Type':'application/json'}});
  }});
  const search=createSearchService({repository:repo,getProvider:()=>{if(mode==='missing')throw searchError('SEARCH_NOT_CONFIGURED');return provider;}});
  server=createApp({getEnrollment:()=>({service,repository:repo,config:{origin,cookieName:'ai_latency_session',secure:false,ttlSeconds:3600}}),getSearch:()=>search}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();});
test('미설정·잘못된 제공자 설정과 실행 가능한 출처 URL을 거절한다',()=>{
  for(const values of [{},{SEARCH_PROVIDER:'other',SEARCH_API_KEY:'x'},{SEARCH_PROVIDER:'brave',SEARCH_API_KEY:'x',SEARCH_RESULT_COUNT:'21'}])assert.throws(()=>parseSearchConfig(values),{code:'SEARCH_NOT_CONFIGURED'});
  for(const url of ['javascript:alert(1)','data:text/html,test','https://user:pass@example.org','https://example.org/ bad'])assert.equal(validSourceURL(url),false);
});
test('A/B/C 동일 파라미터·제공자 순위, 결과 원문 보존·복원과 중복 실행 방지',async()=>{
  const cookies=[];for(let i=0;i<3;i++)cookies.push(await ready(i));
  const initial=calls.length;
  for(const cookie of cookies){
    const request=payload('장비 사용 설명서'),res=await api('searches',cookie,request);assert.equal(res.status,200);const data=await res.json();
    assert.deepEqual(data.results.map(r=>r.rank),[1,3]);assert.equal(data.results[0].description,'테스트 설명');assert.equal(data.results[1].description,'설명 & 정보');
    assert.equal((await api('searches',cookie,request)).status,200);assert.deepEqual(await(await api('searches',cookie)).json(),data);
    assert.equal((await api('searches',cookie,{...request,query:'다른 검색어'})).status,409);
    assert.ok(!JSON.stringify(data).includes('test-secret'));assert.ok(!JSON.stringify(data).includes('condition'));
    const row=(await db.query('SELECT * FROM ai_latency_private.search_events WHERE request_id=$1',[request.request_id])).rows[0];
    assert.equal(row.query,request.query);assert.equal(row.status,'completed');assert.ok(row.provider_requested_at&&row.client_submitted_at&&row.executed_at&&row.completed_at);assert.deepEqual(row.results,data.results);
  }
  assert.equal(calls.length,initial+3);assert.equal(new Set(calls.slice(initial).map(c=>c.url)).size,1);
  assert.equal(new URL(calls[initial].url).origin,'https://api.search.brave.com');assert.equal(calls[initial].headers['X-Subscription-Token'],'test-secret-not-real');
});
test('검색 이벤트와 출처 클릭은 별개이며 저장 결과의 URL·순위·소유자를 확인한다',async()=>{
  const cookie=await ready(),other=await ready();const search=await(await api('searches',cookie,payload('출처 테스트'))).json();
  const click={request_id:randomUUID(),search_event_id:search.search_event_id,rank:1,source_url:search.results[0].url,clicked_at:new Date().toISOString()};
  assert.equal((await api('searches/sources',cookie,click)).status,200);assert.equal((await api('searches/sources',cookie,click)).status,200);
  assert.equal((await api('searches/sources',other,click)).status,403);assert.equal((await api('searches/sources',cookie,{...click,request_id:randomUUID(),source_url:'https://example.org/forged'})).status,403);
  const rows=(await db.query('SELECT * FROM ai_latency_private.source_events WHERE request_id=$1',[click.request_id])).rows;assert.equal(rows.length,1);assert.equal(rows[0].source_url,click.source_url);assert.equal(new Date(rows[0].accessed_at).toISOString(),click.clicked_at);assert.equal(rows[0].returned_at,null);
  assert.equal((await api('searches',other)).status,200);assert.equal(await(await api('searches',other)).json(),null);
});
test('미설정·429·통신·형식 실패에 가짜 결과가 없고 빈 실제 결과는 성공한다',async()=>{
  for(const [nextMode,status]of [['missing',503],['rate',429],['error',502],['malformed',502]]){
    mode=nextMode;const cookie=await ready(),request=payload('실패 확인');
    const response=await api('searches',cookie,request);assert.equal(response.status,status);const text=await response.text();assert.ok(!text.includes('test-secret'));assert.ok(!text.includes('private upstream'));
    const state=await(await api('searches',cookie)).json();assert.equal(state.status,'failed');assert.deepEqual(state.results,[]);
    const count=calls.length;assert.equal((await api('searches',cookie,request)).status,status);assert.equal(calls.length,count);
  }
  mode='empty';const cookie=await ready(),response=await api('searches',cookie,payload('빈 결과'));assert.equal(response.status,200);assert.deepEqual((await response.json()).results,[]);mode='success';
});
test('동시 중복은 추가 호출 없이 pending으로 반환하고 최소 권한·접근 경계를 유지한다',async()=>{
  const cookie=await ready(),request=payload('중복 확인');let release;
  gate=new Promise(resolve=>release=resolve);const began=new Promise(resolve=>started=resolve),count=calls.length;
  const first=api('searches',cookie,request);await began;assert.equal((await api('searches',cookie,request)).status,202);release();gate=null;assert.equal((await first).status,200);assert.equal(calls.length,count+1);
  assert.equal((await api('searches')).status,401);
  const csrf=await fetch(base+'/api/participant/searches',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:'https://other.example','X-Experiment-Request':'1'},body:JSON.stringify(payload('csrf'))});assert.equal(csrf.status,403);
  await db.exec('SET ROLE ai_latency_app');try{
    assert.equal((await repo.search('state',tokenHash(cookie.split('=')[1]),[null])).status,'completed');
    await assert.rejects(db.query('SELECT * FROM ai_latency_private.search_events'));await assert.rejects(db.query('SELECT * FROM ai_latency_private.source_events'));
  }finally{await db.exec('RESET ROLE');}
});

