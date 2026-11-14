const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {setTimeout:wait}=require('node:timers/promises');
async function runChromeHarness(browser,profile,url,{viewport}={}){
  const process=spawn(browser,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let ws;
  try{
    let port;for(let i=0;i<100;i++){try{port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await wait(100);}}
    if(!port)throw Error('Chrome debugging port unavailable');
    const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
    let id=0;const requests=new Map();ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){const call=requests.get(message.id);requests.delete(message.id);message.error?call.reject(Error(message.error.message)):call.resolve(message.result);}});
    const send=(method,params)=>new Promise((resolve,reject)=>{const next=++id;requests.set(next,{resolve,reject});ws.send(JSON.stringify({id:next,method,params}));});
    if(viewport)await send('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:viewport.width<600});
    await send('Page.navigate',{url});
    for(let i=0;i<600;i++){
      await wait(100);
      const result=await send('Runtime.evaluate',{expression:"(()=>{if(window.testSourceReady&&!window.testSourceClicked){const f=document.querySelector('iframe'),a=f.contentDocument.querySelector('#search-result-list a');a.scrollIntoView({block:'center'});const r=f.getBoundingClientRect(),s=a.getBoundingClientRect();return {click:{x:r.left+f.clientLeft+s.left+Math.min(s.width/2,20),y:r.top+f.clientTop+s.top+s.height/2}};}return document.getElementById('result')?.textContent;})()",returnByValue:true});
      const value=result.result?.value;
      if(value?.click){
        await send('Input.dispatchMouseEvent',{type:'mousePressed',...value.click,button:'left',clickCount:1});
        await send('Input.dispatchMouseEvent',{type:'mouseReleased',...value.click,button:'left',clickCount:1});
        await send('Runtime.evaluate',{expression:'window.testSourceClicked=true'});
        continue;
      }
      if(value?.startsWith('UI_FAIL'))throw Error(value);
      if(value==='UI_PASS')return value;
    }
    throw Error('Chrome harness timeout');
  }finally{ws?.close();process.kill();await wait(100);}
}
module.exports={runChromeHarness};
