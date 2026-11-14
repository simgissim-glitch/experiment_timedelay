// Interactive TTY only: never accept secrets in command-line arguments or echo them.
const {passwordHash}=require('./auth');
async function main(){
 if(!process.stdin.isTTY){console.error('터미널에서 npm.cmd run admin:password를 실행해 주세요.');process.exitCode=1;return;}
 const {emitKeypressEvents}=require('node:readline');emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();
 process.stdout.write('새 관리자 비밀번호 (12자 이상, 화면에 표시하지 않음): ');
 const password=await new Promise(resolve=>{let input='';const onKey=(str,key={})=>{
  if(key.ctrl&&key.name==='c'){process.stdin.setRawMode(false);process.exit(130);}
  if(key.name==='return'){process.stdin.removeListener('keypress',onKey);process.stdin.setRawMode(false);process.stdin.pause();resolve(input);}
  else if(key.name==='backspace')input=input.slice(0,-1);else if(str&&!key.ctrl&&input.length<1000)input+=str;
 };process.stdin.on('keypress',onKey);});
 if(password.length<12){console.error('\n12자 이상의 비밀번호가 필요합니다.');process.exitCode=1;return;}
 console.log('\n.env의 ADMIN_PASSWORD_HASH에 아래 값을 직접 저장하세요.');console.log(await passwordHash(password));
}
if(require.main===module)main().catch(()=>{console.error('비밀번호 해시 생성에 실패했습니다.');process.exitCode=1;});
