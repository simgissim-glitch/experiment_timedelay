'use strict';

// 참가자·동의·사전 설문·진행 권한은 서버가 관리한다. 조건 정보는 받지 않는다.
const ExperimentFlow = (() => {
  const steps = ['consent','pre-survey','task-guide','workspace','decision','post-survey','debriefing'];
  const required = {
    consent: ['participation-consent','eligibility-confirmation'],
    'pre-survey': ['ai-experience','ai-frequency','prior-knowledge'],
    decision: ['selected-product','key-specifications','selection-reason'], 'post-survey': ['perceived-delay','interaction-naturalness','suspected-delay','suspected-prewritten'],
  };
  const allowed = {
    'participation-consent': ['agree','decline'], 'eligibility-confirmation': ['confirmed'],
    'ai-experience': ['some','none'], 'ai-frequency': ['never','rarely','monthly','weekly','daily'],
    'prior-knowledge': ['low','medium','high'],
    'perceived-delay':['1','2','3','4','5'], 'interaction-naturalness':['1','2','3','4','5'],
    'suspected-delay':['yes','no','unsure'], 'suspected-prewritten':['yes','no','unsure'],
  };
  function createFlow({ canEnter = async () => true } = {}) {
    const state = { current: 0, values: {}, completed: [], ended: null };
    let busy = false;
    const snapshot = () => ({ ...state, values: { ...state.values }, completed: [...state.completed] });
    function update(name, value) {
      if (busy || state.ended || state.values[name] === value) return;
      state.values[name] = value;
      state.completed = state.completed.filter((index) => index < state.current);
    }
    function applyServer(data) {
      state.current = Math.max(0, steps.indexOf(data.current_step));
      state.ended = data.disposition === 'active' ? null : data.disposition;
      state.completed = (data.steps || []).filter((item) => item.completed_at).map((item) => steps.indexOf(item.step)).filter((index) => index >= 0);
      if (data.consent?.decision !== null && data.consent?.decision !== undefined) {
        state.values['participation-consent'] = data.consent.decision ? 'agree' : 'decline';
      }
      if (data.registered) state.values['eligibility-confirmation'] = 'confirmed';
      const answers = data.pre_survey?.answers || {};
      for (const [key, name] of Object.entries({ aiExperience:'ai-experience', aiFrequency:'ai-frequency', priorKnowledge:'prior-knowledge' })) {
        state.values[name] = answers[key] || '';
      }
      for (const [key,name] of Object.entries({product:'selected-product',specifications:'key-specifications',rationale:'selection-reason',references:'reference-sources'})) {
        if (data.final_decision) state.values[name]=data.final_decision[key] || '';
      }
      for (const [key,name] of Object.entries({perceivedDelay:'perceived-delay',naturalness:'interaction-naturalness',suspectedDelay:'suspected-delay',suspectedPrewritten:'suspected-prewritten'})) {
        if (data.post_survey) state.values[name]=data.post_survey.answers[key] || '';
      }
    }
    async function go(target) {
      if (busy || state.ended || !Number.isInteger(target) || target < 0 || target >= steps.length) return { ok:false };
      if (target === state.current) return { ok:true };
      if (target > state.current + 1) return { ok:false, reason:'sequence' };
      const declining = state.current === 0 && state.values['participation-consent'] === 'decline';
      if (target > state.current && !declining) {
        const names = state.current === 1 && state.values['ai-experience'] === 'none' ? ['ai-experience'] : required[steps[state.current]] || [];
        const invalid = names.filter((name) => {
          const value = state.values[name];
          return !value?.trim() || (allowed[name] && !allowed[name].includes(value)) ||
            (name === 'ai-frequency' && state.values['ai-experience'] === 'some' && value === 'never');
        });
        if (invalid.length) return { ok:false, reason:'required', fields:invalid };
        if (state.values['participation-consent'] !== 'agree') return { ok:false, reason:'sequence' };
      }
      busy = true;
      try {
        const permission = await canEnter(steps[target], snapshot());
        if (!permission) return { ok:false, reason:'access' };
        if (typeof permission === 'object' && permission.current_step) applyServer(permission);
        else if (declining) state.ended = 'declined';
        else {
          if (target > state.current && !state.completed.includes(state.current)) state.completed.push(state.current);
          state.current = target;
        }
        return { ok:true };
      } catch (error) { return { ok:false, reason:'connection', code:error.code }; }
      finally { busy = false; }
    }
    function finish() {
      if (busy || state.ended || state.current !== 6 || state.completed.length !== 6) return false;
      state.completed.push(6); state.ended = 'completed'; return true;
    }
    function resumeEnrollment() {
      applyServer({ current_step:'pre-survey', disposition:'active', registered:true, consent:{decision:true}, steps:[{step:'consent',completed_at:true}] });
    }
    return { snapshot, update, go, finish, resumeEnrollment, applyServer };
  }
  return { steps, required, createFlow };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ExperimentFlow;
if (typeof document !== 'undefined') initializeExperiment();

async function initializeExperiment() {
  const { steps, required, createFlow } = ExperimentFlow;
  const sections = steps.map((id) => document.getElementById(id));
  const nav = document.querySelector('nav');
  const fields = [...document.querySelectorAll('main input, main select, main textarea')];
  let prepared = false;
  let serverState;
  let pending = true;
  let saveChain = Promise.resolve();
  let draftTimer;
  const requestedStep = window.location.hash.slice(1) || window.location.pathname.match(/^\/experiment\/([^/]+)$/)?.[1];
  const saveButton = document.getElementById('save-pre-draft');
  const saveStatus = document.getElementById('pre-save-status');

  async function request(path, body) {
    const response = await fetch(`/api/participant/${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials:'same-origin', cache:'no-store',
      headers: body === undefined ? {} : { 'Content-Type':'application/json', 'X-Experiment-Request':'1' },
      ...(body === undefined ? {} : { body:JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) { const error = new Error('서버 요청을 완료하지 못했습니다.'); error.code = data.error?.code; throw error; }
    return data;
  }
  async function restore() {
    const bootstrap = async () => {
      try { await request('session'); }
      catch (error) { if (error.code !== 'SESSION_REQUIRED') throw error; await request('session', {}); }
      prepared = true;
      return request('progress');
    };
    return navigator.locks ? navigator.locks.request('experiment-session-bootstrap', bootstrap) : bootstrap();
  }
  function answers() {
    const result = {};
    for (const [key,id] of Object.entries({aiExperience:'ai-experience',aiFrequency:'ai-frequency',priorKnowledge:'prior-knowledge'})) {
      if (document.getElementById(id).value) result[key] = document.getElementById(id).value;
    }
    if (result.aiExperience === 'none') result.aiFrequency = 'never';
    return result;
  }
  async function receive(path,body) {
    serverState=await request(path,body);
    return serverState;
  }
  const flow = createFlow({ canEnter: async (step, snapshot) => {
    clearTimeout(draftTimer);
    if (snapshot.current === 1 && step !== 'task-guide' && serverState?.pre_survey.is_draft) await saveDraft();
    else await saveChain;
    if (!prepared) serverState = await restore();
    if (snapshot.current === 0 && snapshot.values['participation-consent'] === 'decline') {
      return receive('progress/end', {reason:'declined'});
    }
    if (!serverState.registered && snapshot.current === 0 && step === 'pre-survey') {
      await request('participants', { consent:true, eligibility:{testEligible:snapshot.values['eligibility-confirmation'] === 'confirmed'} });
      return receive('progress');
    }
    if (snapshot.current === 1 && step === 'task-guide' && serverState.pre_survey.is_draft) {
      return receive('surveys/pre', {answers:answers(),mode:'submit',revision:serverState.pre_survey.revision});
    }
    if (snapshot.current === 2 && step === 'workspace') return receive('progress/task-guide/complete', {acknowledged:true});
    if (snapshot.current === 3 && step === 'decision') return receive('progress/workspace/complete',{acknowledged:true});
    if (snapshot.current === 4 && step === 'post-survey') {
      if (serverState.final_decision) return receive('progress/navigate',{step});
      return receive('decisions',{request_id:crypto.randomUUID(),product:snapshot.values['selected-product'],specifications:snapshot.values['key-specifications'],rationale:snapshot.values['selection-reason'],references:snapshot.values['reference-sources'] || ''});
    }
    if (snapshot.current === 5 && step === 'debriefing') {
      if (serverState.post_survey) return receive('progress/navigate',{step});
      return receive('surveys/post',{request_id:crypto.randomUUID(),answers:{perceivedDelay:snapshot.values['perceived-delay'],naturalness:snapshot.values['interaction-naturalness'],suspectedDelay:snapshot.values['suspected-delay'],suspectedPrewritten:snapshot.values['suspected-prewritten']}});
    }
    return receive('progress/navigate', {step});
  } });
  function element(tag,text,parent) {
    const node = document.createElement(tag); if (text) node.textContent = text; if (parent) parent.append(node); return node;
  }
  const progressLabel = element('p','',nav);
  progressLabel.id = 'experiment-progress-label'; progressLabel.setAttribute('role','status');
  const progress = element('progress','',nav); progress.max = steps.length; progress.setAttribute('aria-labelledby',progressLabel.id);
  const notice = element('p'); notice.setAttribute('role','alert'); notice.hidden = true; nav.after(notice);
  const withdraw = element('button','참여 중단'); withdraw.type='button'; notice.after(withdraw);
  const exitSection = element('section','',document.querySelector('main')); exitSection.hidden = true;
  const exitTitle = element('h2','연구 참여 종료 안내',exitSection); exitTitle.id='participation-exit-title'; exitSection.setAttribute('aria-labelledby',exitTitle.id);
  const exitText = element('p','',exitSection);
  element('p','TODO: 개인정보 보관·철회·삭제 정책은 연구자 확정 전입니다. 참여 중단이 자동 삭제를 의미하지는 않습니다.',exitSection);
  const nextButtons = [];
  const previousButtons = [];
  const chat = window.createExperimentChat?.(() => render());
  const search = window.createExperimentSearch?.(() => render());
  sections.forEach((section,index) => {
    const next = section.querySelector(':scope > button'); nextButtons.push(next);
    next.addEventListener('click', () => index === 6 ? finishExperiment() : move(index+1));
    if (index > 0) {
      const previous = element('button','이전 단계'); previous.type='button';
      previous.addEventListener('click', () => move(index-1)); next.before(previous); previousButtons.push(previous);
    }
  });
  Object.values(required).flat().forEach((name) => fields.filter((field) => field.name === name).forEach((field) => { field.required=true; }));
  function capture() {
    fields.forEach((field) => {
      if (field.type === 'checkbox') flow.update(field.name,field.checked?'confirmed':'');
      else if (field.type !== 'radio' || field.checked) flow.update(field.name,field.value);
    });
  }
  function clearErrors() {
    notice.hidden = true;
    fields.forEach((field) => { field.removeAttribute('aria-invalid'); field.setCustomValidity(''); });
  }
  function showError(error) {
    notice.hidden = false;
    notice.textContent = error.code === 'STALE_RESPONSE' ? '다른 화면에서 응답이 변경되었습니다. 새로고침하여 저장된 응답을 확인해 주세요.'
      : error.code === 'STEP_NOT_ALLOWED' ? '필요한 절차를 먼저 완료해 주세요. 제출한 과제로 돌아가 수정할 수 없습니다.'
        : '저장 또는 진행 상태 확인에 실패했습니다. 서버 연결 상태를 확인하고 다시 시도해 주세요.';
  }
  function hydrate(data) {
    serverState = data; flow.applyServer(data);
    const values = flow.snapshot().values;
    fields.forEach((field) => {
      if (field.type === 'radio') field.checked = values[field.name] === field.value;
      else if (field.type === 'checkbox') field.checked = values[field.name] === 'confirmed';
      else if (Object.hasOwn(values,field.name)) field.value = values[field.name];
    });
  }
  function render() {
    const state = flow.snapshot();
    sections.forEach((section,index) => { section.hidden = Boolean(state.ended) || index !== state.current; });
    exitSection.hidden = !state.ended;
    exitText.textContent = state.ended === 'declined' ? '연구 참여에 동의하지 않아 절차를 종료했습니다. 이 창을 닫아도 됩니다.'
      : state.ended === 'ineligible' ? '생성형 AI 이용 경험 기준에 따라 참여 절차가 종료되었습니다. 참여해 주셔서 감사합니다.'
        : '자발적 참여 중단이 기록되었습니다. 이 창을 닫아도 됩니다.';
    progress.value = state.completed.length;
    progressLabel.textContent = state.ended ? '연구 참여 종료' : `${state.current+1} / ${steps.length} 단계 · 진행률 ${Math.round(state.completed.length/steps.length*100)}%`;
    nav.querySelectorAll('a').forEach((link,index) => {
      link.removeAttribute('aria-current'); if (!state.ended && index === state.current) link.setAttribute('aria-current','step');
      link.setAttribute('aria-disabled',String(pending || Boolean(state.ended) || Boolean(serverState?.completed)));
    });
    [...nextButtons,...previousButtons,withdraw].forEach((button) => { button.disabled = pending || Boolean(state.ended); });
    if (chat?.busy || search?.busy) [...nextButtons,...previousButtons].forEach(button=>{button.disabled=true;});
    const submitted = serverState?.registered && !serverState.pre_survey.is_draft;
    fields.forEach((field) => {
      field.disabled = pending || Boolean(state.ended) || (serverState?.registered && Boolean(field.closest('#consent'))) ||
        (submitted && Boolean(field.closest('#pre-survey'))) ||
        (Boolean(serverState?.final_decision) && Boolean(field.closest('#decision'))) ||
        (Boolean(serverState?.post_survey) && Boolean(field.closest('#post-survey'))) ||
        (field.id === 'ai-frequency' && document.getElementById('ai-experience').value === 'none');
    });
    if (serverState?.completed) [...nextButtons,...previousButtons,withdraw].forEach(button=>{button.disabled=true;});
    const debriefing=serverState?.debriefing;
    for (const [id,key] of Object.entries({'debriefing-explanation':'explanation','debriefing-correction':'correction','debriefing-policy':'contactPolicy'})) document.getElementById(id).textContent=debriefing?.[key] || '';
    document.getElementById('debriefing-draft').textContent=debriefing?.draft ? '개발 테스트 전용 임시 디브리핑 — 연구자 승인 전 실제 연구 사용 금지' : '';
    document.getElementById('completion-status').textContent=serverState?.completed ? '모든 연구 참여 절차가 완료되었습니다. 이 창을 닫아도 됩니다.' : '';
    saveButton.disabled = pending || Boolean(state.ended) || !serverState?.registered || submitted;
    window.experimentTelemetry?.update(!pending && !state.ended && state.current===3 && serverState?.current_step==='workspace');
    chat?.update(!pending && !state.ended && state.current===3 && serverState?.current_step==='workspace');
    search?.update(!pending && !state.ended && state.current===3 && serverState?.current_step==='workspace');
    nextButtons[0].textContent = state.values['participation-consent'] === 'decline' ? '참여하지 않고 종료' : '동의 후 사전 설문 시작';
    if (submitted) saveStatus.textContent = '사전 설문 제출이 완료되었습니다. 저장된 응답을 확인할 수 있습니다.';
  }
  function saveDraft() {
    clearTimeout(draftTimer);
    const captured = answers();
    if (!serverState?.registered || !serverState.pre_survey.is_draft || serverState.disposition !== 'active') return saveChain;
    saveStatus.textContent = '임시 저장 중입니다.';
    saveChain = saveChain.catch(() => {}).then(async () => {
      serverState = await request('surveys/pre',{answers:captured,mode:'draft',revision:serverState.pre_survey.revision});
      saveStatus.textContent = JSON.stringify(answers()) === JSON.stringify(captured) ? '임시 저장되었습니다.' : '변경된 응답을 저장하고 있습니다.';
    });
    saveChain.catch((error) => { saveStatus.textContent = '임시 저장하지 못했습니다. 입력은 화면에 남아 있습니다.'; showError(error); });
    return saveChain;
  }
  fields.forEach((field) => field.addEventListener('change', () => {
    if (field.id === 'ai-experience') {
      const frequency = document.getElementById('ai-frequency');
      if (field.value === 'none') frequency.value='never'; else if (frequency.value === 'never') frequency.value='';
    }
    capture(); clearErrors(); render();
    if (field.closest('#pre-survey') && serverState?.pre_survey.is_draft) {
      saveStatus.textContent='아직 저장되지 않은 변경이 있습니다.';
      clearTimeout(draftTimer); draftTimer=setTimeout(saveDraft,700);
    }
  }));
  // 과제 입력은 아직 메모리 초안이다.
  fields.filter((field) => field.tagName === 'TEXTAREA' || field.type === 'search').forEach((field) => field.addEventListener('input',capture));
  saveButton.addEventListener('click', () => { saveDraft(); });
  async function move(target) {
    if (pending || chat?.busy || search?.busy) return; capture(); clearErrors(); pending=true; render();
    const result = await flow.go(target);
    if (result.ok) {
      // DB 트랜잭션에서 반환한 상태를 그대로 적용하며 성공을 추정하지 않는다.
      hydrate(serverState);
    } else if (result.fields) {
      notice.hidden=false; notice.textContent='필수 항목을 입력하거나 선택해 주세요.';
    } else showError(result);
    pending=false; render();
    if (result.fields) {
      const invalid=fields.filter((field) => result.fields.includes(field.name));
      invalid.forEach((field) => field.setAttribute('aria-invalid','true'));
      invalid[0].setCustomValidity('필수 항목을 입력하거나 선택해 주세요.'); invalid[0].focus(); invalid[0].reportValidity();
    } else if (result.ok) focusTitle();
  }
  async function finishExperiment() {
    if (pending || serverState?.completed) return;
    pending=true; render(); clearErrors();
    try { hydrate(await request('progress/debriefing/complete',{acknowledged:true})); focusTitle(); }
    catch(error) { showError(error); }
    finally { pending=false; render(); }
  }
  function focusTitle() {
    const state=flow.snapshot(); const title=state.ended?exitTitle:sections[state.current].querySelector('h2'); title.tabIndex=-1; title.focus();
  }
  async function navigate(step) {
    if (pending || chat?.busy || search?.busy) return; clearTimeout(draftTimer); clearErrors(); pending=true; render();
    try {
      if (flow.snapshot().current === 1 && serverState?.pre_survey.is_draft) await saveDraft(); else await saveChain;
      hydrate(await request('progress/navigate',{step})); focusTitle();
    }
    catch (error) { showError(error); }
    finally { pending=false; render(); }
  }
  document.querySelectorAll('a[href^="#"]').forEach((link) => link.addEventListener('click',(event) => { event.preventDefault(); navigate(link.getAttribute('href').slice(1)); }));
  withdraw.addEventListener('click',async () => {
    if (pending || !window.confirm('참여를 중단하시겠습니까? 중단 후에는 이 참여 세션으로 실험을 계속할 수 없습니다.')) return;
    window.experimentTelemetry?.update(false);chat?.cancel(); search?.cancel(); clearTimeout(draftTimer); pending=true; render();
    try { await saveChain.catch(() => {}); hydrate(await request('progress/end',{reason:'withdrawn'})); focusTitle(); }
    catch (error) { showError(error); }
    finally { pending=false; render(); }
  });
  const clearHash=() => { if (window.location.hash) window.history.replaceState(null,'',window.location.pathname+window.location.search); };
  window.addEventListener('hashchange',() => { const step=window.location.hash.slice(1); clearHash(); if (step) navigate(step); });
  clearHash();
  // 보호된 진입 URL은 확인 후 기본 주소로 정리하여, 이후 새로고침은 DB의 current_step을 복원한다.
  if (window.location.pathname.startsWith('/experiment/')) window.history.replaceState(null,'','/'+window.location.search);
  capture(); render();
  try { hydrate(await restore()); }
  catch (error) { showError(error); }
  finally { pending=false; render(); }
  if (requestedStep) await navigate(requestedStep);
}
