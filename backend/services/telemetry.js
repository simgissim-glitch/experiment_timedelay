const {ApiError}=require('../middleware/errors');
const {validToken,tokenHash}=require('./enrollment');
const {validSourceURL}=require('../search/provider');
const {isRecord}=require('../middleware/validate');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const types=new Set(['question_sent','ai_first_character_observed','ai_output_completed_observed','search_submitted','search_results_presented','search_activity_start','search_activity_end','source_click','source_left','source_return','tab_hidden','tab_visible','window_blur','window_focus','offline','online','transport_failed','transport_restored','page_exit','page_start','heartbeat']);
const keys=['event_id','task_id','type','browser_timestamp','page_id','performance_ms','performance_time_origin','related_type','related_id','payload'];
const payloadKeys=['request_id','delivery_id','search_event_id','url','query','reason','restored','visibility','focused','connection','ambiguous','result_count'];
function validEvent(e){
 if(!isRecord(e)||Object.keys(e).some(k=>!keys.includes(k))||!keys.every(k=>Object.hasOwn(e,k))||!uuid(e.event_id)||!uuid(e.task_id)||!uuid(e.page_id)||!types.has(e.type))return false;
 if(typeof e.browser_timestamp!=='string'||e.browser_timestamp.length>40||!/^\d{4}-\d{2}-\d{2}T/.test(e.browser_timestamp)||!Number.isFinite(Date.parse(e.browser_timestamp)))return false;
 if(!Number.isFinite(e.performance_ms)||e.performance_ms<0||e.performance_ms>=1e12||!Number.isFinite(e.performance_time_origin)||e.performance_time_origin<=0||e.performance_time_origin>=1e15)return false;
 if(![null,'chat_request','chat_attempt','search_request','search_event','source_click','search_activity','task','transport'].includes(e.related_type)||(e.related_id!==null&&!uuid(e.related_id)))return false;
 const expected={question_sent:'chat_request',ai_first_character_observed:'chat_attempt',ai_output_completed_observed:'chat_attempt',search_submitted:'search_request',search_results_presented:'search_event',source_click:'source_click',source_left:'source_click',source_return:'source_click',search_activity_start:'search_activity',search_activity_end:'search_activity'}[e.type];
 if(expected&&(e.related_type!==expected||!uuid(e.related_id)))return false;
 if(!isRecord(e.payload)||Object.keys(e.payload).some(k=>!payloadKeys.includes(k))||JSON.stringify(e.payload).length>6000)return false;
 for(const [k,v]of Object.entries(e.payload)){
  if(['request_id','delivery_id','search_event_id'].includes(k)&&!uuid(v))return false;
  if(k==='url'&&!validSourceURL(v))return false;
  if(k==='query'&&(typeof v!=='string'||v.length>600))return false;
  if(['restored','focused','ambiguous'].includes(k)&&typeof v!=='boolean')return false;
  if(k==='result_count'&&(!Number.isInteger(v)||v<0||v>20))return false;
  if(['reason','visibility','connection'].includes(k)&&(typeof v!=='string'||v.length>100))return false;
 }
 return true;
}
function createTelemetryService(repository){
 function hash(token){if(!validToken(token))throw new ApiError(401,'SESSION_INVALID','참여 세션을 확인해 주세요.');return tokenHash(token);}
 return {context:token=>repository.telemetry('context',hash(token)),async ingest(token,events){
  if(!Array.isArray(events)||events.length<1||events.length>20||!events.every(validEvent))throw new ApiError(400,'VALIDATION_ERROR','기록 형식을 확인해 주세요.');
  return repository.telemetry('ingest',hash(token),[JSON.stringify(events)]);
 }};
}
module.exports={createTelemetryService,validEvent};
