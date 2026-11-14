const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { DatabaseConfigError } = require('./config');

function createPool(config) {
  let ca;
  if (config.caFile) {
    try { ca = fs.readFileSync(path.resolve(__dirname, '../..', config.caFile), 'utf8'); }
    catch { throw new DatabaseConfigError('DB_CA_UNREADABLE', 'DB SSL 인증서 파일을 읽을 수 없습니다.'); }
  }
  return new Pool({
    connectionString: config.connectionString,
    enableChannelBinding: config.enableChannelBinding === true,
    ssl: config.sslMode === 'disable' ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: config.serverless ? 1 : 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
    query_timeout: 5000, statement_timeout: 5000,
    application_name: 'ai-latency-experiment',
  });
}

async function checkConnection(config, poolFactory = createPool) {
  const pool = poolFactory(config);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT 1 AS connection_check');
    const result = await client.query('SELECT environment FROM ai_latency_private.deployment_context WHERE singleton = true');
    if (result.rows.length !== 1 || result.rows[0].environment !== config.environment) {
      throw new DatabaseConfigError('DB_ENV_MISMATCH', '접속 대상의 환경 표식이 DB_ENV와 일치하지 않습니다.');
    }
    await client.query('COMMIT');
    return { status: 'ok', environment: config.environment, message: '실제 DB 연결과 환경 표식 조회를 확인했습니다. 연구 데이터 쓰기는 수행하지 않았습니다.' };
  } catch (error) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    if (error instanceof DatabaseConfigError) throw error;
    if (['42P01', '3F000'].includes(error.code)) {
      throw new DatabaseConfigError('DB_SCHEMA_NOT_APPLIED', 'DB에 접속했으나 스키마가 적용되지 않았습니다. 연결 점검은 완료되지 않았습니다.');
    }
    if (error.code === '42501') throw new DatabaseConfigError('DB_ACCESS_DENIED', 'DB 계정에 환경 표식 조회 권한이 없습니다.');
    throw new DatabaseConfigError('DB_CONNECTION_FAILED', 'DB 연결 또는 조회에 실패했습니다. 주소·인증·SSL·네트워크 설정을 확인하세요.');
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

module.exports = { createPool, checkConnection };
