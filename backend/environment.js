const fs=require('node:fs');
const path=require('node:path');
const dotenv=require('dotenv');
// Local development deliberately reads .env only. Hosted runtimes use server-side
// environment variables and never fall back to a developer's bundled .env.
const KEYS=['PORT','DB_ENV','TEST_DATABASE_URL','DATABASE_URL','DB_SSL_MODE','DB_SSL_CA_FILE','APP_ORIGIN','ELIGIBILITY_POLICY','OPENAI_API_KEY','OPENAI_MODEL','SEARCH_PROVIDER','SEARCH_API_KEY','SEARCH_COUNTRY','SEARCH_LANGUAGE','SEARCH_RESULT_COUNT','ANALYSIS_DATABASE_URL','ADMIN_USERNAME','ADMIN_PASSWORD_HASH','TEST_ADMIN_DATABASE_URL','ADMIN_DATABASE_URL','RESEARCH_RELEASE_APPROVED'];
function readServerEnv({env=process.env,readFile=fs.readFileSync}={}){
 const source=env.SERVER_ENV_SOURCE||(env.VERCEL==='1'?'platform':'file');
 if(!['platform','file'].includes(source)||(env.VERCEL==='1'&&source!=='platform'))throw new Error('Invalid server environment source');
 let values={};
 if(source==='platform')values=Object.fromEntries(KEYS.filter(key=>typeof env[key]==='string').map(key=>[key,env[key]]));
 else try{values=dotenv.parse(readFile(path.join(__dirname,'..','.env')));}catch(error){if(error.code!=='ENOENT')throw error;}
 return {...values,RUNTIME_MODE:env.VERCEL==='1'?'serverless':'persistent',SERVER_ENV_SOURCE:source};
}
module.exports={readServerEnv,KEYS};
