const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const mode=process.argv[2]||'server';
const files=fs.readdirSync(path.join(__dirname,'../tests')).filter(f=>f.endsWith('.test.js')).sort();
const browser=files.filter(f=>f.includes('browser')),server=files.filter(f=>!f.includes('browser'));
const groups=mode==='all'?[server,browser]:mode==='browser'?[browser]:mode==='server'?[server]:null;
if(!groups){console.error('테스트 종류: server / browser / all');process.exit(1);}
const started=new Date().toISOString(),runs=[];
const reportDir=path.join(__dirname,'../reports/test-runs');fs.mkdirSync(reportDir,{recursive:true});
const record=()=>fs.writeFileSync(path.join(reportDir,`${started.replaceAll(':','-')}-${mode}.json`),JSON.stringify({started_at:started,finished_at:new Date().toISOString(),mode,runs},null,2)+'\n');
for(const group of groups){
 // Browser rendering measurements run serially to avoid cross-test window focus
 // changes and CPU contention affecting presentation observations.
 const result=spawnSync(process.execPath,['--test',...(group===browser?['--test-concurrency=1']:[]),...group.map(f=>'tests/'+f)],{cwd:path.join(__dirname,'..'),env:process.env,stdio:'inherit',windowsHide:true});
 runs.push({files:group,exit_code:result.status,signal:result.signal||null});record();
 if(result.error||result.status!==0)process.exit(result.status||1);
}
