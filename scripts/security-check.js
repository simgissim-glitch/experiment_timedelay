const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
function scan({directory=root,secretValues=[]}={}){
 const findings=[];let scanned=0;const ignored=new Set(['node_modules','.git','.vercel','.codex','.agents','.aws','secrets','exports','research-exports']);
 function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(entry.isSymbolicLink())continue;
  if(entry.isDirectory()){if(!ignored.has(entry.name))walk(path.join(dir,entry.name));continue;}
  if(entry.name.startsWith('.env')&&entry.name!=='.env.example')continue;
  if(!/\.(js|json|html|css|md|yml|yaml|txt|csv)$/.test(entry.name)&&!['.gitignore','.vercelignore'].includes(entry.name))continue;
  const file=path.join(dir,entry.name),relative=path.relative(directory,file).replaceAll('\\','/');
  const content=fs.readFileSync(file,'utf8');scanned++;
  if(/sk-(?:proj-)?[A-Za-z0-9_-]{24,}/.test(content)||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content))findings.push({file:relative,code:'POSSIBLE_SECRET_LITERAL'});
  for(const value of secretValues.filter(v=>typeof v==='string'&&v.length>=16))if(content.includes(value))findings.push({file:relative,code:'CONFIGURED_SECRET_FOUND'});
  if(relative.startsWith('public/')&&/process\.env\.(OPENAI_API_KEY|DATABASE_URL|ADMIN_PASSWORD_HASH)|localStorage\.setItem\([^\n]*(password|apiKey|accessToken)/i.test(content))findings.push({file:relative,code:'BROWSER_SECRET_PATTERN'});
 }}walk(directory);return {scanned,findings};
}
function check(){const env=require('../backend/environment').readServerEnv();const result=scan({secretValues:['OPENAI_API_KEY','SEARCH_API_KEY','DATABASE_URL','TEST_DATABASE_URL','ADMIN_PASSWORD_HASH','ADMIN_DATABASE_URL','TEST_ADMIN_DATABASE_URL'].map(k=>env[k])});
 let git='not_initialized',history_verified=false;
 const probe=cp.spawnSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8',windowsHide:true});
 if(probe.status===0&&path.resolve(probe.stdout.trim())===root){git='initialized';
  const tracked=cp.spawnSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',windowsHide:true});
  for(const file of (tracked.stdout||'').split('\0').filter(Boolean))if(/(^|\/)\.env(?:\.|$)/.test(file)&&!file.endsWith('.env.example')||/\.(pem|key|p12|pfx)$/.test(file)||/(^|\/)secrets\//.test(file))result.findings.push({file,code:'TRACKED_SECRET_FILE'});
 }
 return {status:result.findings.length?'failed':'ok',...result,git,history_verified,github_verified:false};
}
if(require.main===module){try{const result=check();console.log(JSON.stringify(result,null,2));if(result.status!=='ok')process.exitCode=1;}catch{console.error(JSON.stringify({status:'error',code:'SECURITY_CHECK_FAILED'}));process.exitCode=1;}}
module.exports={scan,check};
