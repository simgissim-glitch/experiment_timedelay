const { ApiError } = require('../middleware/errors');
const { isRecord } = require('../middleware/validate');
const { tokenHash, validToken } = require('./enrollment');
const { loadMaterials } = require('../study');

const STEPS = ['consent','pre-survey','task-guide','workspace','decision','post-survey','debriefing'];
function validatePreAnswers(answers, submit) {
  if (!isRecord(answers) || Object.keys(answers).some((key) => !['aiExperience','aiFrequency','priorKnowledge'].includes(key))) {
    throw new ApiError(400, 'VALIDATION_ERROR', '사전 설문 응답 항목을 확인해 주세요.');
  }
  const enums = { aiExperience: ['some','none'], aiFrequency: ['never','rarely','monthly','weekly','daily'], priorKnowledge: ['low','medium','high'] };
  for (const [key, value] of Object.entries(answers)) {
    if (!enums[key].includes(value)) throw new ApiError(400, 'VALIDATION_ERROR', '설문 응답 값이 올바르지 않습니다.');
  }
  const result = { ...answers };
  if (result.aiExperience === 'none') result.aiFrequency = 'never';
  if (submit && (!result.aiExperience || (result.aiExperience === 'some' && (!result.priorKnowledge || !result.aiFrequency || result.aiFrequency === 'never')))) {
    throw new ApiError(400, 'VALIDATION_ERROR', '필수 사전 설문 항목을 모두 응답해 주세요.');
  }
  return result;
}

function createWorkflowService(repository) {
  function hash(token) {
    if (!validToken(token)) throw new ApiError(401, token === undefined ? 'SESSION_REQUIRED' : 'SESSION_INVALID', '참여 세션 확인이 필요합니다.');
    return tokenHash(token);
  }
  async function call(method, token, args) {
    const state = (await repository.workflow(method, hash(token), args)).state;
    if (state.current_step === 'debriefing' && !state.debriefing) {
      const materials = loadMaterials(repository.environment);
      state.debriefing = { version:materials.debriefingVersion,draft:materials.draft,
        explanation:materials.explanation,correction:materials.correction,contactPolicy:materials.contactPolicy };
    }
    return state;
  }
  return {
    state: (token) => call('state', token),
    terminate: (token, reason) => call('terminate', token, [reason]),
    navigate: (token, step) => call('navigate', token, [step]),
    completeTask: (token) => { loadMaterials(repository.environment); return call('completeTask', token); },
    final(token, action, data = {}) {
      const materials = loadMaterials(repository.environment);
      if (action === 'decision') {
        for (const [key,max] of Object.entries({product:100,specifications:10000,rationale:10000,references:10000})) {
          if (typeof data[key] !== 'string' || data[key].length > max || (key !== 'references' && !data[key].trim()))
            throw new ApiError(400,'VALIDATION_ERROR','제품, 주요 사양과 판단 이유를 확인해 주세요.');
        }
      }
      if (action === 'post') {
        const enums={perceivedDelay:['1','2','3','4','5'],naturalness:['1','2','3','4','5'],suspectedDelay:['yes','no','unsure'],suspectedPrewritten:['yes','no','unsure']};
        if (!isRecord(data.answers) || Object.keys(data.answers).length!==4 || Object.entries(enums).some(([key,values])=>!values.includes(data.answers[key])))
          throw new ApiError(400,'VALIDATION_ERROR','사후 설문의 모든 문항에 응답해 주세요.');
      }
      const debriefing={version:materials.debriefingVersion,draft:materials.draft,explanation:materials.explanation,correction:materials.correction,contactPolicy:materials.contactPolicy};
      return call('final',token,[action,JSON.stringify({...data,survey_version:materials.surveyVersion,debriefing_version:materials.debriefingVersion,debriefing})]);
    },
    savePre(token, { answers, mode, revision }) {
      const normalized = validatePreAnswers(answers, mode === 'submit');
      return call('savePre', token, [JSON.stringify(normalized), mode === 'submit', revision]);
    },
    async access(token, step) {
      await repository.workflow('access', hash(token), [step]);
      return true;
    },
  };
}

module.exports = { createWorkflowService, validatePreAnswers, STEPS };
