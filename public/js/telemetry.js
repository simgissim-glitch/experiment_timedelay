'use strict';
(() => {
 const pageId=crypto.randomUUID(),memory=new Map(),buffer=[],sources=new Map(),inFlight=new Set();
 const dbPromise=new Promise((resolve,reject)=>{const request=indexedDB.open('experiment-records-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('outbox',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}).catch(()=>null);
 let taskId=null,enabled=false,collecting=false,contextPending=false,sending=false,timer,failed=false,activity=null;
 const status=document.getElementById('recording-status'),retry=document.getElementById('recording-retry');
 const key='experiment-pending-records';
 try{for(const item of JSON.parse(sessionStorage.getItem(key)||'[]'))memory.set(item.id,item);}catch{}
 function notice(text=''){status.textContent=text;status.hidden=!text;retry.hidden=!text;}
 function mirror(){try{sessionStorage.setItem(key,JSON.stringify([...memory.values()]));}catch{notice('이 브라우저에 일부 기록을 보관하지 못했습니다. 연결 상태를 확인해 주세요.');}}
 async function store(action,item){
  const db=await dbPromise;if(!db){mirror();return;}
  await new Promise((resolve,reject)=>{const tx=db.transaction('outbox','readwrite');const table=tx.objectStore('outbox');action==='put'?table.put(item):table.delete(item.id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);}).catch(()=>{notice('기록을 보관하지 못했습니다. 다시 전송해 주세요.');});
 }
 async function all(){
  const db=await dbPromise;if(db)await new Promise(resolve=>{const request=db.transaction('outbox').objectStore('outbox').getAll();request.onsuccess=()=>{for(const item of request.result)if(!memory.has(item.id))memory.set(item.id,item);resolve();};request.onerror=resolve;});
  return [...memory.values()].filter(item=>item.task_id===taskId&&!inFlight.has(item.id)).sort((a,b)=>a.order-b.order);
 }
 function snapshot(timestamp){return {browser_timestamp:timestamp||new Date().toISOString(),page_id:pageId,performance_ms:performance.now(),performance_time_origin:performance.timeOrigin};}
 function schedule(delay=50){clearTimeout(timer);timer=setTimeout(flush,delay);}
 async function persist(item){memory.set(item.id,item);mirror();await store('put',item);schedule();}
 function event(type,payload={},options={}){
  if(!enabled&&!collecting)return null;
  const captured={event_id:crypto.randomUUID(),type,...snapshot(options.browser_timestamp),related_type:options.related_type||null,related_id:options.related_id||null,payload};
  if(!taskId){buffer.push({kind:'event',body:captured});return captured.event_id;}
  captured.task_id=taskId;
  void persist({id:captured.event_id,task_id:taskId,kind:'event',body:captured,order:performance.timeOrigin+performance.now()});
  return captured.event_id;
 }
 async function enqueue(kind,body){
  if(!taskId){buffer.push({kind,body});return Promise.resolve(false);}
  const id=kind==='source'?'source:'+body.request_id:'paint:'+body.delivery_id+':'+body.event;
  inFlight.add(id);
  try{
   await persist({id,task_id:taskId,kind,body,order:performance.timeOrigin+performance.now()});
   const result=await post(kind==='source'?'searches/sources':'conversations/presentation',body);
   if(result.recorded!==true)throw Error('missing acknowledgement');
   memory.delete(id);await store('delete',{id});mirror();return true;
  }catch{notice('연결이 불안정합니다. 기록을 보관하고 다시 전송하겠습니다.');return false;}
  finally{inFlight.delete(id);schedule(1000);}
 }
 async function post(path,body){
  const response=await fetch('/api/participant/'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Experiment-Request':'1'},body:JSON.stringify(body),keepalive:true,signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('recording failed');return response.json();
 }
 async function flush(){
  if(sending||!taskId)return false;sending=true;clearTimeout(timer);
  try{
   const pending=await all();
   for(let i=0;i<pending.length;){
    let group=[pending[i]],result;
    if(group[0].kind==='event'){
     while(group.length<5&&pending[i+group.length]?.kind==='event')group.push(pending[i+group.length]);
     result=await post('logs',{events:group.map(item=>item.body)});
     if(!group.every(item=>result.acknowledged?.includes(item.id)))throw Error('missing acknowledgement');
    }else{result=await post(group[0].kind==='source'?'searches/sources':'conversations/presentation',group[0].body);if(result.recorded!==true)throw Error('missing acknowledgement');}
    for(const item of group){memory.delete(item.id);await store('delete',item);}mirror();i+=group.length;
   }
   notice();if(failed){failed=false;event('transport_restored',{connection:'acknowledged'});}
   return true;
  }catch{
   notice('연결이 불안정합니다. 기록을 보관하고 다시 전송하겠습니다.');
   if(!failed){failed=true;event('transport_failed',{connection:'request_failed'});}
   return false;
  }finally{sending=false;if(taskId)schedule(failed?5000:15000);}
 }
 function saveSources(){if(!taskId)return;try{sessionStorage.setItem('experiment-sources:'+taskId,JSON.stringify([...sources.values()]));}catch{}}
 function trackSource(body){
  sources.set(body.request_id,{request_id:body.request_id,url:body.source_url,page_id:pageId,left:false,ambiguous:false});saveSources();
  event('source_click',{url:body.source_url,search_event_id:body.search_event_id},{related_type:'source_click',related_id:body.request_id,browser_timestamp:body.clicked_at});
  setTimeout(()=>{const item=sources.get(body.request_id);if(item&&!item.left&&document.visibilityState==='visible'&&document.hasFocus()){sources.delete(body.request_id);saveSources();}},1500);
 }
 function away(reason){
  if(!collecting)return;
  const candidates=[...sources.values()].filter(item=>!item.left);
  for(const item of candidates){item.left=true;item.ambiguous=sources.size>1;
   event('source_left',{url:item.url,reason,ambiguous:item.ambiguous,restored:item.page_id!==pageId},{related_type:'source_click',related_id:item.request_id});
  }saveSources();
 }
 function returned(){
  if(!collecting||document.visibilityState!=='visible'||!document.hasFocus())return;
  for(const item of sources.values())if(item.left){event('source_return',{url:item.url,ambiguous:item.ambiguous,restored:item.page_id!==pageId},{related_type:'source_click',related_id:item.request_id});sources.delete(item.request_id);}saveSources();
 }
 function startActivity(reason){if(!collecting||activity||document.visibilityState!=='visible'||!document.hasFocus())return;activity=crypto.randomUUID();event('search_activity_start',{reason},{related_type:'search_activity',related_id:activity});}
 function endActivity(reason){if(!activity)return;event('search_activity_end',{reason},{related_type:'search_activity',related_id:activity});activity=null;}
 const panel=document.getElementById('search-panel');
 panel.addEventListener('focusin',()=>startActivity('focus'));
 panel.addEventListener('focusout',()=>setTimeout(()=>{if(!panel.contains(document.activeElement))endActivity('focus_out');},0));
 document.addEventListener('pointerdown',e=>panel.contains(e.target)?startActivity('pointer'):endActivity('pointer_out'));
 document.addEventListener('visibilitychange',()=>{
  if(!collecting)return;event(document.visibilityState==='hidden'?'tab_hidden':'tab_visible',{visibility:document.visibilityState});
  if(document.visibilityState==='hidden'){endActivity('hidden');away('hidden');void flush();}else{returned();if(panel.contains(document.activeElement))startActivity('visible_resume');void flush();}
 });
 window.addEventListener('blur',()=>{if(collecting){event('window_blur',{focused:false});endActivity('blur');away('blur');}});
 window.addEventListener('focus',()=>{if(collecting){event('window_focus',{focused:true});returned();if(panel.contains(document.activeElement))startActivity('focus_resume');void flush();}});
 window.addEventListener('offline',()=>{if(collecting)event('offline',{connection:'navigator_offline'});});
 window.addEventListener('online',()=>{if(collecting)event('online',{connection:'navigator_online'});void flush();});
 window.addEventListener('pagehide',()=>{if(collecting){endActivity('page_exit');away('page_exit');event('page_exit',{reason:'pagehide'});void flush();}});
 window.addEventListener('pageshow',e=>{if(collecting&&e.persisted){event('page_start',{restored:true});returned();void flush();}});
 async function context(){
  if(contextPending)return;contextPending=true;
  try{
   const response=await fetch('/api/participant/logs/context',{credentials:'same-origin',signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw Error('context unavailable');const data=await response.json();
   taskId=data.task_id;collecting=enabled&&data.active;
   if(collecting){try{for(const item of JSON.parse(sessionStorage.getItem('experiment-sources:'+taskId)||'[]'))sources.set(item.request_id,item);}catch{}
    event('page_start',{restored:false,visibility:document.visibilityState,focused:document.hasFocus()});
    returned();
   }
   if(taskId)for(const item of buffer.splice(0)){if(item.kind==='event'){item.body.task_id=taskId;await persist({id:item.body.event_id,task_id:taskId,...item,order:item.body.performance_time_origin+item.body.performance_ms});}else await enqueue(item.kind,item.body);}
   await flush();
  }catch{notice('기록 서버에 연결하지 못했습니다. 다시 시도하겠습니다.');setTimeout(()=>{if(enabled)void context();},5000);}
  finally{contextPending=false;}
 }
 retry.addEventListener('click',()=>taskId?flush():context());
 setInterval(()=>{if(collecting){event('heartbeat',{visibility:document.visibilityState,focused:document.hasFocus()});void flush();}},15000);
 window.experimentTelemetry={event,enqueue,trackSource,flush,
  update(value){const next=Boolean(value);if(enabled===next)return;
   if(!next){endActivity('scope_exit');event('page_exit',{reason:'workspace_exit'});collecting=false;}
   enabled=next;if(next){if(taskId){collecting=true;event('page_start',{restored:true});returned();void flush();}else void context();}else void flush();
  },
 };
})();
