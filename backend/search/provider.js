const {ApiError}=require('../middleware/errors');
function searchError(code){
  const messages={SEARCH_NOT_CONFIGURED:'검색 서비스가 아직 연결되지 않았습니다.',SEARCH_RATE_LIMITED:'검색 서비스 이용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',SEARCH_TIMEOUT:'검색 응답 시간이 초과되었습니다. 다시 시도해 주세요.',SEARCH_UNAVAILABLE:'검색 요청에 실패했습니다. 다시 시도해 주세요.',SEARCH_INVALID_RESPONSE:'검색 결과를 처리하지 못했습니다. 다시 시도해 주세요.'};
  return new ApiError(code==='SEARCH_RATE_LIMITED'?429:code==='SEARCH_TIMEOUT'?504:code==='SEARCH_NOT_CONFIGURED'?503:502,code,messages[code]||messages.SEARCH_UNAVAILABLE);
}
function parseSearchConfig(values){
  if(values.SEARCH_PROVIDER!=='brave'||!values.SEARCH_API_KEY?.trim())throw searchError('SEARCH_NOT_CONFIGURED');
  const count=Number(values.SEARCH_RESULT_COUNT||10),country=values.SEARCH_COUNTRY||'KR',language=values.SEARCH_LANGUAGE||'ko';
  if(!Number.isInteger(count)||count<1||count>20||!['KR','US','GB','JP'].includes(country)||!['ko','en','ja'].includes(language))throw searchError('SEARCH_NOT_CONFIGURED');
  return {apiKey:values.SEARCH_API_KEY.trim(),count,country,language};
}
function validSourceURL(value){
  if(typeof value!=='string'||value.length>4096||/\s/.test(value))return false;
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&Boolean(url.hostname);}catch{return false;}
}
function plainText(value,max){
  return String(value??'').replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[name]).slice(0,max).trim();
}
function createBraveProvider(config,{fetchImpl=fetch,timeoutMs=10000}={}){
  const policy={version:'brave-web-v1',country:config.country,language:config.language,count:config.count,safesearch:'moderate',spellcheck:false};
  return {id:'brave',policy,async search(query){
    if(query.length>600||query.split(/\s+/u).length>75)throw new ApiError(400,'VALIDATION_ERROR','검색어는 600자, 75단어 이하로 입력해 주세요.');
    const url=new URL('https://api.search.brave.com/res/v1/web/search');
    for(const [key,value]of Object.entries({q:query,count:config.count,country:config.country,search_lang:config.language,result_filter:'web',text_decorations:false,spellcheck:false,safesearch:'moderate'}))url.searchParams.set(key,String(value));
    try{
      const response=await fetchImpl(url,{headers:{Accept:'application/json','X-Subscription-Token':config.apiKey},signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
      if(!response.ok)throw searchError(response.status===429?'SEARCH_RATE_LIMITED':'SEARCH_UNAVAILABLE');
      const data=await response.json();
      if(data.type!=='search'||(data.web!=null&&!Array.isArray(data.web.results)))throw searchError('SEARCH_INVALID_RESPONSE');
      return (data.web?.results||[]).slice(0,config.count).flatMap((entry,index)=>{
        const title=plainText(entry.title,1000);if(!title||!validSourceURL(entry.url))return [];
        return [{rank:index+1,title,description:plainText(entry.description,5000),url:entry.url}];
      });
    }catch(error){if(error instanceof ApiError)throw error;throw searchError(['TimeoutError','AbortError'].includes(error.name)?'SEARCH_TIMEOUT':'SEARCH_UNAVAILABLE');}
  }};
}
function validateResults(results){
  const seen=new Set();
  if(!Array.isArray(results)||results.length>20)throw searchError('SEARCH_INVALID_RESPONSE');
  for(const result of results){
    if(!result||!Number.isInteger(result.rank)||result.rank<1||result.rank>20||seen.has(result.rank)||
      typeof result.title!=='string'||!result.title.trim()||result.title.length>1000||typeof result.description!=='string'||result.description.length>5000||!validSourceURL(result.url))throw searchError('SEARCH_INVALID_RESPONSE');
    seen.add(result.rank);
  }
  return results.map(({rank,title,description,url})=>({rank,title,description,url}));
}
module.exports={parseSearchConfig,createBraveProvider,validSourceURL,searchError,validateResults};
