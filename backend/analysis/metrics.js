// 관리자에게 허용된 원자료를 전달받는 순수 분석 함수. 참가자 API에 연결하지 않는다.
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const date=value=>value instanceof Date?value.getTime():typeof value==='string'?Date.parse(value):NaN;
function epoch(e){return e&&finite(e.performance_ms)&&finite(e.performance_time_origin)?e.performance_time_origin+e.performance_ms:date(e?.browser_timestamp);}
function duration(a,b){
 if(!a||!b)return {ms:null,method:'missing'};
 const same=a.page_id&&a.page_id===b.page_id&&finite(a.performance_ms)&&finite(b.performance_ms);
 const ms=same?b.performance_ms-a.performance_ms:date(b.browser_timestamp)-date(a.browser_timestamp);
 return Number.isFinite(ms)&&ms>=0?{ms,method:same?'performance':'browser_wall_fallback'}:{ms:null,method:'invalid_clock_or_order'};
}
function merge(intervals){
 const sorted=intervals.filter(([a,b])=>finite(a)&&finite(b)&&b>=a).sort((a,b)=>a[0]-b[0]),out=[];
 for(const pair of sorted){const last=out.at(-1);if(last&&pair[0]<=last[1])last[1]=Math.max(last[1],pair[1]);else out.push([...pair]);}return out;
}
const length=intervals=>merge(intervals).reduce((sum,[a,b])=>sum+b-a,0);
function overlap(a,b){let result=0;for(const [x,y]of merge(a))for(const [u,v]of merge(b))result+=Math.max(0,Math.min(y,v)-Math.max(x,u));return result;}
function subtract(a,b){let out=merge(a);for(const [u,v]of merge(b)){out=out.flatMap(([x,y])=>v<=x||u>=y?[[x,y]]:[[x,Math.max(x,u)],[Math.min(y,v),y]].filter(([l,r])=>r>l));}return out;}
function interval(a,b){const d=duration(a,b);return d.ms===null?null:[epoch(a),epoch(a)+d.ms];}
function analyzeTask({task,events=[],timings=[],searches=[],sources=[],appOrigin=null}){
 const own=events.filter(e=>e.task_id===task.task_id&&e.participant_id===task.participant_id);
 const browser=own.filter(e=>e.origin==='browser').sort((a,b)=>epoch(a)-epoch(b));
 const pick=(type,id)=>browser.find(e=>e.event_type===type&&e.related_id===id);
 const select=(type,id,stamp)=>browser.find(e=>e.event_type===type&&e.related_id===id&&date(e.browser_timestamp)===date(stamp));
 const waits=[],resultWaits=[],awayIntervals=[],activityIntervals=[];
 const searchRows=searches.filter(s=>s.participant_id===task.participant_id).map(s=>{
  const sent=s.client_submitted_at?select('search_submitted',s.request_id,s.client_submitted_at):null;
  const shown=browser.find(e=>e.event_type==='search_results_presented'&&e.related_id===s.search_event_id&&!e.payload?.restored);
  const lag=duration(sent,shown),span=interval(sent,shown);if(span)resultWaits.push(span);
  const apiMs=date(s.completed_at)-date(s.provider_requested_at);
  return {search_event_id:s.search_event_id,query:s.query,status:s.status,executed_at:s.executed_at,submitted:sent,
   results_presented_at:shown?.browser_timestamp||null,results_render_latency_ms:lag.ms,clock_method:lag.method,provider_latency_ms:Number.isFinite(apiMs)&&apiMs>=0?apiMs:null};
 });
 const chatRows=timings.filter(t=>t.participant_id===task.participant_id).map(t=>{
  const sent=select('question_sent',t.request_id,t.client_submitted_at);
  const first=browser.find(e=>e.event_type==='ai_first_character_observed'&&e.related_id===t.attempt_id&&!e.payload?.restored);
  const last=browser.find(e=>e.event_type==='ai_output_completed_observed'&&e.related_id===t.attempt_id&&!e.payload?.restored);
  let lag=duration(sent,first);
  if(lag.ms===null&&finite(t.first_elapsed_ms)&&!t.restored)lag={ms:t.first_elapsed_ms,method:'existing_browser_performance'};
  const span=interval(sent,first);if(span)waits.push(span);
  const candidates=searchRows.filter(s=>s.submitted&&Number.isFinite(epoch(s.submitted))&&Number.isFinite(epoch(first))&&epoch(s.submitted)>=epoch(first)).sort((a,b)=>epoch(a.submitted)-epoch(b.submitted));
  const firstSearch=candidates[0],searchLag=duration(first,firstSearch?.submitted);
  return {attempt_id:t.attempt_id,request_id:t.request_id,question_at:t.client_submitted_at,first_character_at:t.first_character_at,output_completed_at:t.output_completed_at,
   ai_wait_ms:lag.ms,clock_method:lag.method,output_duration_ms:duration(first,last).ms,
   first_search_after_display_ms:searchLag.ms,first_search_clock_method:searchLag.method,
   search_before_display:Number.isFinite(epoch(sent))&&Number.isFinite(epoch(first))?searchRows.some(s=>s.submitted&&epoch(s.submitted)>=epoch(sent)&&epoch(s.submitted)<epoch(first)):null,restored:Boolean(t.restored)};
 });
 let appHost=null;try{appHost=new URL(appOrigin).hostname.toLowerCase();}catch{}
 const sourceRows=sources.filter(s=>s.participant_id===task.participant_id).map(s=>{
  const click=pick('source_click',s.request_id),left=pick('source_left',s.request_id),returned=pick('source_return',s.request_id);
  const ambiguous=Boolean(left?.payload?.ambiguous||returned?.payload?.ambiguous),restored=Boolean(returned?.payload?.restored);
  const elapsed=duration(click,returned),away=duration(left,returned);
  let hostname=null;try{hostname=new URL(s.source_url).hostname.toLowerCase();}catch{}
  const span=!ambiguous&&!restored&&left&&returned&&(!appHost||hostname!==appHost)?interval(left,returned):null;if(span)awayIntervals.push(span);
  return {source_event_id:s.source_event_id,request_id:s.request_id,url:s.source_url,hostname,is_external:appHost&&hostname?hostname!==appHost:null,
   accessed_at:s.accessed_at,returned_at:returned?.browser_timestamp||s.returned_at||null,
   click_to_return_ms:elapsed.ms,away_ms:away.ms,clock_method:elapsed.method,ambiguous,restored,
   return_observed:Boolean(returned),reading_confirmed:false};
 });
 let openActivities=0;
 for(const begin of browser.filter(e=>e.event_type==='search_activity_start')){
  const end=browser.find(e=>e.event_type==='search_activity_end'&&e.related_id===begin.related_id&&e.page_id===begin.page_id);
  const span=interval(begin,end);if(span)activityIntervals.push(span);else openActivities++;
 }
 const verification=merge([...subtract(activityIntervals,resultWaits),...awayIntervals]);
 const aiMs=length(waits),verificationMs=length(verification),overlapMs=overlap(waits,verification);
  const total=date(task.submitted_at)-date(task.started_at);
 const external=sourceRows.filter(s=>s.is_external===true);
 return {task_id:task.task_id,participant_id:task.participant_id,condition_code:task.condition_code,
  started_at:task.started_at,final_submitted_at:task.submitted_at,total_task_ms:Number.isFinite(total)&&total>=0?total:null,
  search_used:searchRows.length>0,search_attempt_count:searchRows.length,search_api_used:searches.some(s=>s.participant_id===task.participant_id&&s.provider_requested_at),search_api_count:searches.filter(s=>s.participant_id===task.participant_id&&s.provider_requested_at).length,
  source_accessed:sourceRows.length>0,source_click_count:sourceRows.length,unique_source_url_count:new Set(sourceRows.map(s=>s.url)).size,
  external_source_accessed:appHost?external.length>0:null,external_source_click_count:appHost?external.length:null,unique_external_hostname_count:appHost?new Set(external.map(s=>s.hostname)).size:null,
  observed_search_panel_active_ms:length(activityIntervals),observed_search_activity_excluding_result_wait_ms:length(activityIntervals)-overlap(activityIntervals,resultWaits),
  observed_source_away_ms:length(awayIntervals),observed_information_activity_ms:verificationMs,
  observed_ai_wait_union_ms:aiMs,information_activity_during_ai_wait_ms:overlapMs,ai_wait_without_observed_information_activity_ms:aiMs-overlapMs,
  chats:chatRows,searches:searchRows.map(({submitted,...row})=>row),sources:sourceRows,
  quality:{open_search_intervals:openActivities,restored_chat_count:chatRows.filter(c=>c.restored).length,late_after_end_count:own.filter(e=>e.late_after_end).length,
   missing_wait_interval_count:chatRows.length-waits.length,legacy_event_count:own.filter(e=>e.origin==='legacy').length,
   clock_methods:[...new Set([...chatRows,...searchRows,...sourceRows].map(row=>row.clock_method))],
   lifecycle_counts:Object.fromEntries(['tab_hidden','tab_visible','window_blur','window_focus','offline','online','transport_failed','transport_restored','page_exit'].map(type=>[type,browser.filter(e=>e.event_type===type).length])),
   heartbeat_gap_is_only_a_signal:true,external_host_classified:Boolean(appHost),activity_is_observation_not_verification:true},
 };
}
module.exports={analyzeTask,duration,merge,overlap,subtract};
