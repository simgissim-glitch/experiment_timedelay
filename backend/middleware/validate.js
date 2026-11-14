const { ApiError } = require('./errors');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (max) => (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const participantId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function validateBody(schema) {
  return (req, _res, next) => {
    if (!isRecord(req.body)) return next(new ApiError(400, 'VALIDATION_ERROR', 'JSON 객체 본문이 필요합니다.'));
    const invalid = Object.keys(req.body).filter((name) => !Object.hasOwn(schema, name));
    for (const [name, rule] of Object.entries(schema)) {
      if (rule.optional && !Object.hasOwn(req.body, name)) continue;
      if (!rule.check(req.body[name])) invalid.push(name);
    }
    if (invalid.length) {
      // 사용자 입력값·임의 필드 이름을 그대로 되돌려주지 않는다.
      const fields = Object.keys(schema).filter((name) => invalid.includes(name));
      return next(new ApiError(400, 'VALIDATION_ERROR', '필수 항목과 입력 형식을 확인해 주세요.', { fields, unknownFields: invalid.some((name) => !Object.hasOwn(schema, name)) }));
    }
    next();
  };
}

function validateParticipantId(req, _res, next) {
  if (!participantId(req.params.participantId)) return next(new ApiError(400, 'VALIDATION_ERROR', '참가자 식별자 형식이 올바르지 않습니다.'));
  next();
}

module.exports = { validateBody, validateParticipantId, text, participantId, isRecord };
