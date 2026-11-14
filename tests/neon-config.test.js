const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseDatabaseConfig}=require('../backend/database/config');
const {createPool}=require('../backend/database/connection');
test('Neon URL options preserve certificate verification and enable channel binding',async()=>{
 const config=parseDatabaseConfig({TEST_DATABASE_URL:'postgresql://fixture:fixture@db.example.org/test?sslmode=require&channel_binding=require'});
 assert.equal(config.sslMode,'verify-full');
 assert.equal(new URL(config.connectionString).search,'');
 const pool=createPool(config);
 try{assert.equal(pool.options.ssl.rejectUnauthorized,true);assert.equal(pool.options.enableChannelBinding,true);}finally{await pool.end();}
});
test('Unsafe, unknown, duplicate, and conflicting TLS options are rejected',()=>{
 for(const query of ['sslmode=no-verify','channel_binding=disable','sslmode=require&sslmode=disable','unknown=true']){
  assert.throws(()=>parseDatabaseConfig({TEST_DATABASE_URL:'postgres://fixture:fixture@remote/test?'+query}),{code:'DB_CONFIG_INVALID'});
 }
 assert.throws(()=>parseDatabaseConfig({TEST_DATABASE_URL:'postgres://fixture:fixture@localhost/test?sslmode=require',DB_SSL_MODE:'disable'}),{code:'DB_CONFIG_INVALID'});
});
