// Isolated PostgreSQL fixtures only; never loads .env DB credentials or live providers.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {randomUUID}=require('node:crypto');const {PGlite}=require('@electric-sql/pglite');
const {createApp}=require('../server');
const {EnrollmentRepository,createEnrollmentService}=require('../backend/services/enrollment');
const {createAdminAuth,parseAdminConfig,passwordHash}=require('../backend/admin/auth');
const {createAdminRepository}=require('../backend/admin/data');
async function fixture({browserChecks}={}){
 const db=new PGlite();await db.exec("SET ai_latency.environment='test'");
 for(const f of (await fs.readdir(path.join(__dirname,'../backend/database/migrations'))).filter(f=>/^\d+.*\.sql$/.test(f)).sort())await db.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations',f),'utf8'));
 let draw=0;const repository=new EnrollmentRepository(db,'test'),service=createEnrollmentService({repository,environment:'test',eligibilityPolicy:'development-only',draw:()=>draw});
 const config={origin:'',cookieName:'ai_latency_session',secure:false,ttlSeconds:3600};
 const password='local-fixture-password-only',hash=await passwordHash(password);let adminConfig;
 const auth=createAdminAuth(()=>adminConfig);
 const pool={connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 let admin;
 const chat=require('../backend/services/chat').createChatService({repository,getProvider:()=>({model:'fixture',complete:async()=>'테스트 응답입니다.'})});
 const search=require('../backend/services/search').createSearchService({repository,getProvider:()=>({id:'fixture',policy:{fixture:true},search:async()=>[{rank:1,title:'테스트 출처',description:'고립된 테스트',url:'https://example.org/fixture'}]})});
 const app=createApp({getEnrollment:()=>({repository,service,config}),getChat:()=>chat,getSearch:()=>search,adminAuth:auth,getAdmin:()=>admin});
 const server=http.createServer(async(req,res)=>{
  if(browserChecks&&req.url==='/admin/'){
   res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'");
   res.end((await fs.readFile(path.join(__dirname,'../public/admin/index.html'),'utf8')).replace('</body>','<p id="result"></p><script src="/admin-test.js" defer></script></body>'));return;
  }
  if(browserChecks&&req.url==='/admin-test.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(`(${browserChecks.toString()})().then(()=>document.getElementById('result').textContent='UI_PASS').catch(e=>document.getElementById('result').textContent='UI_FAIL: '+e.message)`);return;}
  app(req,res);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;config.origin=base;
 adminConfig=parseAdminConfig({DB_ENV:'test',ADMIN_USERNAME:'fixture-researcher',ADMIN_PASSWORD_HASH:hash,APP_ORIGIN:base});
 admin=createAdminRepository({pool,environment:'test',origin:base});
 const request=(route,cookie,body,headers={})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie||'',...(body===undefined?{}:{'Content-Type':'application/json',Origin:base,'X-Experiment-Request':'1','X-Admin-Request':'1'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const api=(route,cookie,body)=>request('/api/participant/'+route,cookie,body);
 const ids={};
 for(const[name,condition]of [['completed',0],['active',1],['withdrawn',2],['ineligible',0]]){
  draw=condition;const session=await api('session',null,{}),cookie=session.headers.get('set-cookie').split(';')[0];
  await api('participants',cookie,{consent:true,eligibility:{testEligible:true}});
  const pre=await api('surveys/pre',cookie,{answers:name==='ineligible'?{aiExperience:'none'}:{aiExperience:'some',aiFrequency:'weekly',priorKnowledge:'medium'},mode:'submit',revision:0});
  const state=await pre.json();ids[name]={participant_id:state.participant_id,cookie};
  if(name==='ineligible')continue;
  await api('progress/task-guide/complete',cookie,{acknowledged:true});
  if(name==='completed'){
   const result=await(await api('conversations',cookie,{request_id:randomUUID(),message:'=SUM(1,2)\n"테스트"',submitted_at:new Date().toISOString()})).json();
   const timing=(await db.query('SELECT * FROM ai_latency_private.chat_timings WHERE participant_id=$1',[state.participant_id])).rows[0];
   const sent=new Date(timing.client_submitted_at).getTime();
   for(const[event,elapsed]of [['first-character',2100],['output-completed',2600]])await api('conversations/presentation',cookie,{delivery_id:timing.attempt_id,event,at:new Date(sent+elapsed).toISOString(),elapsed_ms:elapsed,restored:false});
   if(result.messages?.length!==2)throw Error('fixture chat failed');
   const found=await(await api('searches',cookie,{request_id:randomUUID(),query:'테스트 검색',submitted_at:new Date().toISOString()})).json();
   await api('searches/sources',cookie,{request_id:randomUUID(),search_event_id:found.search_event_id,rank:1,source_url:found.results[0].url,clicked_at:new Date().toISOString()});
   await api('progress/workspace/complete',cookie,{acknowledged:true});
   await api('decisions',cookie,{request_id:randomUUID(),product:'가상 장비',specifications:'가상 사양',rationale:'테스트용 판단',references:''});
   await api('surveys/post',cookie,{request_id:randomUUID(),answers:{perceivedDelay:'2',naturalness:'4',suspectedDelay:'no',suspectedPrewritten:'unsure'}});
   await api('progress/debriefing/complete',cookie,{acknowledged:true});
  }else if(name==='withdrawn')await api('progress/end',cookie,{reason:'withdrawn'});
 }
 return {db,base,app,admin,adminConfig,auth,password,ids,request,
  close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();}};
}
module.exports={fixture};
