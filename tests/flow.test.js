const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlow } = require('../public/js/app');

async function toDecision(flow) {
  flow.update('participation-consent', 'agree');
  flow.update('eligibility-confirmation', 'confirmed');
  assert.equal((await flow.go(1)).ok, true);
  flow.update('ai-experience', 'some');
  flow.update('ai-frequency', 'weekly');
  flow.update('prior-knowledge', 'medium');
  for (const step of [2, 3, 4]) assert.equal((await flow.go(step)).ok, true);
}

test('새 상태는 동의 단계이며 ID·조건·이전 세션 응답이 없다', () => {
  assert.deepEqual(createFlow().snapshot(), { current: 0, values: {}, completed: [], ended: null });
});
test('필수 동의와 사전 설문 누락 시 진행을 막는다', async () => {
  const flow = createFlow();
  assert.deepEqual((await flow.go(1)).fields, ['participation-consent', 'eligibility-confirmation']);
  flow.update('participation-consent', 'agree');
  flow.update('eligibility-confirmation', 'confirmed');
  await flow.go(1);
  flow.update('ai-experience', 'some');
  flow.update('ai-frequency', 'weekly');
  assert.deepEqual((await flow.go(2)).fields, ['prior-knowledge']);
  assert.equal(flow.snapshot().current, 1);
});
test('비동의는 별도 종료 상태가 되며 후속 단계에 접근하지 못한다', async () => {
  const flow = createFlow();
  flow.update('participation-consent', 'decline');
  assert.equal((await flow.go(1)).ok, true);
  assert.equal(flow.snapshot().ended, 'declined');
  assert.equal((await flow.go(6)).ok, false);
  assert.equal(flow.finish(), false);
});
test('단계 건너뛰기 및 잘못된 단계 번호를 막는다', async () => {
  const flow = createFlow();
  flow.update('participation-consent', 'agree');
  flow.update('eligibility-confirmation', 'confirmed');
  for (const target of [-1, 2, 6, 7, NaN, '1']) assert.equal((await flow.go(target)).ok, false);
  assert.equal(flow.finish(), false);
});
test('제품 선택과 공백이 아닌 근거를 요구하고 출처는 선택으로 둔다', async () => {
  const flow = createFlow();
  await toDecision(flow);
  assert.deepEqual((await flow.go(5)).fields, ['selected-product', 'key-specifications', 'selection-reason']);
  flow.update('key-specifications','가상 사양');
  flow.update('selected-product', 'product-a');
  flow.update('selection-reason', '   ');
  assert.deepEqual((await flow.go(5)).fields, ['selection-reason']);
  flow.update('selection-reason', '선정 조건에 부합함');
  assert.equal((await flow.go(5)).ok, true);
});
test('이전 이동과 재진행은 입력을 유지하며 이전 답변 수정 시 완료 상태를 갱신한다', async () => {
  const flow = createFlow();
  await toDecision(flow);
  flow.update('selection-reason', '보존할 근거');
  await flow.go(1);
  flow.update('prior-knowledge', 'high');
  assert.deepEqual(flow.snapshot().completed, [0]);
  assert.equal(flow.snapshot().values['selection-reason'], '보존할 근거');
  assert.equal((await flow.go(4)).ok, false);
  await flow.go(2);
  assert.equal(flow.snapshot().values['prior-knowledge'], 'high');
});
test('사후 설문을 완료해야 종료 화면으로 이동하고 마지막 확인 후 100% 완료한다', async () => {
  const flow = createFlow();
  await toDecision(flow);
  flow.update('selected-product', 'product-b');
  flow.update('key-specifications','가상 사양');
  flow.update('selection-reason', '업무 조건 충족');
  await flow.go(5);
  assert.deepEqual((await flow.go(6)).fields, ['perceived-delay','interaction-naturalness','suspected-delay','suspected-prewritten']);
  for (const [key,value] of Object.entries({'perceived-delay':'3','interaction-naturalness':'4','suspected-delay':'no','suspected-prewritten':'unsure'})) flow.update(key,value);
  await flow.go(6);
  assert.equal(flow.snapshot().completed.length, 6);
  assert.equal(flow.finish(), true);
  assert.equal(flow.snapshot().completed.length, 7);
  assert.equal(flow.snapshot().ended, 'completed');
  assert.equal(flow.finish(), false);
  assert.equal((await flow.go(5)).ok, false);
});
test('서버 접근 검사 경계가 거절 또는 실패하면 단계를 유지한다', async () => {
  for (const canEnter of [async () => false, async () => { throw Error('offline'); }]) {
    const flow = createFlow({ canEnter });
    flow.update('participation-consent', 'agree');
    flow.update('eligibility-confirmation', 'confirmed');
    assert.equal((await flow.go(1)).ok, false);
    assert.equal(flow.snapshot().current, 0);
    assert.deepEqual(flow.snapshot().completed, []);
  }
});
test('비동기 접근 검사 중 중복 이동을 차단한다', async () => {
  let release;
  const flow = createFlow({ canEnter: () => new Promise((resolve) => { release = resolve; }) });
  flow.update('participation-consent', 'agree');
  flow.update('eligibility-confirmation', 'confirmed');
  const first = flow.go(1);
  assert.equal((await flow.go(1)).ok, false);
  release(true);
  assert.equal((await first).ok, true);
  assert.deepEqual(flow.snapshot().completed, [0]);
});
test('상태 스냅샷 수정은 내부 응답과 완료 상태를 변경하지 않는다', () => {
  const flow = createFlow();
  const copy = flow.snapshot();
  copy.values['participation-consent'] = 'agree';
  copy.completed.push(6);
  assert.deepEqual(flow.snapshot().values, {});
  assert.deepEqual(flow.snapshot().completed, []);
});
