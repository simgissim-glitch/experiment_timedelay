'use strict';
window.createExperimentChat=function(onChange) {
  const input=document.getElementById('chat-input'),send=document.getElementById('chat-send');
  const cancel=document.getElementById('chat-cancel'),retry=document.getElementById('chat-retry');
  const log=document.getElementById('chat-messages'),status=document.getElementById('chat-status'),loading=document.getElementById('chat-loading');
  const starts=new Map(),rendered=new Set();
  let active=false,busy=false,loaded=false,controller,pollTimer,operation=null,version=0,working=false,initialRequired=false,initialQuestion='';
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  async function visible(){while(document.visibilityState!=='visible'){await new Promise(resolve=>document.addEventListener('visibilitychange',resolve,{once:true}));}}
  async function api(body,signal) {
    const res=await fetch('/api/participant/conversations',{method:body?'POST':'GET',credentials:'same-origin',signal,
      headers:body?{'Content-Type':'application/json','X-Experiment-Request':'1'}:{},...(body?{body:JSON.stringify(body)}:{})});
    const data=await res.json();if(!res.ok)throw Error(data.error?.message||'대화 요청을 확인하지 못했습니다.');return data;
  }
  function controls(notify=true){
    input.readOnly=initialRequired;
    input.disabled=!active||busy||working;send.disabled=!active||busy||working||!input.value.trim()||operation?.message===input.value.trim();
    // 전송 이후 서버 작업은 연결과 독립적으로 완료한다. 중단 버튼은 참여 중단과 혼동하지 않도록 숨긴다.
    cancel.hidden=true;retry.hidden=!active||busy||working||!operation;loading.hidden=!active||!busy;
    if(notify)onChange?.();
  }
  function stamp(message,event){
    const candidate=starts.get(message.request_id);
    const start=candidate&&Date.parse(candidate.submitted_at)===Date.parse(message.submitted_at)?candidate.performance:null;
    const payload={delivery_id:message.delivery_id,event,at:new Date().toISOString(),
      elapsed_ms:start?performance.now()-start:null,restored:!start};
    window.experimentTelemetry?.event(event==='first-character'?'ai_first_character_observed':'ai_output_completed_observed',
      {request_id:message.request_id,restored:!start},{related_type:'chat_attempt',related_id:message.delivery_id,browser_timestamp:payload.at});
    return payload;
  }
  async function report(payload){
    // 같은 이벤트는 DB에서 한 번만 기록한다. 전송 실패 시 다음 조회에도 재시도한다.
    const key='chat-paint:'+payload.delivery_id+':'+payload.event;
    try{sessionStorage.setItem(key,JSON.stringify(payload));}catch{}
    window.dispatchEvent(new CustomEvent('experiment:chat-presentation',{detail:payload}));
    await deliver(key,payload);
  }
  async function deliver(key,payload){
    if(window.experimentTelemetry){const recorded=await window.experimentTelemetry.enqueue('presentation',payload);if(recorded){try{sessionStorage.removeItem(key);}catch{}}return;}
    try{
      const res=await fetch('/api/participant/conversations/presentation',{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json','X-Experiment-Request':'1'},body:JSON.stringify(payload),keepalive:true});
      if(res.ok){try{sessionStorage.removeItem(key);}catch{}}
      else status.textContent='표시 기록을 저장하지 못했습니다. 연결 상태를 확인해 주세요.';
    }catch{status.textContent='표시 기록을 저장하지 못했습니다. 연결 상태를 확인해 주세요.';}
  }
  async function flushReports(){
    try{for(const key of Object.keys(sessionStorage).filter(k=>k.startsWith('chat-paint:')).sort((a,b)=>Number(a.endsWith('output-completed'))-Number(b.endsWith('output-completed'))))await deliver(key,JSON.parse(sessionStorage.getItem(key)));}catch{}
  }
  async function display(data){
    initialRequired=data.initial_required===true;initialQuestion=data.initial_question||'';
    if(initialRequired){input.value=initialQuestion;input.dispatchEvent(new Event('input',{bubbles:true}));}
    const ownVersion=++version;log.replaceChildren();
    const last=data.requests.at(-1);busy=last?.status==='pending';operation=null;
    const animations=[];
    for(const message of data.messages){
      const box=document.createElement('article');box.className='chat-message chat-message--'+message.role;
      const author=document.createElement('p');author.className='chat-message__author';author.textContent=message.role==='user'?'나':'AI';
      const text=document.createElement('p');box.append(author,text);log.append(box);
      if(message.role==='assistant'&&message.delivery_id&&!message.presented&&!rendered.has(message.delivery_id))animations.push({message,text,box});
      else {
        text.textContent=message.content;
        if(message.role==='assistant'&&message.delivery_id&&message.presented&&!message.output_completed){
          // 출력 도중 새로고침한 경우 기존 최초 표시 기록을 유지하고 복원 완료만 기록한다.
          await visible();await frame();await sleep(0);await report(stamp(message,'output-completed'));
        }
      }
    }
    if(!data.messages.length){const p=document.createElement('p');p.textContent='메시지를 보내면 대화를 시작할 수 있습니다.';log.append(p);}
    if(last&&['failed','interrupted'].includes(last.status)&&last.attempts<3){
      operation={request_id:last.request_id,message:data.messages.find(m=>m.request_id===last.request_id&&m.role==='user').content,retry:true};
    }
    status.textContent=operation?'응답이 완료되지 않았습니다. 다시 시도할 수 있습니다.':'';
    if(animations.length)busy=true;controls();
    for(const {message,text,box} of animations){
      const chars=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(message.content)].map(s=>s.segment):Array.from(message.content);
      await visible();await frame();if(!active||version!==ownVersion)return;
      text.textContent=chars[0]||'';loading.hidden=true;box.scrollIntoView({block:'nearest'});
      // 다음 렌더링 기회 이후 확인한다. 물리적 모니터 출력 시각의 직접 측정은 아니다.
      await frame();await sleep(0);if(!active||version!==ownVersion)return;
      const first=stamp(message,'first-character');const firstSaved=report(first);
      for(let i=1;i<chars.length;i++){
        await sleep(20);await visible();if(!active||version!==ownVersion)return;
        text.append(chars[i]);log.scrollTop=log.scrollHeight;
      }
      await frame();await sleep(0);
      const complete=stamp(message,'output-completed');
      await firstSaved;await report(complete);rendered.add(message.delivery_id);
    }
    busy=last?.status==='pending';controls();
    if(busy&&active){clearTimeout(pollTimer);pollTimer=setTimeout(refresh,200);}
  }
  async function refresh(){
    if(working)return;
    working=true;controls();
    try{await flushReports();await display(await api());loaded=true;}
    catch(error){busy=false;status.textContent=error.message;controls();}
    finally{working=false;controls();}
  }
  async function submit(isRetry=false){
    if(!active||busy||working)return;
    const body=isRetry?{...operation}:{request_id:crypto.randomUUID(),message:initialRequired?initialQuestion:input.value.trim()};
    if(!body?.message)return;
    const start=performance.now();body.submitted_at=new Date().toISOString();starts.set(body.request_id,{performance:start,submitted_at:body.submitted_at});
    window.experimentTelemetry?.event('question_sent',{}, {related_type:'chat_request',related_id:body.request_id,browser_timestamp:body.submitted_at});
    operation=body;busy=true;working=true;clearTimeout(pollTimer);controller=new AbortController();status.textContent='';controls();
    const box=document.createElement('article');box.className='chat-message chat-message--user';
    const text=document.createElement('p');text.textContent=body.message;box.append(text);if(!isRetry)log.append(box);
    try{
      const data=await api(body,controller.signal);
      input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));await display(data);
    }catch(error){
      busy=false;status.textContent='요청 상태를 확인하지 못했습니다. 다시 시도하면 같은 요청을 확인합니다.';
      operation={...body,retry:true};
      try{const data=await api();if(data.requests.some(r=>r.request_id===body.request_id))await display(data);}catch{}
    }finally{controller=null;working=false;controls();if(busy&&active){clearTimeout(pollTimer);pollTimer=setTimeout(refresh,200);}}
  }
  send.addEventListener('click',()=>submit());retry.addEventListener('click',()=>submit(true));input.addEventListener('input',()=>controls());
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();submit();}});
  window.addEventListener('online',()=>{if(active)refresh();});
  return {
    get busy(){return busy||working;},
    update(enabled){const changed=active!==Boolean(enabled);active=Boolean(enabled);if(!active){clearTimeout(pollTimer);version++;loaded=false;}controls(false);if(active&&(!loaded||changed)&&!working){loaded=true;refresh();}},
    cancel(){active=false;version++;clearTimeout(pollTimer);},
  };
};
