const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { ApiError } = require('../backend/middleware/errors');

let server;
let base;
before(async () => {
  server = createApp({ getEnrollment: () => { throw new ApiError(503, 'DB_NOT_CONFIGURED', '테스트에서 실제 DB에 연결하지 않습니다.'); } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
const post = (route, body) => fetch(`${base}/api/participant/${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('health는 서버 상태만 반환하며 환경 정보와 X-Powered-By를 노출하지 않는다', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.deepEqual(await response.json(), { status: 'ok', message: 'Express 서버에 정상적으로 연결되었습니다.' });
});
test('참가자 DB 미설정 상태에서는 가짜 등록·저장 성공을 반환하지 않는다', async () => {
  const payloads = {
    participants: { consent: true, eligibility: { testEligible: true } },
    conversations: { request_id: '00000000-0000-4000-8000-000000000001', message: '장비 비교 질문' },
    searches: { request_id:'00000000-0000-4000-8000-000000000002', query: '장비 사양' },
    surveys: { participantId: 'test-only', stage: 'pre', answers: { example: 'test' } },
    logs: { events:[{event_id:'00000000-0000-4000-8000-000000000003',task_id:'00000000-0000-4000-8000-000000000004',type:'page_start',browser_timestamp:'2026-11-15T00:00:00.000Z',page_id:'00000000-0000-4000-8000-000000000005',performance_ms:10,performance_time_origin:1000000,related_type:null,related_id:null,payload:{}}] },
  };
  for (const [route, payload] of Object.entries(payloads)) {
    const response = await post(route, payload);
    assert.equal(response.status, 503, route);
    const body = await response.json();
    assert.equal(body.error.code, 'DB_NOT_CONFIGURED');
    assert.equal(body.success, undefined);
    assert.equal(body.participantId, undefined);
  }
  const lookup = await fetch(`${base}/api/participant/participants/test-only`);
  assert.equal(lookup.status, 503);
});
test('누락·타입·공백·길이·추가 필드를 검증한다', async () => {
  const invalid = [
    ['participants', {}], ['participants', { consent: 'true' }],
    ['participants', { consent: true, condition: 'unauthorized' }],
    ['conversations', { participantId: '../invalid', message: 'test' }],
    ['conversations', { participantId: 'test-only', message: '   ' }],
    ['conversations', { participantId: 'test-only', message: 'x'.repeat(10001) }],
    ['searches', { participantId: 'test-only', query: 123 }],
    ['surveys', { participantId: 'test-only', stage: 'other', answers: {} }],
    ['surveys', { participantId: 'test-only', stage: 'pre', answers: [] }],
    ['logs', { participantId: 'test-only', event: 'test', data: [] }],
    ['logs', []], ['logs', null],
  ];
  for (const [route, payload] of invalid) {
    const response = await post(route, payload);
    assert.equal(response.status, 400, `${route}: ${JSON.stringify(payload).slice(0, 100)}`);
    const body = await response.json();
    assert.ok(['VALIDATION_ERROR', 'INVALID_JSON'].includes(body.error.code));
    assert.equal(body.error.stack, undefined);
  }
});
test('잘못된 JSON·Content-Type·큰 본문을 일관된 오류로 반환한다', async () => {
  for (const [headers, body, status, code] of [
    [{ 'Content-Type': 'application/json' }, '{bad json', 400, 'INVALID_JSON'],
    [{ 'Content-Type': 'text/plain' }, 'test', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ 'Content-Type': 'application/json' }, JSON.stringify({ text: 'x'.repeat(65536) }), 413, 'PAYLOAD_TOO_LARGE'],
  ]) {
    const response = await fetch(`${base}/api/participant/logs`, { method: 'POST', headers, body });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
});
test('관리자 API는 인증이 연결되기 전까지 전체 차단한다', async () => {
  for (const route of ['participants', 'conversations', 'searches', 'surveys', 'logs']) {
    const response = await fetch(`${base}/api/admin/${route}`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'ADMIN_AUTH_NOT_CONFIGURED');
  }
});
test('존재하지 않는 API는 JSON 404이며 서버 파일은 정적 제공하지 않는다', async () => {
  for (const route of ['/api/missing', '/api/participant/missing', '/server.js', '/.env', '/backend/config.js']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 404, route);
    assert.ok((await response.json()).error.code);
  }
});
test('기존 프론트엔드 파일을 계속 제공한다', async () => {
  for (const [route, text] of [
    ['/', '연구 참여 및 장비 선정 과제'],
    ['/css/style.css', '#research-tools'],
    ['/js/app.js', 'initializeExperiment'],
  ]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(text));
  }
});
