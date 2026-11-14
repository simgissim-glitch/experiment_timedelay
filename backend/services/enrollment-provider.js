const { loadDatabaseConfig, loadEnrollmentConfig } = require('../config');
const { createPool } = require('../database/connection');
const { EnrollmentRepository, createEnrollmentService } = require('./enrollment');
const { ApiError } = require('../middleware/errors');

function createEnrollmentProvider() {
  let instance;
  let pool;
  const get = () => {
    if (instance) return instance;
    try {
      const database = loadDatabaseConfig();
      const config = loadEnrollmentConfig(database.environment);
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
      throw new ApiError(503, error.code === 'DB_NOT_CONFIGURED' ? 'DB_NOT_CONFIGURED' : 'ENROLLMENT_NOT_CONFIGURED',
        '참여 등록 서버 설정이 완료되지 않았습니다.');
    }
  };
  get.close = async () => { if (pool) await pool.end(); };
  return get;
}

module.exports = { createEnrollmentProvider };
