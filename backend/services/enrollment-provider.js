const { loadDatabaseConfig, loadEnrollmentConfig } = require('../config');
const { createPool } = require('../database/connection');
const { EnrollmentRepository, createEnrollmentService } = require('./enrollment');
const { ApiError } = require('../middleware/errors');
const { DatabaseConfigError } = require('../database/config');

function createEnrollmentProvider() {
  let instance;
  let pool;
  const get = () => {
    if (instance) return instance;
    let stage = 'DATABASE_SETTINGS';
    try {
      const database = loadDatabaseConfig();
      stage = 'APP_ORIGIN_SETTINGS';
      const config = loadEnrollmentConfig(database.environment);
      stage = 'DATABASE_POOL_SETTINGS';
      pool = createPool(database);
      pool.on('error', () => console.error('DB_POOL_ERROR'));
      const repository = new EnrollmentRepository(pool, database.environment);
      const service = createEnrollmentService({
        repository,
        environment: database.environment,
        eligibilityPolicy: config.eligibilityPolicy,
        ttlSeconds: config.ttlSeconds,
      });
      instance = { service, config, repository };
      return instance;
    } catch (error) {
      // Return only fixed configuration diagnostics, never the original error,
      // connection string, environment values, or stack trace.
      const known = error instanceof DatabaseConfigError;
      const code = known ? error.code : stage === 'APP_ORIGIN_SETTINGS' ? 'APP_ORIGIN_INVALID' : 'ENROLLMENT_NOT_CONFIGURED';
      throw new ApiError(503, code,
        known ? error.message : '참여 등록 서버 설정이 완료되지 않았습니다.', { stage });
    }
  };
  get.close = async () => { if (pool) await pool.end(); };
  return get;
}

module.exports = { createEnrollmentProvider };
