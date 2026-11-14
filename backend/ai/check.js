const { loadOpenAIConfig } = require('../config');
const { createOpenAIProvider } = require('./openai');
(async()=>{
  try {
    const provider=createOpenAIProvider(loadOpenAIConfig());
    const history=[{role:'user',content:'장비 선정 예산은 100만원입니다. 짧게 확인해 주세요.'}];
    const first=await provider.complete(history);
    history.push({role:'assistant',content:first},{role:'user',content:'제가 말한 예산은 얼마인가요? 짧게 답해 주세요.'});
    const second=await provider.complete(history);
    console.log(JSON.stringify({status:'ok',model:provider.model,first,second},null,2));
  }catch(error){console.error(JSON.stringify({status:'error',code:error.code||'AI_UNAVAILABLE'}));process.exitCode=1;}
})();
