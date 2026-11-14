const { ApiError } = require('../middleware/errors');
const { isRecord, text } = require('../middleware/validate');
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const url = (value) => {
  if (!text(4096)(value) || /\s/.test(value)) return false;
  try { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && Boolean(parsed.hostname) && !parsed.username && !parsed.password; }
  catch { return false; }
};
const required = (check) => ({ check });
const optional = (check) => ({ check, optional: true });
const base = { participant_id: required(uuid), request_id: required(uuid) };
const schemas = {
  participants: { request_id: required(uuid), consent: required((value) => typeof value === 'boolean') },
  survey_responses: {
    ...base, phase: required((value) => ['pre', 'post'].includes(value)),
    questionnaire_version: required(text(100)),
    answers: required((value) => isRecord(value) && Object.keys(value).length > 0),
  },
  chat_messages: {
    ...base, sequence_number: required((value) => Number.isSafeInteger(value) && value > 0),
    role: required((value) => ['user', 'assistant'].includes(value)), content: required(text(50000)),
  },
  search_events: { ...base, query: required(text(1000)), executed_at: optional(timestamp) },
  source_events: {
    ...base, search_event_id: optional((value) => value === null || uuid(value)),
    source_url: required(url), accessed_at: optional(timestamp),
    returned_at: optional((value) => value === null || timestamp(value)),
  },
  behavior_events: { ...base, event_type: required(text(100)), payload: required(isRecord), occurred_at: optional(timestamp) },
  final_decisions: {
    ...base, product_code: required(text(100)), rationale: required(text(10000)),
    reference_notes: optional((value) => value === null || (typeof value === 'string' && value.length <= 10000)),
  },
};

// 다음 저장 단계의 서버/서비스 경계에서 호출할 검증기. 지금은 저장 API에 연결하지 않는다.
// participant_id·role·sequence는 이후 인증된 세션/서버에서 결정해야 한다.
function validateRecord(table, input) {
  if (!Object.hasOwn(schemas, table) || !isRecord(input)) throw new ApiError(400, 'VALIDATION_ERROR', '지원하는 데이터 객체가 필요합니다.');
  const schema = schemas[table];
  const bad = Object.entries(schema).filter(([name, rule]) =>
    !(rule.optional && !Object.hasOwn(input, name)) && !rule.check(input[name])).map(([name]) => name);
  const unknown = Object.keys(input).some((name) => !Object.hasOwn(schema, name));
  if (input.returned_at && input.accessed_at && input.returned_at < input.accessed_at) bad.push('returned_at');
  if (bad.length || unknown) throw new ApiError(400, 'VALIDATION_ERROR', '저장 데이터의 항목과 형식을 확인해 주세요.', { fields: bad, unknownFields: unknown });
  return { ...input };
}

module.exports = { validateRecord };
