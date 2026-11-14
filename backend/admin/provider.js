const {readOpenAIEnv}=require('../config');
const {parseDatabaseConfig}=require('../database/config');
const {createPool}=require('../database/connection');
const {createAdminRepository}=require('./data');
const {ApiError}=require('../middleware/errors');
function createAdminProvider(){let instance,pool;
 const get=()=>{if(instance)return instance;const values=readOpenAIEnv();
  if(!['test','research'].includes(values.DB_ENV))throw new ApiError(503,'ADMIN_DB_NOT_CONFIGURED','DB_ENV를 test 또는 research로 명시해 주세요.');
  const key=values.DB_ENV==='test'?'TEST_ADMIN_DATABASE_URL':'ADMIN_DATABASE_URL';
  if(!values[key])throw new ApiError(503,'ADMIN_DB_NOT_CONFIGURED',`관리자 전용 DB 연결을 설정해 주세요 (${key}).`);
  try{const config=parseDatabaseConfig({...values,TEST_DATABASE_URL:values[key],DATABASE_URL:values[key]});
   pool=createPool(config);pool.on('error',()=>console.error('ADMIN_DB_POOL_ERROR'));
   instance=createAdminRepository({pool,environment:config.environment,origin:values.APP_ORIGIN});return instance;
  }catch{throw new ApiError(503,'ADMIN_DB_NOT_CONFIGURED','관리자 전용 DB 연결 설정을 확인해 주세요.');}
 };
 get.close=async()=>{if(pool)await pool.end();};return get;
}
module.exports={createAdminProvider};
