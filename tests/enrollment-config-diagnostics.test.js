const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
test('Configuration diagnostics identify settings without exposing secrets',()=>{
 for(const [overrides,code,stage] of [
  [{DB_ENV:'invalid'},'DB_CONFIG_INVALID','DATABASE_SETTINGS'],
  [{DB_ENV:'test',TEST_DATABASE_URL:'postgres://fixture:secret-marker@remote/test',APP_ORIGIN:'https://example.org/'},'APP_ORIGIN_INVALID','APP_ORIGIN_SETTINGS'],
 ]){
  const r=spawnSync(process.execPath,['-e',"try{require('./backend/services/enrollment-provider').createEnrollmentProvider()()}catch(e){console.log(JSON.stringify({code:e.code,details:e.details,message:e.message}))}"],{
   cwd:path.join(__dirname,'..'),env:{...process.env,VERCEL:'1',SERVER_ENV_SOURCE:'platform',...overrides},encoding:'utf8',windowsHide:true,
  });
  assert.equal(r.status,0);const d=JSON.parse(r.stdout);assert.equal(d.code,code);assert.equal(d.details.stage,stage);assert.ok(!r.stdout.includes('secret-marker'));assert.ok(!r.stdout.includes('postgres://'));
 }
});
