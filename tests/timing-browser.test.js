const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {setTimeout:wait}=require('node:timers/promises');
const {PGlite}=require('@electric-sql/pglite');
const {createApp}=require('../server');
const {EnrollmentRepository,createEnrollmentService}=require('../backend/services/enrollment');
const {createChatService}=require('../backend/services/chat');

// 가상 시간 가속 없이 Chrome의 실제 단조 시계와 렌더링 프레임을 사용한다.
test('Chrome 실시간: A/B/C 최초·후속 표시, 느린 생성, 새로고침과 본문 비공개',async(t)=>{
  const db=new PGlite();await db.exec("SET ai_latency.environment='test'");
  for(const file of ['001_initial_schema.sql','002_enrollment_sessions.sql','003_early_workflow.sql','004_chat.sql','005_response_timing.sql','006_initial_stimulus.sql','007_web_search.sql','008_research_events.sql','009_final_workflow.sql','010_admin_dashboard.sql'])await db.exec(await fs.readFile(path.join(__dirname,'../backend/database/migrations',file),'utf8'));
  const repo=new EnrollmentRepository(db,'test');let condition=0,calls=0;
  const enrollment=createEnrollmentService({repository:repo,environment:'test',eligibilityPolicy:'development-only',draw:()=>condition});
  const config={origin:'',secure:false,cookieName:'ai_latency_session',ttlSeconds:3600};
  let controlled=true;const stimulus=require('../backend/stimuli').loadStimulus('test');
  const chat=createChatService({repository:repo,getStimulus:()=>controlled?stimulus:null,getProvider:()=>({model:'timing-test',complete:async(messages)=>{
    calls++;if(messages.at(-1).content==='slow')await wait(2400);return '확인했습니다.';
  }})});
  const app=createApp({getEnrollment:()=>({service:enrollment,repository:repo,config}),getChat:()=>chat});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));config.origin=`http://127.0.0.1:${server.address().port}`;
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'timing-chrome-'));
  const chrome=spawn(process.env.TEST_BROWSER||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let ws;
  try{
    let port;for(let i=0;i<100;i++){try{port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await wait(100);}}
    assert.ok(port,'Chrome debugging port');
    const target=await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(config.origin)}`,{method:'PUT'})).json();
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
    let id=0;const pending=new Map();ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
    const cdp=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});ws.send(JSON.stringify({id:next,method,params}));});
    const evaluate=async(expression)=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text+': '+r.exceptionDetails.exception?.description);return r.result.value;};
    const setup=async()=>{
      await cdp('Page.navigate',{url:'about:blank'});await wait(50);
      await cdp('Network.clearBrowserCookies');
      await cdp('Page.navigate',{url:config.origin});await wait(250);
      await evaluate(`(async()=>{for(let i=0;i<200;i++){const b=document.querySelector('nav + [role="alert"] + button');if(b&&!b.disabled)return true;await new Promise(r=>setTimeout(r,20));}throw Error('initial page not ready');})()`);
      await evaluate(`(async()=>{const post=async(p,b)=>{const r=await fetch('/api/participant/'+p,{method:'POST',headers:{'Content-Type':'application/json','X-Experiment-Request':'1'},body:JSON.stringify(b)});if(!r.ok)throw Error(p+':'+r.status);return r.json();};await post('session',{});await post('participants',{consent:true,eligibility:{testEligible:true}});await post('surveys/pre',{answers:{aiExperience:'some',aiFrequency:'weekly',priorKnowledge:'medium'},mode:'submit',revision:0});await post('progress/task-guide/complete',{acknowledged:true});return true;})()`);
      await cdp('Page.navigate',{url:config.origin});await wait(200);
      assert.equal(await evaluate(`(async()=>{for(let i=0;i<200;i++){if(document.getElementById('chat-input')&&!document.getElementById('chat-input').disabled)return true;await new Promise(r=>setTimeout(r,20));}return false;})()`),true);
    };
    const send=async(message)=>evaluate(`(async()=>{const events=[];const done=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('paint timeout')),30000);const listener=e=>{events.push(e.detail);if(e.detail.event==='output-completed'){clearTimeout(timeout);window.removeEventListener('experiment:chat-presentation',listener);resolve(events);}};window.addEventListener('experiment:chat-presentation',listener);});const input=document.getElementById('chat-input');input.value=${JSON.stringify(message)};input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chat-send').click();return done;})()`);
    const results=[];
    for(condition=0;condition<3;condition++){
      await setup();
      for(let turn=0;turn<2;turn++){
        const events=await send('compare '+turn);await wait(150);
        const row=(await db.query('SELECT * FROM ai_latency_private.chat_timings WHERE attempt_id=$1',[events[0].delivery_id])).rows[0];
        assert.equal(row.target_delay_ms,[2000,9000,20000][condition]);assert.ok(row.first_elapsed_ms>=row.target_delay_ms);
        assert.ok(row.output_completed_at);assert.ok(row.response_ready_at);assert.equal(row.restored,false);
        if(turn===0)assert.equal(await evaluate("document.querySelector('.chat-message--assistant p:last-child').textContent"),stimulus.answer);
        results.push({condition:['A','B','C'][condition],turn:turn+1,target_ms:row.target_delay_ms,actual_ms:Math.round(row.first_elapsed_ms),difference_ms:Math.round(row.first_elapsed_ms-row.target_delay_ms)});
      }
    }
    controlled=false;condition=0;await setup();const slowEvents=await send('slow');await wait(100);
    const slow=(await db.query('SELECT * FROM ai_latency_private.chat_timings WHERE attempt_id=$1',[slowEvents[0].delivery_id])).rows[0];
    assert.ok(slow.first_elapsed_ms>=2400);assert.ok(new Date(slow.response_ready_at)-new Date(slow.server_received_at)>=2400);
    results.push({case:'A slow provider',target_ms:2000,actual_ms:Math.round(slow.first_elapsed_ms),difference_ms:Math.round(slow.first_elapsed_ms-2000)});
    // 준비된 답변도 목표 전 GET에 포함되지 않고 연결 중단/새로고침으로 재생성되지 않는다.
    condition=1;await setup();const before=calls;
    await evaluate(`(()=>{const x=document.getElementById('chat-input');x.value='reload';x.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chat-send').click();return true;})()`);
    await wait(300);
    assert.equal(await evaluate(`(async()=>{const d=await(await fetch('/api/participant/conversations')).json();return d.messages.some(m=>m.role==='assistant');})()`),false);
    await evaluate(`(async()=>{const d=await(await fetch('/api/participant/conversations')).json();const m=d.messages.find(m=>m.role==='user');window.duplicate=fetch('/api/participant/conversations',{method:'POST',headers:{'Content-Type':'application/json','X-Experiment-Request':'1'},body:JSON.stringify({request_id:m.request_id,message:m.content})});return true;})()`);
    await cdp('Page.navigate',{url:config.origin});await wait(200);
    const restored=await evaluate(`(async()=>{for(let i=0;i<600;i++){const x=document.querySelector('.chat-message--assistant');if(x&&x.textContent.includes('확인했습니다.'))return true;await new Promise(r=>setTimeout(r,20));}return false;})()`);
    assert.equal(restored,true);assert.equal(calls,before+1);
    t.diagnostic(JSON.stringify(results));
    await fs.writeFile(path.join(__dirname,'timing-results.json'),JSON.stringify({generated_at:new Date().toISOString(),environment:'headless Chrome + local Express + isolated PGlite + deterministic provider; real wall time',results},null,2)+'\n');
  }finally{
    ws?.close();chrome.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();
    assert.equal(path.dirname(path.resolve(profile)),path.resolve(os.tmpdir()));assert.ok(path.basename(profile).startsWith('timing-chrome-'));
    await fs.rm(profile,{recursive:true,force:true,maxRetries:20,retryDelay:200});
  }
});



