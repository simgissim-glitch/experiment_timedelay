const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {readServerEnv}=require('../backend/environment');
test('로컬 .env와 배포 플랫폼 변수를 분리하고 Vercel에서 로컬 비밀값으로 대체하지 않는다',()=>{
 const local=readServerEnv({env:{OPENAI_API_KEY:'ignored-os-value'},readFile:()=>Buffer.from('OPENAI_API_KEY=fixture-local\nDB_ENV=test')});assert.equal(local.OPENAI_API_KEY,'fixture-local');
 const deployed=readServerEnv({env:{VERCEL:'1',OPENAI_API_KEY:'fixture-platform',DB_ENV:'test',UNRELATED_SECRET:'not-returned'},readFile:()=>{throw Error('must not read local .env');}});
 assert.equal(deployed.OPENAI_API_KEY,'fixture-platform');assert.equal(deployed.RUNTIME_MODE,'serverless');assert.equal(deployed.UNRELATED_SECRET,undefined);
 assert.throws(()=>readServerEnv({env:{VERCEL:'1',SERVER_ENV_SOURCE:'file'}}));
});
test('서버리스 pg 풀은 인스턴스당 연결 1개로 제한하며 로컬은 기존 3개를 유지한다',async()=>{
 const {parseDatabaseConfig}=require('../backend/database/config'),{createPool}=require('../backend/database/connection');
 for(const[runtime,n]of [['persistent',3],['serverless',1]]){
  const config=parseDatabaseConfig({DB_ENV:'test',TEST_DATABASE_URL:'postgresql://fixture:fixture@localhost/fixture',DB_SSL_MODE:'disable',RUNTIME_MODE:runtime}),pool=createPool(config);
  assert.equal(pool.options.max,n);assert.equal(pool.options.statement_timeout,5000);await pool.end();
 }
});
test('서버리스 관리자 인증을 명시적으로 차단하고 실제 인스턴스 간 메모리 세션 공유 불가를 검증한다',async()=>{
 const {createAdminAuth,parseAdminConfig,passwordHash}=require('../backend/admin/auth');
 const values={DB_ENV:'test',ADMIN_USERNAME:'fixture',ADMIN_PASSWORD_HASH:await passwordHash('fixture-password-only'),APP_ORIGIN:'http://localhost:3000'};
 assert.throws(()=>parseAdminConfig({...values,RUNTIME_MODE:'serverless'}),e=>e.code==='ADMIN_SERVERLESS_UNSUPPORTED');
 const config=parseAdminConfig(values),a=createAdminAuth(()=>config),b=createAdminAuth(()=>config);let cookie;
 const req={ip:'fixture',get:k=>({'origin':config.origin,'x-admin-request':'1'}[k])};
 await a.login(req,{cookie:(name,value)=>cookie=name+'='+value},'fixture','fixture-password-only');
 const logged={...req,get:k=>k==='cookie'?cookie:req.get(k)};assert.equal(a.require(logged).username,'fixture');assert.throws(()=>b.require(logged),e=>e.status===401);
});
test('연구자 승인 플래그만으로 실제 연구 및 Vercel 배포 차단을 우회하지 못한다',()=>{
 const {assess}=require('../scripts/deployment-check');
 const values={DB_ENV:'research',DATABASE_URL:'postgresql://fixture:fixture@db.example.org/fixture',APP_ORIGIN:'https://example.org',OPENAI_API_KEY:'fixture',OPENAI_MODEL:'gpt-6-luna',SEARCH_PROVIDER:'brave',SEARCH_API_KEY:'fixture',ADMIN_USERNAME:'fixture',ADMIN_PASSWORD_HASH:'fixture',ADMIN_DATABASE_URL:'fixture',RESEARCH_RELEASE_APPROVED:'true'};
 const result=assess(values,{target:'vercel'});assert.equal(result.status,'blocked');
 for(const id of ['runtime_mode','approved_research_materials','eligibility_policy'])assert.equal(result.checks.find(c=>c.id===id).status,'blocked');
 assert.equal(result.deployment_performed,false);
 assert.equal(assess({...values,RUNTIME_MODE:'serverless'},{target:'persistent'}).checks.find(c=>c.id==='runtime_mode').status,'blocked');
});
test('Vercel 어댑터는 포트를 자동으로 열지 않고 정적 파일·health 및 비공개 경계를 유지한다',async()=>{
 const app=require('../app'),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{assert.equal((await fetch(base+'/api/health')).status,200);assert.equal((await fetch(base+'/')).status,200);for(const file of ['/.env','/backend/environment.js','/server.js','/backend/admin/CODEBOOK.csv'])assert.equal((await fetch(base+file)).status,404);}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('작업 트리 검사기는 키·브라우저 비밀값을 탐지하되 비밀값 자체를 출력하지 않는다',async()=>{
 const {scan}=require('../scripts/security-check'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'experiment-security-'));
 const secret='sk-'+'x'.repeat(30);
 try{await fs.mkdir(path.join(dir,'public'));await fs.writeFile(path.join(dir,'public','app.js'),JSON.stringify(secret));await fs.writeFile(path.join(dir,'.env'),'OPENAI_API_KEY='+secret);
  const result=scan({directory:dir,secretValues:[secret]});assert.ok(result.findings.length);assert.ok(result.findings.every(f=>f.file==='public/app.js'));assert.ok(!JSON.stringify(result).includes(secret));
 }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('experiment-security-'));await fs.rm(dir,{recursive:true,force:true});}
});
test('배포 템플릿은 120초 시간 예산과 관리자 CDN 보안 헤더를 지정하며 비밀 파일은 제외한다',async()=>{
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'../deploy/vercel.template.json'),'utf8')),ignore=await fs.readFile(path.join(__dirname,'../.vercelignore'),'utf8');
 assert.equal(config.functions['app.js'].maxDuration,120);assert.ok(config.headers.some(r=>r.source==='/admin/(.*)'&&r.headers.some(h=>h.key==='Cache-Control'&&h.value==='no-store')));assert.match(ignore,/\.env/);assert.match(ignore,/secrets\//);
});
