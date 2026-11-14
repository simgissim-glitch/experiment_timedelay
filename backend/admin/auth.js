const {randomBytes,scrypt,timingSafeEqual,createHash}=require('node:crypto');
const {promisify}=require('node:util');
const {ApiError}=require('../middleware/errors');
const derive=promisify(scrypt);
const digest=value=>createHash('sha256').update(value).digest();
function parseAdminConfig(values){
 if(values.RUNTIME_MODE==='serverless')throw new ApiError(503,'ADMIN_SERVERLESS_UNSUPPORTED','서버리스 관리자 세션 저장소가 준비되지 않았습니다.');
 const fail=()=>{throw new ApiError(503,'ADMIN_AUTH_NOT_CONFIGURED','관리자 인증 설정이 필요합니다.');};
 if(!['test','research'].includes(values.DB_ENV)||!values.ADMIN_USERNAME||values.ADMIN_USERNAME.trim()!==values.ADMIN_USERNAME||values.ADMIN_USERNAME.length>100)fail();
 const match=/^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(values.ADMIN_PASSWORD_HASH||'');if(!match)fail();
 let url;try{url=new URL(values.APP_ORIGIN);}catch{fail();}
 if(url.origin!==values.APP_ORIGIN||url.username||url.password||!(url.protocol==='https:'||(values.DB_ENV==='test'&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))fail();
 return {environment:values.DB_ENV,username:values.ADMIN_USERNAME,salt:match[1],hash:match[2],origin:url.origin,secure:url.protocol==='https:',
  cookieName:url.protocol==='https:'?'__Host-ai_latency_admin':'ai_latency_admin',ttlMs:30*60*1000};
}
async function passwordHash(password){const salt=randomBytes(16).toString('hex');return `scrypt:${salt}:${(await derive(password,salt,64)).toString('hex')}`;}
function createAdminAuth(getConfig){
 const sessions=new Map(),attempts=new Map();let global={until:0,count:0};
 const prune=()=>{const now=Date.now();for(const[k,v]of sessions)if(v.until<=now)sessions.delete(k);for(const[k,v]of attempts)if(v.until<=now)attempts.delete(k);};
 const cookie=(res,c,token)=>res.cookie(c.cookieName,token,{httpOnly:true,secure:c.secure,sameSite:'strict',path:'/',maxAge:c.ttlMs});
 function read(req,c){const parts=(req.get('cookie')||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(c.cookieName+'='));if(parts.length!==1)return null;const token=parts[0].slice(c.cookieName.length+1);return /^[A-Za-z0-9_-]{43}$/.test(token)?digest(token).toString('hex'):null;}
 function checkOrigin(req){const c=getConfig();if(req.get('origin')!==c.origin||req.get('x-admin-request')!=='1'||req.get('sec-fetch-site')==='cross-site')throw new ApiError(403,'ADMIN_ORIGIN_REJECTED','같은 관리자 사이트에서 요청해 주세요.');return c;}
 return {
  checkOrigin,
  require(req){const c=getConfig();prune();const session=sessions.get(read(req,c));if(!session||session.signature!==digest(c.environment+c.username+c.hash+c.origin).toString('hex'))throw new ApiError(401,'ADMIN_SESSION_REQUIRED','관리자 로그인이 필요합니다.');return {username:session.username,expires_at:new Date(session.until).toISOString()};},
  async login(req,res,username,password){
   const c=checkOrigin(req);prune();const now=Date.now(),key=digest(req.ip||'unknown').toString('hex');
   if(global.until<=now)global={until:now+900000,count:0};
   const rate=attempts.get(key)||{until:now+900000,count:0};
   if(rate.count>=5||global.count>=60||attempts.size>=10000)throw new ApiError(429,'ADMIN_LOGIN_LIMIT','로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.');
   rate.count++;global.count++;attempts.set(key,rate);
   const candidate=await derive(password,c.salt,64);
   if(!timingSafeEqual(candidate,Buffer.from(c.hash,'hex'))||!timingSafeEqual(digest(username),digest(c.username)))throw new ApiError(401,'ADMIN_LOGIN_FAILED','관리자 인증 정보를 확인해 주세요.');
   const previous=read(req,c);if(previous)sessions.delete(previous);
   if(sessions.size>=1000)throw new ApiError(429,'ADMIN_SESSION_LIMIT','관리자 세션 한도를 초과했습니다.');
   const token=randomBytes(32).toString('base64url');sessions.set(digest(token).toString('hex'),{username:c.username,until:now+c.ttlMs,signature:digest(c.environment+c.username+c.hash+c.origin).toString('hex')});
   cookie(res,c,token);return {authenticated:true,username:c.username,expires_at:new Date(now+c.ttlMs).toISOString()};
  },
  logout(req,res){const c=checkOrigin(req);sessions.delete(read(req,c));res.clearCookie(c.cookieName,{httpOnly:true,secure:c.secure,sameSite:'strict',path:'/'});return {authenticated:false};},
 };
}
module.exports={parseAdminConfig,createAdminAuth,passwordHash};
