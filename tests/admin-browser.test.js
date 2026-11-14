const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {fixture}=require('./admin-fixture');
for(const viewport of [{width:1280,height:900},{width:390,height:844}])test(`Chrome ${viewport.width}px 관리자 로그인·DB 통계·상세·코딩·갱신·로그아웃`,async()=>{
 const checks=async function(){
  const $=id=>document.getElementById(id),tick=()=>new Promise(r=>setTimeout(r,20)),check=(ok,label)=>{if(!ok)throw Error(label);};
  const wait=async(fn,label)=>{for(let i=0;i<500;i++){if(fn())return;await tick();}throw Error(label+': '+$('notice').textContent);};
  await wait(()=>!$('username').disabled,'login ready');check($('dashboard').hidden,'anonymous data hidden');
  $('username').value='fixture-researcher';$('password').value='local-fixture-password-only';$('login-form').requestSubmit();
  await wait(()=>!$('dashboard').hidden&&!$('refresh').disabled&&document.querySelectorAll('#participants tbody tr').length===4,'dashboard data');
  check($('environment').textContent.includes('TEST'),'test label');check($('counts').textContent.includes('전체 참가자4'),'participant count');
  check(document.documentElement.scrollWidth<=window.innerWidth+1,'responsive page width');
  check($('conditions').textContent.includes('2.100초'),'actual delay');check(!document.cookie.includes('ai_latency_admin'),'HttpOnly');
  const rows=await(await fetch('/api/admin/participants')).json(),p=rows.participants.find(r=>r.progress_status==='completed');
  document.querySelector(`[data-participant="${p.participant_id}"]`).click();await wait(()=>!$('detail-panel').hidden&&!$('save-coding').disabled,'detail');
  check($('detail-content').textContent.includes('테스트 응답입니다.'),'chat data');
  $('coding-code').value='accepted';$('coding-notes').value='브라우저 연구자 코딩 테스트';$('coding-form').requestSubmit();
  await wait(()=>$('coding-status').textContent==='코딩을 저장했습니다.','coding saved');
  check($('detail-content').textContent.includes('fixture-researcher'),'coding actor');
  const response=await fetch('/api/admin/exports/participants'),csv=await response.text();check(csv.includes('accepted')&&csv.includes(p.participant_id),'CSV contains coding');
  const prior=$('snapshot').textContent;$('refresh').click();await wait(()=>!$('refresh').disabled&&$('snapshot').textContent!==prior,'refresh');
  check(document.querySelectorAll('[data-export]').length===4,'export controls');
  $('logout').click();await wait(()=>$('dashboard').hidden&&!$('username').disabled,'logout');check($('detail-content').textContent==='','clear sensitive DOM');
  check((await fetch('/api/admin/exports/events')).status===401,'logout server enforced');
  check(localStorage.length===0&&sessionStorage.length===0,'no browser credential storage');
 };
 const f=await fixture({browserChecks:checks});const profile=await fs.mkdtemp(path.join(os.tmpdir(),'experiment-admin-'));
 try{assert.equal(await require('./chrome-harness').runChromeHarness(process.env.TEST_BROWSER||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',profile,f.base+'/admin/',{viewport}),'UI_PASS');
  const row=(await f.db.query('SELECT misinformation_acceptance,assessed_by,adjudication_notes FROM ai_latency_private.final_decisions')).rows[0];assert.equal(row.misinformation_acceptance,'accepted');assert.equal(row.assessed_by,'fixture-researcher');
 }finally{await f.close();assert.equal(path.dirname(path.resolve(profile)),path.resolve(os.tmpdir()));assert.ok(path.basename(profile).startsWith('experiment-admin-'));await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
