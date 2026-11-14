const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EnrollmentRepository}=require('../backend/services/enrollment');
test('DB failures identify schema, authentication, TLS and network without leaking original errors',async()=>{
 for(const [source,expected] of [['42P01','DB_SCHEMA_NOT_APPLIED'],['3F000','DB_SCHEMA_NOT_APPLIED'],['28P01','DB_AUTH_FAILED'],['UNABLE_TO_VERIFY_LEAF_SIGNATURE','DB_TLS_FAILED'],['ENOTFOUND','DB_CONNECTION_FAILED']]){
  const repository=new EnrollmentRepository({query:async()=>{throw Object.assign(new Error('secret-marker'),{code:source});}},'test');
  await assert.rejects(repository.query('SELECT 1'),e=>e.status===503&&e.code===expected&&!e.message.includes('secret-marker'));
 }
});
