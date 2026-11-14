const {createAdminProvider}=require('./provider');
const {overview,participantRows}=require('./data');
const {csv,schemas,exportRows,codebook}=require('./csv');
// Counts and exported identifiers are compared with persisted rows, not demo values.
function parseCSV(input){const rows=[];let row=[],cell='',quoted=false;const s=input.replace(/^\uFEFF/,'');
 for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'){if(quoted&&s[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&s[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}
 if(row.length||cell){row.push(cell);rows.push(row);}return rows;
}
function verifySnapshot(s){
 const failures=[],check=(ok,label)=>{if(!ok)failures.push(label);},o=overview(s),p=participantRows(s);
 check(o.total===s.participants.length,'participants_count');
 check(o.completed===s.participants.filter(r=>r.progress_status==='completed').length,'completed_count');
 check(o.search.attempts===s.search_events.length,'search_count');check(o.search.source_clicks===s.source_events.length,'source_count');
 for(const c of o.conditions){const own=s.participants.filter(r=>r.condition_code===c.condition);check(c.assigned===own.length&&c.completed===own.filter(r=>r.progress_status==='completed').length,'condition_'+c.condition);}
 const counts={};
 for(const kind of Object.keys(schemas)){
  const rows=parseCSV(csv(Object.keys(schemas[kind]),exportRows(kind,s))),headers=rows.shift();counts[kind]=rows.length;
  const key={participants:'participant_id',events:'event_id',conversations:'chat_message_id'}[kind],table={participants:'participants',events:'research_events',conversations:'chat_messages'}[kind];
  check(rows.length===s[table].length,kind+'_row_count');
  check(new Set(rows.map(r=>r[headers.indexOf(key)])).size===rows.length,kind+'_unique_keys');
  check(rows.every(r=>s[table].some(original=>original[key]===r[headers.indexOf(key)])),kind+'_db_identifiers');
  // Compare every directly stored exported column, including JSON, Unicode,
  // multiline messages and the documented spreadsheet-safe string prefix.
  const render=value=>{
   if(value===null||value===undefined)return '';
   if(value instanceof Date)return value.toISOString();
   if(typeof value==='object')return JSON.stringify(value);
   const text=String(value);
   return typeof value==='string'&&(/^[\s\x00-\x1f]*[=+@-]/.test(text)||/^[\t\r\n]/.test(text))?"'"+text:text;
  };
  for(const row of rows){const stored=s[table].find(r=>r[key]===row[headers.indexOf(key)]);
   if(!stored)continue;
   for(const column of headers.filter(h=>Object.hasOwn(stored,h)))check(row[headers.indexOf(column)]===render(stored[column]),kind+'_column_'+column);
   if(kind==='participants'){
    const final=s.final_decisions.find(r=>r.participant_id===stored.participant_id),pre=s.survey_responses.find(r=>r.participant_id===stored.participant_id&&r.phase==='pre'),post=s.survey_responses.find(r=>r.participant_id===stored.participant_id&&r.phase==='post');
    for(const[column,expected]of Object.entries({selected_product:final?.product_code,key_specifications:final?.key_specifications,rationale:final?.rationale,reference_notes:final?.reference_notes,misinformation_acceptance:final?.misinformation_acceptance,adjudication_notes:final?.adjudication_notes,pre_answers:pre?.answers,post_answers:post?.answers}))check(row[headers.indexOf(column)]===render(expected),'participant_answer_'+column);
   }
  }
  check(headers.every(h=>codebook().some(c=>c.file===kind+'.csv'&&c.variable===h)),kind+'_codebook');
 }
 for(const r of p){check(r.search_attempt_count===s.search_events.filter(x=>x.participant_id===r.participant_id).length,'participant_search_'+r.participant_id);check(r.source_click_count===s.source_events.filter(x=>x.participant_id===r.participant_id).length,'participant_source_'+r.participant_id);}
 return {status:failures.length?'mismatch':'ok',environment:s.environment,snapshot_at:s.snapshot_at,counts,failures:[...new Set(failures)],scope:'반복 읽기 DB 스냅샷과 CSV 행 수·키·저장 열 값·응답·집계 대조; 시계 정확성 판정 아님'};
}
async function main(){const get=createAdminProvider();try{const result=verifySnapshot(await get().snapshot());console.log(JSON.stringify(result));if(result.status!=='ok')process.exitCode=1;}catch(error){console.error(JSON.stringify({status:'error',code:error.code||'ADMIN_VERIFY_FAILED',message:'실제 관리자 DB 연결·대조를 완료하지 못했습니다.'}));process.exitCode=1;}finally{await get.close();}}
if(require.main===module)main();module.exports={parseCSV,verifySnapshot};
