const {createHash}=require('node:crypto');
const {ApiError}=require('../middleware/errors');
function validateStimulus(value,environment){
  const fail=()=>{throw new ApiError(503,'CHAT_NOT_CONFIGURED','대화 설정을 확인해 주세요.');};
  if(!['test','research'].includes(environment)||value?.environment!==environment)fail();
  for(const [field,max] of Object.entries({version:100,question:10000,answer:50000,errorKey:100,expectedTruth:50000})){
    if(typeof value[field]!=='string'||!value[field].trim()||value[field].length>max)fail();
    if(environment==='research'&&/TODO/i.test(value[field]))fail();
  }
  if(environment==='research'&&value.approved!==true)fail();
  const snapshot={version:value.version,environment,question:value.question,answer:value.answer,errorKey:value.errorKey,expectedTruth:value.expectedTruth};
  return {...snapshot,fingerprint:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')};
}
function loadStimulus(environment){
  if(!['test','research'].includes(environment))throw new ApiError(503,'CHAT_NOT_CONFIGURED','대화 설정을 확인해 주세요.');
  return validateStimulus(require(environment==='test'?'./development.json':'./research.json'),environment);
}
module.exports={loadStimulus,validateStimulus};
