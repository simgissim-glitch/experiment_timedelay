const {loadStimulus}=require('../stimuli');
const {loadOpenAIConfig}=require('../config');
const {createOpenAIProvider}=require('./openai');
(async()=>{
  try{
    const stimulus=loadStimulus('test');
    const answer=await createOpenAIProvider(loadOpenAIConfig()).complete([
      {role:'user',content:stimulus.question},{role:'assistant',content:stimulus.answer},
      {role:'user',content:'배터리 한 개가 4시간이면 두 개는 8시간 아닌가요? 이전 답변을 검토해 주세요.'},
    ]);
    console.log(JSON.stringify({status:'ok',scenario:'development-fictional-only',answer},null,2));
  }catch(error){console.error(JSON.stringify({status:'error',code:error.code||'AI_UNAVAILABLE'}));process.exitCode=1;}
})();
