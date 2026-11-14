class DatabaseConfigError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function parseDatabaseConfig(values) {
  const environment = values.DB_ENV || 'test';
  if (!['test', 'research'].includes(environment)) {
    throw new DatabaseConfigError('DB_CONFIG_INVALID', 'DB_ENV는 test 또는 research여야 합니다.');
  }
  const key = environment === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const connectionString = values[key];
  if (!connectionString) throw new DatabaseConfigError('DB_NOT_CONFIGURED', `.env의 ${key}가 설정되지 않았습니다. 연결하지 않았습니다.`);
  let url;
  try { url = new URL(connectionString); } catch {
    throw new DatabaseConfigError('DB_CONFIG_INVALID', 'DB 연결 문자열 형식이 올바르지 않습니다.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2 || url.hash) {
    throw new DatabaseConfigError('DB_CONFIG_INVALID', '유효한 PostgreSQL 연결 문자열이 필요합니다.');
  }
  // node-postgres에서 URL SSL 옵션이 별도 ssl 객체를 덮어쓰지 않게 한다.
  if ([...url.searchParams.keys()].some((key) => !['sslmode', 'channel_binding'].includes(key)) ||
      ['sslmode', 'channel_binding'].some(key => url.searchParams.getAll(key).length > 1) ||
      (url.searchParams.has('sslmode') && !['require', 'verify-full'].includes(url.searchParams.get('sslmode'))) ||
      (url.searchParams.has('channel_binding') && url.searchParams.get('channel_binding') !== 'require')) {
    throw new DatabaseConfigError('DB_CONFIG_INVALID', 'URL 옵션은 sslmode=require 또는 verify-full, channel_binding=require만 허용합니다.');
  }
  const sslMode = values.DB_SSL_MODE || 'verify-full';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['verify-full', 'disable'].includes(sslMode) || (sslMode === 'disable' && (environment !== 'test' || !local))) {
    throw new DatabaseConfigError('DB_CONFIG_INVALID', '비암호화 연결은 로컬 테스트 DB에서만 허용합니다.');
  }
  const enableChannelBinding = url.searchParams.get('channel_binding') === 'require';
  if ((url.searchParams.has('sslmode') || enableChannelBinding) && sslMode === 'disable') {
    throw new DatabaseConfigError('DB_CONFIG_INVALID', 'URL TLS options conflict with disabled SSL');
  }
  url.search = '';
  return {
    environment, connectionString: url.toString(), sslMode,
    serverless:values.RUNTIME_MODE==='serverless', enableChannelBinding,
    caFile: values.DB_SSL_CA_FILE || null,
  };
}

module.exports = { DatabaseConfigError, parseDatabaseConfig };
