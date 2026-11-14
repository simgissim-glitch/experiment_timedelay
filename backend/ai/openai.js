const OpenAI = require('openai');
const { ApiError } = require('../middleware/errors');

const INSTRUCTIONS = '당신은 전문 장비 선정 과제를 돕는 AI입니다. 한국어로 명확하게 답하세요. 확인하지 않은 제품 사양이나 출처를 꾸며내지 말고 불확실한 점은 밝혀 주세요. 사용자가 이전 답변의 오류를 지적하면 근거를 검토하고 오류가 확인되면 인정하고 정정하세요. 실제로 웹 검색이나 제품 문서 조회를 수행한 것처럼 말하지 마세요. 미확정 과제나 제품의 세부 사양을 임의로 만들어내지 마세요.';
const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };
function parseOpenAIConfig(values) {
  if (!values.OPENAI_API_KEY?.trim()) throw new ApiError(503,'OPENAI_NOT_CONFIGURED','AI 연결 설정이 완료되지 않았습니다.');
  if (!values.OPENAI_MODEL?.trim()) throw new ApiError(503,'OPENAI_MODEL_NOT_CONFIGURED','AI 모델 설정이 완료되지 않았습니다.');
  const model=values.OPENAI_MODEL.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)) throw new ApiError(503,'OPENAI_MODEL_NOT_CONFIGURED','AI 모델 설정을 확인해 주세요.');
  return {apiKey:values.OPENAI_API_KEY.trim(),model};
}
function createClient(apiKey,options={}) {
  return new OpenAI({apiKey,baseURL:'https://api.openai.com/v1',organization:null,project:null,
    timeout:60000,maxRetries:0,logLevel:'off',logger:silentLogger,...options});
}
function normalizeAIError(error) {
  if (error instanceof ApiError) return error;
  if (error.status===429) return new ApiError(429,'AI_RATE_LIMITED','AI 서비스 이용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.');
  if ([401,403,404].includes(error.status)) return new ApiError(503,'AI_ACCESS_DENIED','AI 연결 설정 또는 서비스 권한을 확인해야 합니다.');
  if (['APIConnectionTimeoutError','TimeoutError'].includes(error.name)) return new ApiError(504,'AI_TIMEOUT','AI 응답을 완료하지 못했습니다. 다시 시도할 수 있습니다.');
  if (['APIUserAbortError','AbortError'].includes(error.name)) return new ApiError(502,'AI_INTERRUPTED','AI 응답 요청이 중단되었습니다.');
  return new ApiError(502,'AI_UNAVAILABLE','AI 서비스 요청에 실패했습니다. 다시 시도할 수 있습니다.');
}
function createOpenAIProvider(config,{client=createClient(config.apiKey),timeoutMs=60000}={}) {
  return {
    model:config.model,
    async complete(messages,{signal}={}) {
      const controller=new AbortController();
      const abort=()=>controller.abort();
      signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) controller.abort();
      let timer;
      try {
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{
          controller.abort();reject(new ApiError(504,'AI_TIMEOUT','AI 응답을 완료하지 못했습니다. 다시 시도할 수 있습니다.'));
        },timeoutMs);});
        const response=await Promise.race([client.responses.create({
          model:config.model,instructions:INSTRUCTIONS,input:messages,store:false,stream:false,max_output_tokens:2048,
        },{signal:controller.signal,maxRetries:0}),timeout]);
        if (controller.signal.aborted) throw new ApiError(502,'AI_INTERRUPTED','AI 응답 요청이 중단되었습니다.');
        if (response.status!=='completed') throw new ApiError(502,'AI_INTERRUPTED','AI 응답이 완성되지 않았습니다. 다시 시도할 수 있습니다.');
        const refusals=(response.output||[]).flatMap((item)=>item.content||[]).filter((part)=>part.type==='refusal').map((part)=>part.refusal).join('\n');
        const text=response.output_text?.trim()||refusals.trim();
        if (!text || text.length>50000) throw new ApiError(502,'AI_EMPTY_RESPONSE','표시할 수 있는 AI 응답을 받지 못했습니다.');
        return text;
      } catch(error) {throw normalizeAIError(error);}
      finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
    },
  };
}
module.exports={parseOpenAIConfig,createClient,createOpenAIProvider,normalizeAIError,INSTRUCTIONS};
