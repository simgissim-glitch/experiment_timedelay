const { randomBytes, createHash, randomInt } = require('node:crypto');
const { ApiError } = require('../middleware/errors');

// 참가자 응답에는 이 매핑을 포함하지 않는다. 공개 기한은 DB 함수에서 결정한다.
const CONDITION_DELAYS_MS = Object.freeze({ A: 2000, B: 9000, C: 20000 });
const conditions = Object.keys(CONDITION_DELAYS_MS);
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const validToken = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

class EnrollmentRepository {
  constructor(pool, environment) { this.pool = pool; this.environment = environment; }
  async query(sql, args) {
    try {
      const context = await this.pool.query('SELECT environment, schema_version FROM ai_latency_private.deployment_context WHERE singleton = true');
      if (context.rows.length !== 1 || context.rows[0].environment !== this.environment || context.rows[0].schema_version !== 10) {
        throw new ApiError(503, 'DB_NOT_READY', '데이터베이스 환경과 마이그레이션 상태를 확인해 주세요.');
      }
      return await this.pool.query(sql, args);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error.code === '28000') throw new ApiError(401, 'SESSION_INVALID', '참여 세션이 유효하지 않습니다.');
      if (error.code === '42501') throw new ApiError(403, 'STEP_NOT_ALLOWED', '필요한 참여 절차를 먼저 완료해 주세요.');
      if (error.code === '22023') throw new ApiError(400, 'VALIDATION_ERROR', '입력 항목과 응답 값을 확인해 주세요.');
      if (error.code === '40001') throw new ApiError(409, 'STALE_RESPONSE', '다른 화면에서 응답이 변경되었습니다. 저장된 응답을 다시 확인해 주세요.');
      if (error.code === '55000') throw new ApiError(409, 'PARTICIPATION_LOCKED', '종료되었거나 제출이 완료된 참여 정보는 변경할 수 없습니다.');
      throw new ApiError(503, 'DB_UNAVAILABLE', '참여 정보를 확인하거나 저장하지 못했습니다. 다시 시도해 주세요.');
    }
  }
  async create(hash, ttl) {
    await this.query('SELECT ai_latency_private.enrollment_create_session($1, $2)', [hash, ttl]);
  }
  async status(hash) {
    return (await this.query('SELECT * FROM ai_latency_private.enrollment_session_status($1)', [hash])).rows[0];
  }
  async register(hash, condition, version) {
    return (await this.query('SELECT * FROM ai_latency_private.enrollment_register($1, $2, $3)', [hash, condition, version])).rows[0];
  }
  async workflow(method, hash, args = []) {
    const queries = {
      state: 'SELECT ai_latency_private.workflow_state($1) AS state',
      terminate: 'SELECT ai_latency_private.workflow_terminate($1,$2) AS state',
      savePre: 'SELECT ai_latency_private.workflow_save_pre($1,$2::jsonb,$3,$4) AS state',
      navigate: 'SELECT ai_latency_private.workflow_navigate($1,$2) AS state',
      completeTask: 'SELECT ai_latency_private.workflow_complete_task($1) AS state',
      final: 'SELECT ai_latency_private.workflow_final($1,$2,$3::jsonb) AS state',
      access: 'SELECT ai_latency_private.workflow_access($1,$2) AS allowed',
    };
    return (await this.query(queries[method], [hash, ...args])).rows[0];
  }
  async telemetry(method,hash,args=[]){
    const queries={context:'SELECT ai_latency_private.research_context($1) AS result',ingest:'SELECT ai_latency_private.research_ingest($1,$2::jsonb) AS result'};
    return (await this.query(queries[method],[hash,...args])).rows[0].result;
  }
  async search(method,hash,args=[]){
    const queries={
      state:'SELECT ai_latency_private.search_state($1,$2) AS result',
      claim:'SELECT ai_latency_private.search_claim($1,$2,$3,$4) AS result',
      requested:'SELECT ai_latency_private.search_requested($1,$2,$3,$4::jsonb) AS result',
      finish:'SELECT ai_latency_private.search_finish($1,$2,$3::jsonb,$4) AS result',
      click:'SELECT ai_latency_private.search_click($1,$2,$3,$4,$5,$6) AS result',
    };
    return (await this.query(queries[method],[hash,...args])).rows[0].result;
  }
  async chat(method, hash, args = []) {
    const queries = {
      state:'SELECT ai_latency_private.chat_state($1) AS result',
      stimulus:'SELECT ai_latency_private.chat_stimulus($1,$2::jsonb) AS result',
      claim:'SELECT ai_latency_private.chat_claim($1,$2,$3,$4,$5,coalesce($6::timestamptz,clock_timestamp()),$7::timestamptz) AS result',
      ready:'SELECT ai_latency_private.chat_ready($1,$2,$3) AS result',
      release:'SELECT ai_latency_private.chat_release($1,$2) AS result',
      presentation:'SELECT ai_latency_private.chat_presentation($1,$2,$3,$4,$5,$6) AS result',
      context:'SELECT ai_latency_private.chat_context($1,$2) AS result',
      finish:'SELECT ai_latency_private.chat_finish($1,$2,$3,$4,$5) AS result',
    };
    if(method==='claim' && args.length===4) args=[...args,null,null];
    return (await this.query(queries[method],[hash,...args])).rows[0].result;
  }
}

function publicStatus(row) {
  // 허용 목록으로 직렬화한다. DB 열이 추가돼도 조건·시각·토큰은 노출하지 않는다.
  if (!row) throw new ApiError(401, 'SESSION_INVALID', '참여 세션이 유효하지 않습니다.');
  return row.registered
    ? { registered: true, participant_id: row.participant_id, progress_status: row.progress_status }
    : { registered: false };
}

function createEnrollmentService({ repository, environment, eligibilityPolicy = 'pending', ttlSeconds = 2592000, draw = randomInt }) {
  async function status(token) {
    if (!validToken(token)) throw new ApiError(401, token === undefined ? 'SESSION_REQUIRED' : 'SESSION_INVALID', '참여 세션 확인이 필요합니다.');
    return publicStatus(await repository.status(tokenHash(token)));
  }
  return {
    status,
    async prepare(token) {
      if (token !== undefined) return { status: await status(token) };
      const newToken = randomBytes(32).toString('base64url');
      await repository.create(tokenHash(newToken), ttlSeconds);
      return { token: newToken, status: { registered: false } };
    },
    async register(token, input) {
      if (input.consent !== true) throw new ApiError(400, 'CONSENT_REQUIRED', '참여 동의가 필요합니다.');
      if (environment !== 'test' || eligibilityPolicy !== 'development-only') {
        throw new ApiError(503, 'ELIGIBILITY_NOT_CONFIGURED', '연구 참여 자격 확인 기준이 아직 구성되지 않았습니다.');
      }
      if (input.eligibility?.testEligible !== true) throw new ApiError(403, 'NOT_ELIGIBLE', '참여 자격 확인을 완료해 주세요.');
      const existing = await status(token);
      if (existing.registered) {
        if (['withdrawn','ineligible','declined','completed'].includes(existing.progress_status)) {
          throw new ApiError(409, 'PARTICIPATION_LOCKED', '종료된 참여 세션으로 다시 등록할 수 없습니다.');
        }
        return existing;
      }
      const condition = conditions[draw(conditions.length)];
      return publicStatus(await repository.register(tokenHash(token), condition, 'development-only-v1'));
    },
  };
}

module.exports = { EnrollmentRepository, createEnrollmentService, CONDITION_DELAYS_MS, tokenHash, validToken };
