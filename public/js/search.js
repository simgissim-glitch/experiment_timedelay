'use strict';
window.createExperimentSearch=function(onChange){
  const input=document.getElementById('search-query'),button=document.getElementById('search-submit');
  const list=document.getElementById('search-result-list'),status=document.getElementById('search-status');
  let active=false,busy=false,loaded=false,poll,version=0,operation=null,operationQuery='',resultObserver=null,observeVisible=null;
  const pendingClicks=new Map(),presented=new Set(),started=new Set();
  function controls(notify=false){input.disabled=!active||busy;button.disabled=!active||busy||!input.value.trim();if(notify)onChange?.();}
  async function request(path,body){
    const res=await fetch('/api/participant/searches'+path,{method:body?'POST':'GET',credentials:'same-origin',
      headers:body?{'Content-Type':'application/json','X-Experiment-Request':'1'}:{},...(body?{body:JSON.stringify(body),keepalive:path==='/sources'}:{})});
    const data=await res.json();if(!res.ok)throw Error(data.error?.message||'검색 요청을 처리하지 못했습니다.');return data;
  }
  async function saveClick(body){
    if(window.experimentTelemetry){window.experimentTelemetry.trackSource(body);await window.experimentTelemetry.enqueue('source',body);return;}
    pendingClicks.set(body.request_id,body);
    try{await request('/sources',body);pendingClicks.delete(body.request_id);}catch{status.textContent='출처 클릭 기록을 저장하지 못했습니다. 연결 상태를 확인해 주세요.';}
  }
  function display(data){
    resultObserver?.disconnect();observeVisible=null;
    list.replaceChildren();
    if(!data){const p=document.createElement('p');p.textContent='검색어를 입력하면 검색 결과가 여기에 표시됩니다.';list.append(p);return;}
    operation=data.request_id;operationQuery=data.query;
    if(!input.value)input.value=data.query;
    if(data.status==='pending'){
      status.textContent='검색 중입니다.';busy=true;clearTimeout(poll);poll=setTimeout(refresh,500);return;
    }
    if(data.status==='failed'){
      operation=null;
      status.textContent=data.error_code==='SEARCH_NOT_CONFIGURED'?'검색 서비스가 아직 연결되지 않았습니다.':'검색 요청에 실패했습니다. 다시 검색할 수 있습니다.';
      return;
    }
    const ol=document.createElement('ol');ol.className='search-result-list';
    for(const result of data.results){
      const li=document.createElement('li');li.value=result.rank;
      const link=document.createElement('a');link.href=result.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=result.title;
      const description=document.createElement('p');description.textContent=result.description||'설명이 제공되지 않았습니다.';
      const url=document.createElement('p');url.className='search-result-url';url.textContent=result.url;
      const click=event=>{
        if(event.type==='click'&&event.button!==0)return;
        if(event.type==='auxclick'&&event.button!==1)return;
        if(!active){event.preventDefault();return;}
        void saveClick({request_id:crypto.randomUUID(),search_event_id:data.search_event_id,rank:result.rank,source_url:result.url,clicked_at:new Date().toISOString()});
        // 기본 링크 동작을 유지해 팝업 차단 없이 새 탭으로 연다.
      };
      link.addEventListener('click',click);link.addEventListener('auxclick',click);
      li.append(link,description,url);ol.append(li);
    }
    list.append(ol);status.textContent=data.results.length?`${data.query} 검색 결과 ${data.results.length}개`:'검색 결과가 없습니다.';
    if(!presented.has(data.search_event_id)){
      const target=data.results.length?ol:status;
      observeVisible=()=>{
        const rect=target.getBoundingClientRect();
        if(!active||document.visibilityState!=='visible'||presented.has(data.search_event_id)||!target.isConnected||rect.width<=0||rect.height<=0||rect.bottom<=0||rect.top>=innerHeight||rect.right<=0||rect.left>=innerWidth)return;
        requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>{
          if(!active||document.visibilityState!=='visible'||presented.has(data.search_event_id)||!target.isConnected)return;
          const current=target.getBoundingClientRect();if(current.bottom<=0||current.top>=innerHeight||current.right<=0||current.left>=innerWidth)return;
          window.experimentTelemetry?.event('search_results_presented',{request_id:data.request_id,result_count:data.results.length,restored:!started.has(data.request_id)}, {related_type:'search_event',related_id:data.search_event_id});
          presented.add(data.search_event_id);resultObserver?.disconnect();
        },0)));
      };
      resultObserver=new IntersectionObserver(observeVisible);resultObserver.observe(target);observeVisible();
    }
    operation=null;
  }
  async function refresh(){
    const own=version;
    try{const data=await request('');if(active&&version===own){busy=false;display(data);}}
    catch(error){if(active&&version===own){busy=false;status.textContent=error.message;}}
    finally{if(active&&version===own)controls(true);}
  }
  async function submit(){
    if(!active||busy)return;
    const query=input.value.trim();if(!query)return;
    if(query.length>600||query.split(/\s+/u).length>75){status.textContent='검색어는 600자, 75단어 이하로 입력해 주세요.';return;}
    // 응답 유실 시 같은 키를 재사용하고, 명확한 실패가 확인되면 새 검색으로 시도한다.
    if(!operation||operationQuery!==query){operation=crypto.randomUUID();operationQuery=query;}
    const own=version;busy=true;status.textContent='검색 중입니다.';list.replaceChildren();controls(true);
    try{
      const submitted_at=new Date().toISOString();started.add(operation);
      window.experimentTelemetry?.event('search_submitted',{query},{related_type:'search_request',related_id:operation,browser_timestamp:submitted_at});
      const data=await request('',{request_id:operation,query,submitted_at});
      if(active&&version===own){busy=false;display(data);}
    }catch(error){
      if(active&&version===own){busy=false;status.textContent=error.message;
        try{const data=await request('');if(active&&version===own&&data?.request_id===operation){if(data.status==='failed')operation=null;else display(data);}}catch{}
      }
    }finally{if(active&&version===own)controls(true);}
  }
  button.addEventListener('click',submit);input.addEventListener('input',()=>controls());
  input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();submit();}});
  window.addEventListener('online',()=>{if(active)for(const body of pendingClicks.values())void saveClick(body);});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')observeVisible?.();});
  return {get busy(){return busy;},update(enabled){const changed=active!==Boolean(enabled);active=Boolean(enabled);controls();if(!active){clearTimeout(poll);version++;loaded=false;busy=false;return;}if((changed||!loaded)&&!busy){loaded=true;busy=true;controls();refresh();}},cancel(){active=false;version++;clearTimeout(poll);busy=false;controls();}};
};
