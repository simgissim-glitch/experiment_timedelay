const {readServerEnv}=require('../backend/environment');
const {parseDatabaseConfig}=require('../backend/database/config');
function assess(values,{target='persistent'}={}){
 const checks=[];const add=(id,ok,reason)=>checks.push({id,status:ok?'pass':'blocked',reason});
 add('explicit_environment',['test','research'].includes(values.DB_ENV),'DB_ENV를 명시하고 DB의 deployment_context와 실제 연결 점검으로 대조해야 합니다.');
 let db=false;try{parseDatabaseConfig(values);db=true;}catch{}
 add('database_config',db,'선택한 환경의 DB URL과 검증 가능한 TLS 설정이 필요합니다. 이 점검은 연결 성공을 뜻하지 않습니다.');
 let origin=false;try{origin=new URL(values.APP_ORIGIN).protocol==='https:';}catch{}
 add('https_origin',origin,'배포 도메인과 정확히 일치하는 HTTPS APP_ORIGIN이 필요합니다.');
 for(const key of ['OPENAI_API_KEY','OPENAI_MODEL','SEARCH_PROVIDER','SEARCH_API_KEY','ADMIN_USERNAME','ADMIN_PASSWORD_HASH'])add(key,Boolean(values[key]?.trim()),'서버 전용 설정이 필요합니다. 값은 보고서에 출력하지 않습니다.');
 for(const[id,parse]of [['openai_config_format',()=>require('../backend/ai/openai').parseOpenAIConfig(values)],['search_config_format',()=>require('../backend/search/provider').parseSearchConfig(values)],['admin_auth_format',()=>require('../backend/admin/auth').parseAdminConfig({...values,RUNTIME_MODE:'persistent'})]]){
  let ok=false;try{parse();ok=true;}catch{}add(id,ok,'설정 형식 검증이 필요합니다. 실제 연결 여부는 별도 점검합니다.');
 }
 add('admin_database',Boolean(values[values.DB_ENV==='test'?'TEST_ADMIN_DATABASE_URL':'ADMIN_DATABASE_URL']),'참가자 DB와 별개인 관리자 최소 권한 계정이 필요합니다.');
 add('researcher_release_approval',values.RESEARCH_RELEASE_APPROVED==='true','연구자 검토 전 배포 승인을 true로 설정하지 않습니다.');
 add('runtime_mode',target!=='vercel'&&values.RUNTIME_MODE!=='serverless','현재 관리자 세션·로그인 제한은 단일 프로세스 메모리입니다. 서버리스 공유 저장소/인증으로 교체하기 전 Vercel 전체 앱 배포는 차단합니다.');
 if(values.DB_ENV==='research'){
  let materials=false;try{require('../backend/study').loadMaterials('research');materials=true;}catch{}
  add('approved_research_materials',materials,'최초 질문·답변, 디브리핑 및 설문 문항/척도의 승인·버전 확정이 필요합니다.');
  add('eligibility_policy',false,'연구용 적격성·동의서 정책은 미확정이며 실제 등록 경로가 차단되어 있습니다.');
 }
 return {status:checks.every(c=>c.status==='pass')?'configuration_passed_not_deployed':'blocked',target,checks,live_database_verified:false,deployment_performed:false};
}
if(require.main===module){try{const arg=process.argv.find(a=>a.startsWith('--target=')),target=arg?.slice(9)||'persistent';if(!['persistent','vercel'].includes(target))throw Error();const result=assess(readServerEnv(),{target});console.log(JSON.stringify(result,null,2));if(result.status==='blocked')process.exitCode=1;}catch{console.error(JSON.stringify({status:'error',code:'DEPLOYMENT_CHECK_FAILED'}));process.exitCode=1;}}
module.exports={assess};
