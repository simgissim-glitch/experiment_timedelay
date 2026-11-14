const {test,before,after}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {fixture}=require('./admin-fixture');const {parseCSV,verifySnapshot}=require('../backend/admin/verify');const {schemas,codebook,csv}=require('../backend/admin/csv');
let f,cookie;
before(async()=>{f=await fixture();const r=await f.request('/api/admin/login',null,{username:'fixture-researcher',password:f.password});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];});
after(async()=>{await f?.close();});
test('로그인 전 전체 데이터·CSV·코딩과 참가자 쿠키를 차단하고 비밀번호·원본 토큰을 응답하지 않는다',async()=>{
 for(const url of ['/overview','/participants','/participants/'+f.ids.completed.participant_id,'/exports/participants','/exports/events','/exports/conversations','/exports/codebook']){
  assert.equal((await f.request('/api/admin'+url)).status,401);
  assert.equal((await f.request('/api/admin'+url,f.ids.completed.cookie)).status,401);
 }
 const session=await f.request('/api/admin/session',cookie);assert.equal(session.status,200);const text=await session.text();assert.ok(!text.includes(f.password)&&!text.includes(cookie.split('=')[1]));assert.equal(session.headers.get('cache-control'),'no-store');
 assert.equal((await f.request('/api/admin/overview',cookie+'; '+cookie)).status,401);
});
test('실제 격리 PostgreSQL 행과 관리자 집계·평균·중도 이탈자 기록이 일치한다',async()=>{
 const res=await f.request('/api/admin/overview',cookie);assert.equal(res.status,200);const o=await res.json();
 assert.equal(o.environment,'test');assert.equal(o.total,4);assert.equal(o.completed,1);assert.equal(o.in_progress,1);assert.equal(o.withdrawn,1);assert.equal(o.ineligible,1);
 assert.deepEqual(o.conditions.map(c=>[c.assigned,c.completed]),[[2,1],[1,0],[1,0]]);
 assert.equal(o.conditions[0].completion_rate,.5);assert.equal(o.conditions[0].actual_delay_mean_ms,2100);assert.equal(o.conditions[0].actual_delay_observations,1);assert.equal(o.conditions[1].actual_delay_mean_ms,null);
 assert.equal(o.search.attempts,1);assert.equal(o.search.source_clicks,1);
 assert.equal(o.steps.find(s=>s.step==='workspace').ended_incomplete,1);
 const raw=(await f.db.query('SELECT count(*)::integer AS n FROM ai_latency_private.participants')).rows[0];assert.equal(o.total,raw.n);
 const detail=await(await f.request('/api/admin/participants/'+f.ids.completed.participant_id,cookie)).json();
 assert.equal(detail.chat_messages.length,2);assert.equal(detail.search_events.length,1);assert.equal(detail.source_events.length,1);assert.equal(detail.survey_responses.length,2);assert.equal(detail.final_decisions.length,1);
 const dropout=await(await f.request('/api/admin/participants/'+f.ids.withdrawn.participant_id,cookie)).json();assert.equal(dropout.participant.progress_status,'withdrawn');assert.equal(dropout.participant.final_submitted_at,null);
});
test('연구자 코딩은 수정 이력·서버 시각을 남기고 중복·동시 덮어쓰기·참가자 조작을 차단한다',async()=>{
 const id=f.ids.completed.participant_id,body={request_id:randomUUID(),code:'unclear',notes:'연구자 테스트 메모',revision:0};
 assert.equal((await f.request(`/api/admin/participants/${id}/coding`,null,body)).status,401);
 assert.equal((await f.request(`/api/admin/participants/${id}/coding`,cookie,body,{Origin:'https://evil.example'})).status,403);
 assert.equal((await f.request(`/api/admin/participants/${id}/coding`,cookie,{...body,assessed_by:'forged'})).status,400);
 for(let i=0;i<2;i++)assert.equal((await f.request(`/api/admin/participants/${id}/coding`,cookie,body)).status,200);
 assert.equal((await f.request(`/api/admin/participants/${id}/coding`,cookie,{...body,request_id:randomUUID(),code:'accepted'})).status,409);
 const rows=(await f.db.query('SELECT * FROM ai_latency_private.final_decision_codings')).rows;assert.equal(rows.length,1);assert.equal(rows[0].researcher,'fixture-researcher');assert.ok(rows[0].coded_at);
 const progress=await(await f.request('/api/participant/progress',f.ids.completed.cookie)).text();assert.ok(!progress.includes('misinformation_acceptance')&&!progress.includes('연구자 테스트 메모'));
 await f.db.exec('SET ROLE ai_latency_app');try{await assert.rejects(f.db.query('SELECT ai_latency_private.admin_code_final($1,$2,$3,$4,$5,$6)',[id,'accepted','',1,'attacker',randomUUID()]),e=>e.code==='42501');}finally{await f.db.exec('RESET ROLE');}
});
test('세 CSV의 행·키·원문·JSON·변수가 DB 및 코드북과 일치하며 수식 주입을 무력화한다',async()=>{
 const snapshot=await f.admin.snapshot();assert.equal(verifySnapshot(snapshot).status,'ok');
 for(const[kind,table,key]of [['participants','participants','participant_id'],['events','research_events','event_id'],['conversations','chat_messages','chat_message_id']]){
  const response=await f.request('/api/admin/exports/'+kind,cookie);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),new RegExp('test-'+kind));
  const parsed=parseCSV(await response.text()),headers=parsed.shift();assert.deepEqual(headers,Object.keys(schemas[kind]));assert.equal(parsed.length,snapshot[table].length);
  assert.deepEqual(parsed.map(r=>r[headers.indexOf(key)]).sort(),snapshot[table].map(r=>r[key]).sort());
  for(const h of headers)assert.ok(codebook().some(r=>r.file===kind+'.csv'&&r.variable===h));
  if(kind==='conversations'){const content=parsed.map(r=>r[headers.indexOf('content')]);assert.ok(content.includes("'=SUM(1,2)\n\"테스트\""));}
  if(kind==='participants'){const p=parsed.find(r=>r[headers.indexOf('participant_id')]===f.ids.completed.participant_id);assert.equal(p[headers.indexOf('actual_delay_mean_ms')],'2100');assert.equal(p[headers.indexOf('misinformation_acceptance')],'unclear');assert.equal(JSON.parse(p[headers.indexOf('pre_answers')]).aiExperience,'some');}
 }
 for(const dangerous of ['=1',' +cmd','\t@cmd','-1'])assert.ok(parseCSV(csv(['x'],[{x:dangerous}]))[1][0].startsWith("'"));
});
test('관리자 DB 환경 불일치·권한 오류와 비활성 삭제/설정 변경은 성공하지 않는다',async()=>{
 const {createAdminRepository}=require('../backend/admin/data');const pool={connect:async()=>({query:(...args)=>f.db.query(...args),release(){}})};
 await assert.rejects(createAdminRepository({pool,environment:'research',origin:f.base}).snapshot(),e=>e.code==='ADMIN_DB_NOT_READY');
 for(const path of ['/data','/settings','/participants/'+f.ids.active.participant_id+'/delete'])assert.equal((await f.request('/api/admin'+path,cookie,{})).status,405);
 assert.equal((await f.request('/api/admin/participants?limit=100000',cookie)).status,400);
});
test('로그인 시도 제한·로그아웃·만료·암호 변경·Secure 쿠키를 서버에서 처리한다',async()=>{
 const {createAdminAuth}=require('../backend/admin/auth');let config={...f.adminConfig,ttlMs:1};const auth=createAdminAuth(()=>config);
 const request={ip:'fixture',get:key=>({'origin':config.origin,'x-admin-request':'1'}[key])};let token,options;
 const response={cookie:(name,value,opts)=>{token=name+'='+value;options=opts;},clearCookie(){}};
 await auth.login(request,response,'fixture-researcher',f.password);assert.equal(options.httpOnly,true);assert.equal(options.sameSite,'strict');
 await new Promise(r=>setTimeout(r,5));assert.throws(()=>auth.require({...request,get:k=>k==='cookie'?token:request.get(k)}),e=>e.status===401);
 config={...config,ttlMs:60000,secure:true,cookieName:'__Host-ai_latency_admin'};await auth.login(request,response,'fixture-researcher',f.password);assert.equal(options.secure,true);
 const logged={...request,get:k=>k==='cookie'?token:request.get(k)};assert.equal(auth.require(logged).username,'fixture-researcher');auth.logout(logged,response);assert.throws(()=>auth.require(logged),e=>e.status===401);
 await auth.login(request,response,'fixture-researcher',f.password);const beforeChange={...request,get:k=>k==='cookie'?token:request.get(k)};
 config={...config,hash:'0'.repeat(128)};assert.throws(()=>auth.require(beforeChange),e=>e.status===401);
 // This IP has already used one successful login in the fixture.
 for(let i=0;i<4;i++)assert.equal((await f.request('/api/admin/login',null,{username:'bad',password:'bad'})).status,401);
 assert.equal((await f.request('/api/admin/login',null,{username:'bad',password:'bad'})).status,429);
});
