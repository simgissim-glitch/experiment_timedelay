const {readServerEnv}=require('./environment');

// 환경 파일은 서버 시작 시에만 읽는다. 설정 객체나 비밀키를 API에 반환하지 않는다.
function loadConfig() {
  const rawPort = readServerEnv().PORT ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid PORT');
  }
  return { port };
}

module.exports = { loadConfig };

// 로컬은 .env, 명시적 배포 모드는 서버 플랫폼 변수만 읽는다. CLI 인수로 비밀값을 받지 않는다.
function loadDatabaseConfig() {
  const values = readServerEnv();
  return require('./database/config').parseDatabaseConfig(values);
}

module.exports.loadDatabaseConfig = loadDatabaseConfig;

function loadEnrollmentConfig(environment) {
  const values = readServerEnv();
  const origin = values.APP_ORIGIN || `http://localhost:${values.PORT || '3000'}`;
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('Invalid APP_ORIGIN'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== origin || parsed.username || parsed.password ||
      (parsed.protocol !== 'https:' && !(environment === 'test' && local && parsed.protocol === 'http:'))) {
    throw new Error('APP_ORIGIN must use HTTPS except for local tests');
  }
  return {
    origin, secure: parsed.protocol === 'https:',
    cookieName: parsed.protocol === 'https:' ? '__Host-ai_latency_session' : 'ai_latency_session',
    ttlSeconds: 2592000,
    eligibilityPolicy: values.ELIGIBILITY_POLICY || (environment === 'test' ? 'development-only' : 'pending'),
  };
}
module.exports.loadEnrollmentConfig = loadEnrollmentConfig;

function readOpenAIEnv() {
  return readServerEnv();
}
function loadOpenAIConfig() { return require('./ai/openai').parseOpenAIConfig(readOpenAIEnv()); }
module.exports.loadOpenAIConfig=loadOpenAIConfig;
module.exports.readOpenAIEnv=readOpenAIEnv;
function loadSearchConfig(){
  const values=readServerEnv();
  return require('./search/provider').parseSearchConfig(values);
}
module.exports.loadSearchConfig=loadSearchConfig;
