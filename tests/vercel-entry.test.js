const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
// The official @vercel/express builder selects the first conventional file
// whose own source imports Express; a transitive import does not qualify.
const importsExpress=source=>/(?:from|require|import)\s*(?:\(\s*)?["']express["']\s*(?:\))?/.test(source);
test('Vercel 자동 탐지는 callable Express 앱을 export하는 app.js만 선택한다',()=>{
 const root=path.join(__dirname,'..');
 const candidates=['app.js','index.js','server.js'].filter(file=>fs.existsSync(path.join(root,file))&&importsExpress(fs.readFileSync(path.join(root,file),'utf8')));
 assert.deepEqual(candidates,['app.js']);
 const app=require('../'+candidates[0]);assert.equal(typeof app,'function');assert.equal(typeof app.handle,'function');
 assert.equal(require('../server').createApp,app.createApp);
});
test('Vercel 모듈 import는 포트를 열거나 환경변수·DB 연결을 요구하지 않는다',()=>{
 const result=spawnSync(process.execPath,['-e',"const net=require('node:net');net.Server.prototype.listen=()=>{throw Error('unexpected listen')};const app=require('./app');if(typeof app!=='function')process.exit(2);console.log('ENTRY_OK');"],{
  cwd:path.join(__dirname,'..'),env:{...process.env,VERCEL:'1',SERVER_ENV_SOURCE:'platform',DB_ENV:'test',TEST_DATABASE_URL:'',DATABASE_URL:'',OPENAI_API_KEY:'',OPENAI_MODEL:''},encoding:'utf8',timeout:10000,windowsHide:true,
 });
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/ENTRY_OK/);
});
test('활성 Vercel 설정은 Express·진입점·시간 예산을 명시한다',()=>{
 const config=require('../vercel.json');assert.equal(config.framework,'express');assert.equal(config.functions['app.js'].maxDuration,120);
 assert.equal(config.buildCommand,'');assert.equal(config.outputDirectory,null);
 assert.match(config.functions['app.js'].includeFiles,/backend\/stimuli/);assert.match(config.functions['app.js'].includeFiles,/public/);
});
