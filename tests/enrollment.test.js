const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createApp } = require('../server');
const { EnrollmentRepository, createEnrollmentService, CONDITION_DELAYS_MS } = require('../backend/services/enrollment');

let db;
let server;
let base;
let service;
let repository;
let forcedDraw;
const origin = 'http://localhost:3000';
const config = { origin, cookieName: 'ai_latency_session', secure: false, ttlSeconds: 2592000 };
const enrollmentBody = { consent: true, eligibility: { testEligible: true } };
async function request(route, { cookie, body, headers = {} } = {}) {
  return fetch(base + '/api/participant/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin, 'X-Experiment-Request': '1' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function prepare() {
  const response = await request('session', { body: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { registered: false });
  return response.headers.get('set-cookie').split(';')[0];
}
before(async () => {
  db = new PGlite();
  await db.exec("SET ai_latency.environment = 'test'");
  for (const file of ['001_initial_schema.sql', '002_enrollment_sessions.sql', '003_early_workflow.sql', '004_chat.sql','005_response_timing.sql','006_initial_stimulus.sql','007_web_search.sql','008_research_events.sql','009_final_workflow.sql','010_admin_dashboard.sql']) {
    await db.exec(await fs.readFile(path.join(__dirname, '../backend/database/migrations', file), 'utf8'));
  }
  repository = new EnrollmentRepository(db, 'test');
  service = createEnrollmentService({ repository, environment: 'test', eligibilityPolicy: 'development-only',
    draw: (max) => { assert.equal(max, 3); return forcedDraw === undefined ? require('node:crypto').randomInt(max) : forcedDraw; } });
  server = createApp({ getEnrollment: () => ({ service, config, repository }) }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

test('동의·적격성 확인 전에는 참가자나 조건을 생성하지 않는다', async () => {
  const count = async () => Number((await db.query('SELECT count(*) AS n FROM ai_latency_private.participants')).rows[0].n);
  const start = await count();
  const cookie = await prepare();
  assert.equal(await count(), start);
  for (const [body, status] of [
    [{ consent: false, eligibility: { testEligible: true } }, 400],
    [{ consent: true, eligibility: { testEligible: false } }, 403],
    [{ consent: true }, 400],
    [{ ...enrollmentBody, condition: 'A' }, 400],
  ]) assert.equal((await request('participants', { cookie, body })).status, status);
  assert.equal(await count(), start);
});
test('세 조건의 저장·배정 시각·재접속 유지와 응답 비노출을 각각 검증한다', async () => {
  assert.deepEqual(CONDITION_DELAYS_MS, { A: 2000, B: 9000, C: 20000 });
  for (const [index, condition] of ['A', 'B', 'C'].entries()) {
    forcedDraw = index;
    const cookie = await prepare();
    const response = await request('participants', { cookie, body: enrollmentBody });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['participant_id', 'progress_status', 'registered']);
    assert.match(body.participant_id, /^[a-f0-9-]{36}$/);
    const original = (await db.query('SELECT condition_code, assigned_at, eligibility_version FROM ai_latency_private.participants WHERE participant_id=$1', [body.participant_id])).rows[0];
    assert.equal(original.condition_code, condition);
    assert.ok(original.assigned_at);
    assert.equal(original.eligibility_version, 'development-only-v1');
    forcedDraw = (index + 1) % 3;
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.deepEqual(await (await request('session', { cookie })).json(), body);
      assert.deepEqual(await (await request('participants', { cookie, body: enrollmentBody })).json(), body);
    }
    // 별도 서비스 인스턴스(서버 재시작에 해당)에서도 DB 세션을 복원한다.
    const restarted = createEnrollmentService({ repository: new EnrollmentRepository(db, 'test'), environment: 'test', eligibilityPolicy: 'development-only' });
    assert.deepEqual(await restarted.status(cookie.split('=')[1]), body);
    const after = (await db.query('SELECT condition_code, assigned_at, eligibility_version FROM ai_latency_private.participants WHERE participant_id=$1', [body.participant_id])).rows[0];
    assert.deepEqual(after, original);
    await assert.rejects(db.query('UPDATE ai_latency_private.participants SET condition_code=$1 WHERE participant_id=$2', [condition === 'A' ? 'B' : 'A', body.participant_id]), { code: '23514' });
  }
  forcedDraw = undefined;
});
test('같은 세션의 동시 등록 요청 12건도 참가자와 배정을 한 건만 생성한다', async () => {
  const cookie = await prepare();
  const responses = await Promise.all(Array.from({ length: 12 }, () => request('participants', { cookie, body: enrollmentBody })));
  const statuses = await Promise.all(responses.map(async (response) => { assert.equal(response.status, 200); return response.json(); }));
  assert.equal(new Set(statuses.map((body) => body.participant_id)).size, 1);
  const count = await db.query('SELECT count(*) AS n FROM ai_latency_private.participants WHERE participant_id=$1', [statuses[0].participant_id]);
  assert.equal(Number(count.rows[0].n), 1);
});
test('HttpOnly·SameSite·영속 쿠키를 사용하고 원본 토큰을 DB·JSON에 노출하지 않는다', async () => {
  const response = await request('session', { body: {} });
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Max-Age=2592000/i);
  assert.match(cookie, /Path=\//i);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const token = cookie.split(';')[0].split('=')[1];
  assert.ok(!JSON.stringify(await response.json()).includes(token));
  const row = (await db.query('SELECT token_hash FROM ai_latency_private.participant_sessions ORDER BY created_at DESC LIMIT 1')).rows[0];
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.token_hash, token);
});
test('미발급·변조·폐기 세션과 CSRF 요청을 거절한다', async () => {
  assert.equal((await request('session')).status, 401);
  assert.equal((await request('session', { cookie: 'ai_latency_session=' + 'x'.repeat(43) })).status, 401);
  assert.equal((await request('session', { cookie: 'ai_latency_session=', body: {} })).status, 401);
  assert.equal((await request('session', { body: {}, headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await request('session', { body: {}, headers: { 'X-Experiment-Request': '' } })).status, 403);
  const cookie = await prepare();
  const hash = require('node:crypto').createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  await db.query('UPDATE ai_latency_private.participant_sessions SET revoked_at=now() WHERE token_hash=$1', [hash]);
  assert.equal((await request('participants', { cookie, body: enrollmentBody })).status, 401);
});
test('만료 세션은 자동 재등록하거나 새 조건을 배정하지 않는다', async () => {
  const cookie = await prepare();
  const hash = require('node:crypto').createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  await request('participants', { cookie, body: enrollmentBody });
  await db.query("UPDATE ai_latency_private.participant_sessions SET created_at=now()-interval '40 days', expires_at=now()-interval '1 day' WHERE token_hash=$1", [hash]);
  const response = await request('session', { cookie, body: {} });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await request('participants', { cookie, body: enrollmentBody })).status, 401);
});
test('HTTPS 설정에서는 __Host 쿠키에 Secure를 설정하고 Domain을 지정하지 않는다', async () => {
  const secureServer = createApp({ getEnrollment: () => ({ service, config: {
    ...config, origin: 'https://experiment.example', secure: true, cookieName: '__Host-ai_latency_session',
  } }) }).listen(0, '127.0.0.1');
  await new Promise((resolve) => secureServer.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${secureServer.address().port}/api/participant/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://experiment.example', 'X-Experiment-Request': '1' }, body: '{}',
    });
    const cookie = response.headers.get('set-cookie');
    assert.equal(response.status, 200);
    assert.match(cookie, /^__Host-ai_latency_session=/);
    assert.match(cookie, /; Secure/i);
    assert.match(cookie, /; HttpOnly/i);
    assert.ok(!/Domain=/i.test(cookie));
  } finally {
    secureServer.closeAllConnections();
    await new Promise((resolve) => secureServer.close(resolve));
  }
});
test('다른 참가자 ID를 지정해도 접근할 수 없다', async () => {
  const cookie = await prepare();
  const body = await (await request('participants', { cookie, body: enrollmentBody })).json();
  assert.equal((await request(`participants/${body.participant_id}`, { cookie })).status, 200);
  assert.equal((await request('participants/00000000-0000-4000-8000-000000000001', { cookie })).status, 403);
  assert.equal((await request('conversations', { cookie, body: { participantId: 'someone-else', message: 'test' } })).status, 400);
  assert.equal((await request('conversations', { cookie, body: { request_id: '00000000-0000-4000-8000-000000000001', message: 'test' } })).status, 403);
});
test('실제 연구 환경에서는 미확정 개발용 적격성으로 등록할 수 없다', async () => {
  const research = createEnrollmentService({ repository: new EnrollmentRepository(db, 'research'), environment: 'research', eligibilityPolicy: 'development-only' });
  await assert.rejects(research.register('x'.repeat(43), enrollmentBody), { code: 'ELIGIBILITY_NOT_CONFIGURED' });
});
test('앱 DB 역할은 허용된 함수만 실행하고 조건 열·세션 테이블을 직접 읽지 못한다', async () => {
  const cookie = await prepare();
  const hash = require('node:crypto').createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  await db.exec('SET ROLE ai_latency_app');
  try {
    assert.equal((await service.register(cookie.split('=')[1], enrollmentBody)).registered, true);
    const rows = (await db.query('SELECT * FROM ai_latency_private.enrollment_session_status($1)', [hash])).rows;
    assert.equal(rows[0].registered, true);
    assert.equal(rows[0].condition_code, undefined);
    await assert.rejects(db.query('SELECT * FROM ai_latency_private.participants'), { code: '42501' });
    await assert.rejects(db.query('SELECT * FROM ai_latency_private.participant_sessions'), { code: '42501' });
  } finally { await db.exec('RESET ROLE'); }
});
test('실제 암호학적 난수로 생성한 개발용 표본에서 세 조건 모두 배정된다', async (t) => {
  const ids = [];
  for (let i = 0; i < 90; i++) {
    const cookie = await prepare();
    const response = await request('participants', { cookie, body: enrollmentBody });
    assert.equal(response.status, 200);
    ids.push((await response.json()).participant_id);
  }
  const groups = (await db.query('SELECT condition_code, count(*)::int AS n FROM ai_latency_private.participants WHERE participant_id = ANY($1::uuid[]) GROUP BY condition_code', [ids])).rows;
  assert.equal(groups.length, 3);
  assert.equal(groups.reduce((sum, group) => sum + group.n, 0), 90);
  await fs.writeFile(path.join(__dirname,'randomization-results.json'),JSON.stringify({generated_at:new Date().toISOString(),environment:'isolated PGlite; development-only; not research data',n:90,groups},null,2)+'\n');
  t.diagnostic(`격리된 테스트 DB의 무작위 표본(실제 연구 자료 아님): ${JSON.stringify(groups)}`);
});




