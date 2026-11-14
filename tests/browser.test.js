const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {PGlite}=require('@electric-sql/pglite');
const {createApp}=require('../server');
const {EnrollmentRepository,createEnrollmentService}=require('../backend/services/enrollment');

for(const viewport of [{width:1280,height:900},{width:390,height:844}])test(`Chrome ${viewport.width}px 참가자 전체 진행·복원·로그·중단`,async()=>{
  const browser=process.env.TEST_BROWSER||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'experiment-ui-'));
  const checks=async function(){
    const frame=document.querySelector('iframe'); let d;
    const tick=()=>new Promise((resolve)=>setTimeout(resolve,20));
    const check=(condition,label)=>{if(!condition)throw Error(label);};
    const wait=async(predicate,label)=>{for(let i=0;i<500;i++){if(predicate())return;await tick();}throw Error(label);};
    const load=async()=>{
      await new Promise((resolve)=>{frame.onload=resolve;frame.src='/';}); d=frame.contentDocument;
      await wait(()=>!d.querySelector('nav + [role="alert"] + button').disabled || !d.querySelector('#participation-exit-title').parentElement.hidden || d.getElementById('completion-status').textContent.includes('완료'),'bootstrap');
    };
    const reset=async()=>{await fetch('/test-reset');await load();};
    const visible=(id)=>!d.getElementById(id).hidden;
    const next=()=>[...d.querySelectorAll('main > section:not([hidden]) > button')].at(-1).click();
    const set=(selector,value)=>{
      const field=d.querySelector(selector);
      if(['radio','checkbox'].includes(field.type))field.checked=true;else field.value=value;
      field.dispatchEvent(new frame.contentWindow.Event('change',{bubbles:true}));
    };
    const state=async()=>{const response=await frame.contentWindow.fetch('/api/participant/progress');return response.json();};
    const enroll=async()=>{
      set('[value="agree"]');set('#eligibility-confirmation');next();await wait(()=>visible('pre-survey'),'registered');
      check(!d.cookie.includes('ai_latency_session'),'HttpOnly');
    };
    await load();next();await tick();check(visible('consent'),'consent required');
    set('[value="decline"]');next();await wait(()=>visible('participation-exit-title'),'decline');
    check((await state()).disposition==='declined','decline persisted');
    await load();check(visible('participation-exit-title'),'decline restored');

    await reset();await enroll();
    const participant=(await state()).participant_id;
    frame.contentWindow.location.hash='workspace';await tick();
    await wait(()=>!d.querySelector('nav + [role="alert"]').hidden,'hash rejection');
    check(visible('pre-survey')&&(await state()).current_step==='pre-survey','hash cannot skip');
    check((await frame.contentWindow.fetch('/experiment/workspace')).status===403,'server URL rejection');
    next();await tick();check(visible('pre-survey'),'survey required');
    set('#ai-experience','some');set('#ai-frequency','weekly');set('#prior-knowledge','medium');
    d.getElementById('save-pre-draft').click();
    await wait(()=>d.getElementById('pre-save-status').textContent==='임시 저장되었습니다.','draft saved');
    await load();check(visible('pre-survey'),'draft step restored');
    check(d.getElementById('ai-experience').value==='some'&&d.getElementById('ai-frequency').value==='weekly'&&d.getElementById('prior-knowledge').value==='medium','draft answers restored');
    check((await state()).participant_id===participant,'same participant');
    next();await wait(()=>visible('task-guide'),'pre submit');
    await load();check(visible('task-guide'),'task stage restored');
    check((await frame.contentWindow.fetch('/experiment/workspace')).status===403,'task acknowledgement required');
    next();await wait(()=>visible('workspace'),'task acknowledged');
    check(d.documentElement.scrollWidth<=frame.clientWidth+1,'workspace responsive width');
    await wait(()=>!d.getElementById('recording-status').hidden,'recording failure shown');
    await load();check(visible('workspace'),'outbox restored after refresh');
    await wait(()=>!d.getElementById('chat-input').disabled,'chat ready');
    await wait(()=>!d.getElementById('search-query').disabled,'search ready');
    check(d.getElementById('chat-input').readOnly&&d.getElementById('chat-input').value.includes('가상 측정기 루멘 T1'),'shared initial question');
    set('#chat-input','장비 비교 질문');
    d.getElementById('chat-send').click();
    set('#search-query','사용 설명서');d.getElementById('search-submit').click();
    await wait(()=>d.querySelector('#search-result-list a'),'search while AI pending');
    const source=d.querySelector('#search-result-list a');
    check(source.target==='_blank'&&source.rel.includes('noopener')&&source.rel.includes('noreferrer'),'new tab source safety');
    window.testSourceReady=true;await wait(()=>window.testSourceClicked,'trusted source click');
    await wait(()=>d.getElementById('search-status').textContent.includes('검색 결과 1개'),'search result displayed');
    await wait(()=>d.querySelectorAll('.chat-message--assistant').length===1,'chat response');
    await wait(()=>!d.getElementById('chat-input').disabled,'chat output completed');
    await load();await wait(()=>d.querySelectorAll('.chat-message--assistant').length===1,'chat restored');
    await wait(()=>d.querySelector('#search-result-list a'),'search restored');
    await wait(()=>!d.getElementById('chat-input').disabled,'restored chat ready');
    check(!d.getElementById('chat-input').readOnly,'free followup enabled');
    check(d.querySelector('.chat-message--assistant').textContent.includes('12시간'),'fixed initial answer restored');
    set('#chat-input','8시간 아닌가요?');d.getElementById('chat-send').click();
    await wait(()=>d.querySelectorAll('.chat-message--assistant').length===2,'followup response');
    await wait(()=>!d.getElementById('chat-input').disabled,'followup completed');
    check(d.querySelectorAll('.chat-message--assistant')[1].textContent.includes('8시간'),'followup correction');
    frame.contentWindow.dispatchEvent(new frame.contentWindow.Event('offline'));
    frame.contentWindow.dispatchEvent(new frame.contentWindow.Event('online'));
    frame.contentWindow.dispatchEvent(new frame.contentWindow.Event('blur'));
    frame.contentWindow.dispatchEvent(new frame.contentWindow.Event('focus'));
    await frame.contentWindow.experimentTelemetry.flush();
    await wait(()=>!d.getElementById('chat-input').disabled&&!d.getElementById('search-query').disabled,'online tool refresh completed');
    d.querySelector('nav a[href="#pre-survey"]').click();await wait(()=>visible('pre-survey'),'review survey');
    check(d.getElementById('ai-frequency').disabled&&d.getElementById('ai-frequency').value==='weekly','submitted response readonly');
    d.querySelector('nav a[href="#workspace"]').click();await wait(()=>visible('workspace'),'return visited workspace');
    await wait(()=>![...d.querySelectorAll('#workspace > button')].at(-1).disabled,'workspace restore controls ready');
    next();await wait(()=>visible('decision'),'decision opened');
    next();await tick();check(visible('decision'),'decision required');
    set('#selected-product','가상 루멘 T1');set('#key-specifications','가상 배터리 4시간');set('#selection-reason','업무 조건에 맞는 가상 제품');
    next();await wait(()=>visible('post-survey'),'final saved');
    check((await state()).final_decision.product==='가상 루멘 T1','final persisted');
    d.querySelector('nav a[href="#decision"]').click();await wait(()=>visible('decision'),'review final');
    check(d.getElementById('selection-reason').disabled,'final locked');next();await wait(()=>visible('post-survey'),'return post');
    next();await tick();check(visible('post-survey'),'post required');
    set('#perceived-delay','2');set('#interaction-naturalness','4');set('#suspected-delay','unsure');set('#suspected-prewritten','no');
    next();await wait(()=>visible('debriefing'),'debriefing');
    check(d.getElementById('debriefing-correction').textContent.includes('8시간'),'debrief correction');
    await load();check(visible('debriefing'),'debrief restored');next();
    await wait(()=>d.getElementById('completion-status').textContent.includes('완료'),'completion');
    check((await state()).completed===true,'server complete');
    await load();check(visible('debriefing')&&d.getElementById('completion-status').textContent.includes('완료'),'completed restored');
    check((await state()).steps.every(step=>step.completed_at),'all seven completed');

    await reset();await enroll();
    frame.contentWindow.confirm=()=>true;
    d.querySelector('nav + [role="alert"] + button').click();await wait(()=>visible('participation-exit-title'),'withdraw');
    check((await state()).disposition==='withdrawn','withdraw persisted');
    await load();check(visible('participation-exit-title'),'withdraw restored');

    await reset();await enroll();set('#ai-experience','none');next();
    await wait(()=>visible('participation-exit-title'),'ineligible exit');
    check((await state()).disposition==='ineligible','ineligibility persisted');
    await load();check(visible('participation-exit-title'),'ineligible exit restored');
  };
  const harness=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style><iframe></iframe><pre id="result">RUNNING</pre><script>(${checks.toString()})().then(()=>document.querySelector('#result').textContent='UI_PASS').catch(error=>document.querySelector('#result').textContent='UI_FAIL: '+error.message);</script>`;
  const db=new PGlite();await db.exec("SET ai_latency.environment='test'");
  for(const file of ['001_initial_schema.sql','002_enrollment_sessions.sql','003_early_workflow.sql','004_chat.sql','005_response_timing.sql','006_initial_stimulus.sql','007_web_search.sql','008_research_events.sql','009_final_workflow.sql','010_admin_dashboard.sql'])await db.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations',file),'utf8'));
  const config={origin:'',secure:false,cookieName:'ai_latency_session',ttlSeconds:2592000};
  const repository=new EnrollmentRepository(db,'test');
  const service=createEnrollmentService({repository,environment:'test',eligibilityPolicy:'development-only',draw:()=>0});
  let liveCalls=0;
  const chat=require('../backend/services/chat').createChatService({repository,getStimulus:()=>require('../backend/stimuli').loadStimulus('test'),getProvider:()=>({model:'test-model',complete:async()=>{liveCalls++;return '앞선 계산을 8시간으로 정정합니다.';}})});
  const search=require('../backend/services/search').createSearchService({repository,getProvider:()=>({id:'browser-test',policy:{fixture:true},search:async()=>[{rank:1,title:'테스트 전용 출처',description:'브라우저 테스트용 설명',url:config.origin+'/test-source'}]})});
  const app=createApp({getEnrollment:()=>({service,config,repository}),getChat:()=>chat,getSearch:()=>search});
  let sourceHits=0,failLogs=true;const retriedEventIds=[];
  const server=http.createServer((req,res)=>{
    if(req.url==='/test'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(harness);return;}
    if(req.url==='/test-source'){sourceHits++;res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>테스트 출처</title><p>브라우저 테스트 전용 페이지</p><script>window.close()</script>');return;}
    if(req.url==='/api/participant/logs'&&req.method==='POST'&&failLogs){
      failLogs=false;let body='';req.on('data',part=>body+=part);req.on('end',()=>{retriedEventIds.push(...JSON.parse(body).events.map(e=>e.event_id));res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'TEST_RECORDING_FAILURE',message:'테스트용 일시 실패'}}));});return;
    }
    // 테스트 하네스에만 존재하는 새 방문 시뮬레이션. 실제 앱에는 이 경로가 없다.
    if(req.url==='/test-reset'){res.setHeader('Set-Cookie','ai_latency_session=; HttpOnly; Path=/; Max-Age=0');res.end('test reset');return;}
    app(req,res);
  });
  try{
    await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));config.origin=`http://127.0.0.1:${server.address().port}`;
    assert.equal(await require('./chrome-harness').runChromeHarness(browser,profile,config.origin+'/test',{viewport}),'UI_PASS');
    assert.equal(liveCalls,1,'고정 첫 답변에는 LLM 호출이 없고 후속 대화만 호출한다');
    assert.equal(sourceHits,1,'출처가 실제 새 탭에서 열렸다');
    const searches=(await db.query('SELECT * FROM ai_latency_private.search_events')).rows;
    const clicks=(await db.query('SELECT * FROM ai_latency_private.source_events')).rows;
    assert.equal(searches.length,1);assert.equal(clicks.length,1);assert.equal(clicks[0].search_event_id,searches[0].search_event_id);assert.equal(clicks[0].source_url,config.origin+'/test-source');
    assert.ok(clicks[0].returned_at,'출처 클릭 후 앱 복귀 시각');
    const records=(await db.query('SELECT * FROM ai_latency_private.research_events')).rows;
    assert.ok(retriedEventIds.length);for(const id of retriedEventIds)assert.equal(records.filter(e=>e.event_id===id).length,1,'실패한 이벤트를 새로고침 후 한 번만 저장');
    for(const type of ['question_sent','ai_first_character_observed','ai_output_completed_observed','search_submitted','search_results_presented','source_click','source_left','source_return','window_blur','window_focus','offline','online'])assert.ok(records.some(e=>e.event_type===type),type);
    for(const record of records)assert.ok(record.event_id&&record.participant_id&&record.task_id&&record.condition_code&&record.timestamp&&record.server_timestamp);
    const rows=(await db.query('SELECT progress_status FROM ai_latency_private.participants ORDER BY progress_status')).rows;
    assert.deepEqual(rows.map((row)=>row.progress_status),['completed','ineligible','withdrawn']);
  }finally{
    server.closeAllConnections();await new Promise((resolve)=>server.close(resolve));await db.close();
    assert.equal(path.dirname(path.resolve(profile)),path.resolve(os.tmpdir()));assert.ok(path.basename(profile).startsWith('experiment-ui-'));
    await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
});




