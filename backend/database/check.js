const { loadDatabaseConfig } = require('../config');
const { checkConnection } = require('./connection');
const { DatabaseConfigError } = require('./config');

async function main() {
  try {
    console.log(JSON.stringify(await checkConnection(loadDatabaseConfig())));
  } catch (error) {
    const safe = error instanceof DatabaseConfigError ? error
      : new DatabaseConfigError('DB_CHECK_FAILED', 'DB 설정 또는 연결 점검에 실패했습니다.');
    console.error(JSON.stringify({ status: 'error', code: safe.code, message: safe.message }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();
