const { ApiError } = require('../middleware/errors');
const { tokenHash, validToken } = require('./enrollment');
const { normalizeAIError } = require('../ai/openai');
const { setTimeout: wait } = require('node:timers/promises');
function createChatService({repository,getProvider,getStimulus=()=>null}) {
  function hash(token) {
    if (!validToken(token)) throw new ApiError(401,'SESSION_INVALID','참여 세션을 확인해 주세요.');
    return tokenHash(token);
  }
  async function prepare(h){const config=getStimulus();return config?repository.chat('stimulus',h,[JSON.stringify(config)]):null;}
  async function state(h){
    const stimulus=await prepare(h),history=await repository.chat('state',h);
    return stimulus?{...history,initial_required:stimulus.initial_required,initial_question:stimulus.initial_required?stimulus.question:null}:history;
  }
  return {
    history: token => state(hash(token)),
    presentation: (token,event)=>repository.chat('presentation',hash(token),[event.delivery_id,event.event,event.at,event.elapsed_ms??null,event.restored]),
    async send(token,{request_id,message,retry=false,submitted_at},{receivedAt=new Date().toISOString()}={}) {
      const h=hash(token),stimulus=await prepare(h);
      const fixed=stimulus&&(stimulus.initial_required||stimulus.first_request_id===request_id);
      const provider=fixed?null:getProvider();
      const claim=await repository.chat('claim',h,[request_id,message,retry,fixed?'fixed-initial:'+stimulus.version:provider.model,receivedAt,submitted_at??null]);
      if (claim.error) throw new ApiError(/RATE|LIMIT/.test(claim.error)?429:409,claim.error,
        /RATE|LIMIT/.test(claim.error)?'대화 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.':'다른 요청이 진행 중이거나 기존 요청과 내용이 다릅니다. 대화를 새로 확인해 주세요.');
      async function result(){
        const release=await repository.chat('release',h,[request_id]);
        if(release) await wait(Math.max(0,new Date(release).getTime()-Date.now()));
        const history=await state(h);
        return {request_id,status:history.requests.find(r=>r.request_id===request_id)?.status,...history};
      }
      if (!claim.execute) return result();
      let finished=false;
      try {
        const context=await repository.chat('context',h,[request_id]);
        if (context.reduce((sum,item)=>sum+item.content.length,0)>120000) throw new ApiError(413,'CHAT_HISTORY_TOO_LONG','대화가 처리 가능한 길이를 초과했습니다. 연구자에게 문의해 주세요.');
        // HTTP 연결이 끊겨도 같은 작업을 완료하여 새로고침 재생성을 막는다.
        const answer=fixed?stimulus.answer:await provider.complete(context);
        await repository.chat('ready',h,[request_id,claim.attempt_id]);
        finished=await repository.chat('finish',h,[request_id,claim.attempt_id,answer,null]);
        if (!finished) throw new ApiError(502,'AI_INTERRUPTED','응답 요청이 중단되었습니다.');
        return result();
      } catch(error) {
        const safe=normalizeAIError(error);
        if (!finished) await repository.chat('finish',h,[request_id,claim.attempt_id,null,
          ['AI_RATE_LIMITED','AI_ACCESS_DENIED','AI_TIMEOUT','AI_INTERRUPTED','AI_UNAVAILABLE','AI_EMPTY_RESPONSE','CHAT_HISTORY_TOO_LONG'].includes(safe.code)?safe.code:'AI_UNAVAILABLE']);
        throw safe;
      }
    },
  };
}
module.exports={createChatService};
