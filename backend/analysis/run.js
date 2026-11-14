const fs=require('node:fs');
const path=require('node:path');
const dotenv=require('dotenv');
const {parseDatabaseConfig}=require('../database/config');
const {createPool}=require('../database/connection');
const {analyzeTask}=require('./metrics');
(async()=>{
 let pool,client;
 try{
  const id=process.argv[2];if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))throw {code:'TASK_ID_REQUIRED'};
  const values=dotenv.parse(fs.readFileSync(path.join(__dirname,'../..','.env')));
  if(!values.ANALYSIS_DATABASE_URL)throw {code:'ANALYSIS_DB_NOT_CONFIGURED'};
  const key=values.DB_ENV==='research'?'DATABASE_URL':'TEST_DATABASE_URL';
  const config=parseDatabaseConfig({...values,[key]:values.ANALYSIS_DATABASE_URL});
  pool=createPool(config);pool.on('error',()=>{});client=await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const meta=(await client.query('SELECT environment,schema_version FROM ai_latency_private.deployment_context WHERE singleton')).rows[0];
  if(meta?.environment!==config.environment||meta?.schema_version!==10)throw {code:'DB_NOT_READY'};
  const allowed=(await client.query("SELECT has_table_privilege(current_user,'ai_latency_private.research_events','SELECT') AS allowed")).rows[0].allowed;
  if(!allowed)throw {code:'ANALYSIS_ACCESS_DENIED'};
  const task=(await client.query('SELECT * FROM ai_latency_private.research_task_summary WHERE task_id=$1',[id])).rows[0];
  if(!task)throw {code:'TASK_NOT_FOUND'};
  const records={task,appOrigin:values.APP_ORIGIN};
  for(const [name,table,column,param]of [['events','research_events','task_id',id],['timings','chat_timings','participant_id',task.participant_id],['searches','search_events','participant_id',task.participant_id],['sources','source_events','participant_id',task.participant_id]])records[name]=(await client.query(`SELECT * FROM ai_latency_private.${table} WHERE ${column}=$1`,[param])).rows;
  const report=analyzeTask(records);await client.query('COMMIT');console.log(JSON.stringify(report,null,2));
 }catch(error){try{await client?.query('ROLLBACK');}catch{}console.error(JSON.stringify({status:'error',code:error.code==='42501'?'ANALYSIS_ACCESS_DENIED':/^[A-Z_]+$/.test(error.code||'')?error.code:'ANALYSIS_FAILED'}));process.exitCode=1;}
 finally{client?.release();await pool?.end();}
})();
