const { ApiError } = require('../middleware/errors');
const { loadStimulus } = require('../stimuli');
function validateMaterials(value, environment) {
  const fail = () => { throw new ApiError(503,'STUDY_NOT_APPROVED','연구 안내 설정이 완료되지 않았습니다. 연구 담당자에게 문의해 주세요.'); };
  if (!['test','research'].includes(environment) || value?.environment !== environment) fail();
  for (const key of ['surveyVersion','debriefingVersion','explanation','correction','contactPolicy']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > (key.endsWith('Version') ? 100 : 10000)) fail();
    if (environment === 'research' && /TODO|임시|개발 테스트/.test(value[key])) fail();
  }
  if (environment === 'research' && value.approved !== true) fail();
  return { ...value, draft:environment === 'test' };
}
function loadMaterials(environment) {
  const value = validateMaterials(require(environment === 'test' ? './development.json' : './research.json'),environment);
  if (environment === 'research') loadStimulus(environment);
  return value;
}
module.exports = { loadMaterials, validateMaterials };
