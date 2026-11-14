const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
test('Empty-test bootstrap applies all migrations atomically and rejects reruns',async()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../deploy/neon-test-init.sql'),'utf8');
 const db=new PGlite();
 try{
  await db.exec(sql);
  const result=await db.query('SELECT environment,schema_version FROM ai_latency_private.deployment_context');
  assert.deepEqual(result.rows,[{environment:'test',schema_version:10}]);
  await db.query("SELECT ai_latency_private.enrollment_create_session($1,3600)",['a'.repeat(64)]);
  await assert.rejects(db.exec(sql),/already exists/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM ai_latency_private.participant_sessions')).rows[0].n,1);
 }finally{await db.close();}
});
