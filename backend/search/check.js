const {loadSearchConfig}=require('../config');
const {createBraveProvider}=require('./provider');
(async()=>{
  try{
    const provider=createBraveProvider(loadSearchConfig());
    const results=await provider.search(process.argv[2]||'PostgreSQL documentation');
    console.log(JSON.stringify({status:'ok',results},null,2));
  }catch(error){console.error(JSON.stringify({status:'error',code:error.code||'SEARCH_UNAVAILABLE'}));process.exitCode=1;}
})();
