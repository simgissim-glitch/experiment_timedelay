const {ApiError}=require('../middleware/errors');
const {analyzeTask}=require('../analysis/metrics');
const STEPS=require('../services/workflow').STEPS;
const columns={
 participants:'participant_id,consent,consented_at,condition_code,progress_status,current_step,screening_status,termination_reason,started_at,ended_at,created_at',
 participant_steps:'participant_id,step,started_at,completed_at,timing_source',
 survey_responses:'survey_response_id,participant_id,phase,questionnaire_version,answers,is_draft,revision,submitted_at,created_at',
 chat_messages:'chat_message_id,participant_id,request_id,sequence_number,role,content,created_at',
 chat_timings:'*',search_events:'*',source_events:'*',research_tasks:'*',research_events:'*',
 final_decisions:'final_decision_id,participant_id,product_code,key_specifications,rationale,reference_notes,submitted_at,misinformation_acceptance,assessed_at,assessed_by,coding_revision,adjudication_notes',
 final_decision_codings:'*',
};
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const nums=values=>values.filter(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0);
function safeError(error){
 if(error instanceof ApiError)return error;
 const map={'42501':[503,'ADMIN_DB_PERMISSIONS','관리자 DB 권한 설정을 확인해 주세요.'],'P0002':[404,'FINAL_NOT_FOUND','제출된 최종 답변이 없습니다.'],'40001':[409,'STALE_CODING','다른 연구자가 코딩을 변경했습니다. 새로고침 후 확인해 주세요.'],'22023':[400,'VALIDATION_ERROR','코딩 입력값을 확인해 주세요.']};
 const [status,code,message]=map[error.code]||[503,'ADMIN_DB_UNAVAILABLE','관리자 DB 조회 또는 저장에 실패했습니다.'];return new ApiError(status,code,message);
}
function createAdminRepository({pool,environment,origin}){
 async function run(write,operation){let client;try{
  client=await pool.connect();await client.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query('SET LOCAL ROLE ai_latency_admin');
  const meta=(await client.query('SELECT environment,schema_version FROM ai_latency_private.deployment_context WHERE singleton')).rows[0];
  if(meta?.environment!==environment||meta?.schema_version!==10)throw new ApiError(503,'ADMIN_DB_NOT_READY','관리자 DB 환경과 마이그레이션 상태를 확인해 주세요.');
  const result=await operation(client);await client.query('COMMIT');return result;
 }catch(error){if(client)try{await client.query('ROLLBACK');}catch{}throw safeError(error);}finally{client?.release();}}
 return {
  snapshot:()=>run(false,async client=>{const result={environment,origin,snapshot_at:new Date().toISOString()};
   for(const[table,fields]of Object.entries(columns)){
    const rows=(await client.query(`SELECT ${fields} FROM ai_latency_private.${table} ORDER BY 1 LIMIT 100001`)).rows;
    if(rows.length>100000)throw new ApiError(503,'ADMIN_EXPORT_LIMIT','조회량이 운영 한도를 초과했습니다. 연구자용 DB 분석 도구를 사용해 주세요.');result[table]=rows;
   }return result;
  }),
  code:(pid,data,actor)=>run(true,async client=>(await client.query('SELECT ai_latency_private.admin_code_final($1,$2,$3,$4,$5,$6) AS result',[pid,data.code,data.notes,data.revision,actor,data.request_id])).rows[0].result),
 };
}
function participantRows(s){return s.participants.map(p=>{
 const own=table=>s[table].filter(row=>row.participant_id===p.participant_id);
 const task=own('research_tasks')[0];const pre=own('survey_responses').find(r=>r.phase==='pre'),post=own('survey_responses').find(r=>r.phase==='post'),final=own('final_decisions')[0];
 const analysis=task?analyzeTask({task:{...task,condition_code:p.condition_code},events:own('research_events'),timings:own('chat_timings'),searches:own('search_events'),sources:own('source_events'),appOrigin:s.origin}):null;
 const delays=nums(analysis?.chats.map(c=>c.ai_wait_ms)||[]);
 return {environment:s.environment,snapshot_at:s.snapshot_at,...p,task_id:task?.task_id||null,task_started_at:task?.started_at||null,final_submitted_at:final?.submitted_at||null,
  total_task_ms:analysis?.total_task_ms??null,actual_delay_mean_ms:mean(delays),actual_delay_observations:delays.length,
  search_attempt_count:own('search_events').length,search_api_count:own('search_events').filter(r=>r.provider_requested_at).length,
  search_success_count:own('search_events').filter(r=>r.status==='completed').length,source_click_count:own('source_events').length,
  external_source_click_count:analysis?.external_source_click_count??null,unique_source_url_count:new Set(own('source_events').map(r=>r.source_url)).size,
  pre_answers:pre?.answers||null,pre_is_draft:pre?.is_draft??null,pre_version:pre?.questionnaire_version||null,
  selected_product:final?.product_code||null,key_specifications:final?.key_specifications||null,rationale:final?.rationale||null,reference_notes:final?.reference_notes??null,
  misinformation_acceptance:final?.misinformation_acceptance||null,coding_revision:final?.coding_revision??null,adjudication_notes:final?.adjudication_notes??null,assessed_at:final?.assessed_at||null,assessed_by:final?.assessed_by||null,
  post_answers:post?.answers||null,post_version:post?.questionnaire_version||null,post_submitted_at:post?.submitted_at||null,
  information_activity_ms:analysis?.observed_information_activity_ms??null,ai_wait_union_ms:analysis?.observed_ai_wait_union_ms??null,
  step_times:own('participant_steps'),quality:analysis?.quality||null,
 };
});}
function overview(s){const rows=participantRows(s),active=p=>!['completed','withdrawn','ineligible','declined'].includes(p.progress_status);
 const conditions=['A','B','C'].map((code,index)=>{
  const group=rows.filter(p=>p.condition_code===code),n=group.length,done=group.filter(p=>p.progress_status==='completed').length;
  const observations=group.flatMap(p=>{const task=s.research_tasks.find(t=>t.participant_id===p.participant_id);return task?nums(analyzeTask({task:{...task,condition_code:code},events:s.research_events,timings:s.chat_timings,searches:[],sources:[]}).chats.map(c=>c.ai_wait_ms)):[];});
  return {condition:code,target_seconds:[2,9,20][index],assigned:n,completed:done,completion_rate:n?done/n:null,actual_delay_mean_ms:mean(observations),actual_delay_observations:observations.length,
   search_users:group.filter(p=>p.search_attempt_count>0).length,search_attempts:group.reduce((sum,p)=>sum+p.search_attempt_count,0),
   source_users:group.filter(p=>p.source_click_count>0).length,source_clicks:group.reduce((sum,p)=>sum+p.source_click_count,0)};
 });
 return {environment:s.environment,snapshot_at:s.snapshot_at,total:rows.length,completed:rows.filter(p=>p.progress_status==='completed').length,in_progress:rows.filter(active).length,withdrawn:rows.filter(p=>p.progress_status==='withdrawn').length,ineligible:rows.filter(p=>p.progress_status==='ineligible').length,declined:rows.filter(p=>p.progress_status==='declined').length,conditions,
  steps:STEPS.map(step=>{const reached=s.participant_steps.filter(r=>r.step===step);return {step,reached:reached.length,completed:reached.filter(r=>r.completed_at).length,
   ended_incomplete:reached.filter(r=>!r.completed_at&&rows.some(p=>p.participant_id===r.participant_id&&['withdrawn','ineligible','declined'].includes(p.progress_status))).length,
   active_incomplete:reached.filter(r=>!r.completed_at&&rows.some(p=>p.participant_id===r.participant_id&&active(p))).length};}),
  search:{attempts:s.search_events.length,provider_requests:s.search_events.filter(r=>r.provider_requested_at).length,successful:s.search_events.filter(r=>r.status==='completed').length,failed:s.search_events.filter(r=>r.status==='failed').length,source_clicks:s.source_events.length,source_returns:s.source_events.filter(r=>r.returned_at).length,external_source_clicks:rows.some(r=>r.external_source_click_count!==null)?rows.reduce((sum,r)=>sum+(r.external_source_click_count||0),0):null},
 };
}
function detail(s,pid){const participant=participantRows(s).find(p=>p.participant_id===pid);if(!participant)throw new ApiError(404,'PARTICIPANT_NOT_FOUND','참가자를 찾을 수 없습니다.');
 const result={environment:s.environment,snapshot_at:s.snapshot_at,participant};for(const table of Object.keys(columns).filter(t=>t!=='participants'))result[table]=s[table].filter(r=>r.participant_id===pid);return result;
}
module.exports={createAdminRepository,participantRows,overview,detail};
