const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { parseDatabaseConfig } = require('../backend/database/config');
const { checkConnection } = require('../backend/database/connection');
const { validateRecord } = require('../backend/database/validation');

test('설정 누락·잘못된 환경·원격 비암호화·URL의 SSL 우회 옵션을 거절한다', () => {
  assert.throws(() => parseDatabaseConfig({}), { code: 'DB_NOT_CONFIGURED' });
  assert.throws(() => parseDatabaseConfig({ DATABASE_URL: 'postgres://u:p@research/db' }), { code: 'DB_NOT_CONFIGURED' });
  assert.throws(() => parseDatabaseConfig({ DB_ENV: 'other' }), { code: 'DB_CONFIG_INVALID' });
  for (const values of [
    { TEST_DATABASE_URL: 'https://invalid/db' },
    { TEST_DATABASE_URL: 'postgres://u:p@remote/db', DB_SSL_MODE: 'disable' },
    { TEST_DATABASE_URL: 'postgres://u:p@localhost/db?sslmode=no-verify' },
    { DB_ENV: 'research', DATABASE_URL: 'postgres://u:p@localhost/db', DB_SSL_MODE: 'disable' },
  ]) assert.throws(() => parseDatabaseConfig(values), { code: 'DB_CONFIG_INVALID' });
  assert.equal(parseDatabaseConfig({ TEST_DATABASE_URL: 'postgres://u:p@localhost/test', DB_SSL_MODE: 'disable' }).environment, 'test');
  assert.equal(parseDatabaseConfig({ DB_ENV: 'research', DATABASE_URL: 'postgres://u:p@remote/research?sslmode=verify-full' }).sslMode, 'verify-full');
});

test('연결 점검은 읽기 전용이며 환경 불일치·연결 실패를 성공으로 반환하지 않는다 (테스트 대역)', async () => {
  for (const environment of ['test', 'research']) {
    const queries = [];
    let released = false;
    let ended = false;
    const factory = () => ({
      connect: async () => ({
        query: async (sql) => { queries.push(sql); return { rows: [{ environment }] }; },
        release: () => { released = true; },
      }),
      end: async () => { ended = true; },
    });
    if (environment === 'test') assert.equal((await checkConnection({ environment: 'test' }, factory)).status, 'ok');
    else await assert.rejects(checkConnection({ environment: 'test' }, factory), { code: 'DB_ENV_MISMATCH' });
    assert.equal(queries[0], 'BEGIN READ ONLY');
    assert.ok(!queries.some((sql) => /INSERT|UPDATE|DELETE|CREATE/.test(sql)));
    assert.ok(released && ended);
  }
  await assert.rejects(checkConnection({}, () => ({ connect: async () => { throw Error('secret-url'); }, end: async () => {} })),
    (error) => error.code === 'DB_CONNECTION_FAILED' && !error.message.includes('secret-url'));
});

test('서버 저장 경계에서 UUID·URL·시간·필드·공백을 검증한다', () => {
  const base = { participant_id: randomUUID(), request_id: randomUUID() };
  assert.ok(validateRecord('final_decisions', { ...base, product_code: 'A', rationale: '선정 이유' }));
  for (const [table, input] of [
    ['final_decisions', { ...base, product_code: 'A', rationale: '   ' }],
    ['participants', { request_id: randomUUID(), consent: true, condition_code: 'c1' }],
    ['search_events', { ...base, query: 'query', executed_at: 'yesterday' }],
    ['source_events', { ...base, source_url: 'javascript:alert(1)' }],
    ['source_events', { ...base, source_url: 'https://u:password@example.com' }],
    ['source_events', { ...base, source_url: 'https://example.com', accessed_at: '2026-01-02T00:00:00.000Z', returned_at: '2026-01-01T00:00:00.000Z' }],
    ['chat_messages', { ...base, participant_id: 'not-uuid', role: 'user', sequence_number: 1, content: 'test' }],
  ]) assert.throws(() => validateRecord(table, input), { code: 'VALIDATION_ERROR' });
});

test('격리된 메모리 PostgreSQL에서 마이그레이션·중복·관계·동의·권한을 검증한다', async () => {
  const db = new PGlite();
  const sql = await fs.readFile(path.join(__dirname, '../backend/database/migrations/001_initial_schema.sql'), 'utf8');
  try {
    await db.exec("SET ai_latency.environment = 'test'; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
    await db.exec(sql);
    const metadata = await db.query('SELECT environment FROM ai_latency_private.deployment_context');
    assert.equal(metadata.rows[0].environment, 'test');
    const insertParticipant = async (consent = true) => (await db.query(`
      INSERT INTO ai_latency_private.participants (request_id, consent, consented_at, progress_status, ended_at)
      VALUES ($1, $2, CASE WHEN $2 THEN now() END, CASE WHEN $2 THEN 'registered' ELSE 'declined' END,
              CASE WHEN NOT $2 THEN now() END) RETURNING participant_id`, [randomUUID(), consent])).rows[0].participant_id;
    const participant = await insertParticipant();
    const other = await insertParticipant();
    const declined = await insertParticipant(false);
    const request = randomUUID();
    await db.query("INSERT INTO ai_latency_private.final_decisions (participant_id, request_id, product_code, rationale) VALUES ($1,$2,'A','선정 이유')", [participant, request]);
    await assert.rejects(db.query("INSERT INTO ai_latency_private.final_decisions (participant_id, request_id, product_code, rationale) VALUES ($1,$2,'B','다른 이유')", [participant, randomUUID()]), { code: '23505' });
    await assert.rejects(db.query("INSERT INTO ai_latency_private.behavior_events (participant_id, request_id, event_type) VALUES ($1,$2,'test')", [randomUUID(), randomUUID()]), { code: '23514' });
    await assert.rejects(db.query("INSERT INTO ai_latency_private.behavior_events (participant_id, request_id, event_type) VALUES ($1,$2,'test')", [declined, randomUUID()]), { code: '23514' });
    const searchRequest = randomUUID();
    const search = (await db.query("INSERT INTO ai_latency_private.search_events (participant_id, request_id, query) VALUES ($1,$2,'test') RETURNING search_event_id", [participant, searchRequest])).rows[0].search_event_id;
    await assert.rejects(db.query("INSERT INTO ai_latency_private.search_events (participant_id, request_id, query) VALUES ($1,$2,'retry')", [participant, searchRequest]), { code: '23505' });
    await assert.rejects(db.query("INSERT INTO ai_latency_private.source_events (participant_id, request_id, search_event_id, source_url) VALUES ($1,$2,$3,'https://example.com')", [other, randomUUID(), search]), { code: '23503' });
    await assert.rejects(db.query("INSERT INTO ai_latency_private.source_events (participant_id, request_id, source_url, accessed_at, returned_at) VALUES ($1,$2,'https://example.com','2026-01-02','2026-01-01')", [participant, randomUUID()]), { code: '23514' });
    await db.query("INSERT INTO ai_latency_private.chat_messages (participant_id, request_id, sequence_number, role, content) VALUES ($1,$2,1,'user','test')", [participant, randomUUID()]);
    await assert.rejects(db.query("INSERT INTO ai_latency_private.chat_messages (participant_id, request_id, sequence_number, role, content) VALUES ($1,$2,1,'assistant','reply')", [participant, randomUUID()]), { code: '23505' });
    await db.query("INSERT INTO ai_latency_private.survey_responses (participant_id, request_id, phase, questionnaire_version, answers) VALUES ($1,$2,'pre','draft','{\"q\":1}')", [participant, randomUUID()]);
    await assert.rejects(db.query("INSERT INTO ai_latency_private.survey_responses (participant_id, request_id, phase, questionnaire_version, answers) VALUES ($1,$2,'pre','draft','{\"q\":2}')", [participant, randomUUID()]), { code: '23505' });
    await assert.rejects(db.query('DELETE FROM ai_latency_private.participants WHERE participant_id=$1', [participant]), (error) => ['23503', '23001'].includes(error.code));
    const tables = await db.query("SELECT count(*)::int AS total FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ai_latency_private' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity");
    assert.equal(tables.rows[0].total, 8);
    for (const role of ['anon', 'authenticated', 'service_role', 'ai_latency_app']) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT * FROM ai_latency_private.participants'), { code: '42501' });
      if (role === 'ai_latency_app') assert.equal((await db.query('SELECT environment FROM ai_latency_private.deployment_context')).rows[0].environment, 'test');
      await db.exec('RESET ROLE');
    }
    // 테이블 권한이 실수로 생겨도 앱 역할에는 RLS 조회 정책이 없어 전체 행이 보이지 않는다.
    await db.exec('GRANT SELECT ON ai_latency_private.participants TO ai_latency_app; SET ROLE ai_latency_app');
    assert.equal((await db.query('SELECT * FROM ai_latency_private.participants')).rows.length, 0);
    await db.exec('RESET ROLE; REVOKE SELECT ON ai_latency_private.participants FROM ai_latency_app; SET ROLE ai_latency_admin');
    assert.equal((await db.query('SELECT * FROM ai_latency_private.participants')).rows.length, 3);
    await assert.rejects(db.query('DELETE FROM ai_latency_private.participants'), { code: '42501' });
    await db.exec('RESET ROLE');
    await assert.rejects(db.exec(sql));
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS total FROM ai_latency_private.participants')).rows[0].total, 3);
  } finally { await db.close(); }
});
