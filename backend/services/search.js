const {ApiError}=require('../middleware/errors');
const {validToken,tokenHash}=require('./enrollment');
const {searchError,validateResults}=require('../search/provider');
function createSearchService({repository,getProvider}){
  function hash(token){if(!validToken(token))throw new ApiError(401,'SESSION_INVALID','참여 세션을 확인해 주세요.');return tokenHash(token);}
  function check(state){if(state?.status==='failed')throw searchError(state.error_code);return state;}
  return {
    history:async token=>repository.search('state',hash(token),[null]),
    click:(token,input)=>repository.search('click',hash(token),[input.search_event_id,input.request_id,input.rank,input.source_url,input.clicked_at]),
    async execute(token,input){
      const h=hash(token),claim=await repository.search('claim',h,[input.request_id,input.query.trim(),input.submitted_at??null]);
      if(claim.error)throw new ApiError(claim.error==='SEARCH_REQUEST_CONFLICT'?409:429,claim.error,claim.error==='SEARCH_REQUEST_CONFLICT'?'기존 검색 요청과 내용이 다릅니다.':'검색 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.');
      if(!claim.execute)return check(await repository.search('state',h,[input.request_id]));
      let finished=false;
      try{
        const provider=getProvider();
        await repository.search('requested',h,[input.request_id,provider.id,JSON.stringify(provider.policy)]);
        const results=validateResults(await provider.search(input.query.trim()));
        finished=await repository.search('finish',h,[input.request_id,JSON.stringify(results),null]);
        if(!finished)throw new ApiError(403,'STEP_NOT_ALLOWED','현재 검색 요청을 완료할 수 없습니다.');
        return check(await repository.search('state',h,[input.request_id]));
      }catch(error){
        const safe=error instanceof ApiError?error:searchError('SEARCH_UNAVAILABLE');
        if(!finished)await repository.search('finish',h,[input.request_id,null,['SEARCH_NOT_CONFIGURED','SEARCH_RATE_LIMITED','SEARCH_TIMEOUT','SEARCH_INVALID_RESPONSE'].includes(safe.code)?safe.code:'SEARCH_UNAVAILABLE']);
        throw safe;
      }
    },
  };
}
module.exports={createSearchService};
