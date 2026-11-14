const {participantRows}=require('./data');
// One schema defines both the headers and codebook, even with no records.
const participantFields={
 environment:'데이터 환경 test/research',snapshot_at:'조회 스냅샷 생성 시각(서버 UTC)',participant_id:'서버 발급 익명 참가자 UUID',
 consent:'참여 동의 여부',consented_at:'동의 시각(서버 UTC)',condition_code:'DB 배정 조건 A=2초/B=9초/C=20초',progress_status:'서버 진행 상태; completed/withdrawn/ineligible 등',current_step:'현재 단계',screening_status:'적격성 pending/passed/failed',termination_reason:'명시적 종료 이유; 미완료만으로 중단 추정 안 함',
 started_at:'참여 시작 시각(서버 UTC)',ended_at:'전체 참여 종료 시각(서버 UTC)',created_at:'참가자 행 생성 시각(서버 UTC)',task_id:'서버 발급 과제 UUID',task_started_at:'작업 화면 시작 시각(서버 UTC)',final_submitted_at:'최종 답변 제출 시각(서버 UTC)',
 total_task_ms:'작업 시작~최종 제출 서버 경과 ms; 미제출/시간 불명은 결측',actual_delay_mean_ms:'본 참가자의 관측 가능한 질문 전송~첫 글자 표시 지연 평균 ms; 복원 표시 제외',actual_delay_observations:'실제 지연 평균에 사용한 답변 관측 수',
 search_attempt_count:'검색 실행 시도 수; 실패 포함',search_api_count:'검색 제공자 API 실제 요청 수',search_success_count:'검색 완료 수; 결과 0건 포함',source_click_count:'저장된 출처 클릭 수; 읽기 판정 아님',external_source_click_count:'앱과 다른 호스트의 출처 클릭 수; 독립성/읽기 판정 아님',unique_source_url_count:'서로 다른 출처 URL 수',
 pre_answers:'사전 설문 JSON: aiExperience=some/none, aiFrequency=never/rarely/monthly/weekly/daily, priorKnowledge=low/medium/high; 임시 문항',pre_is_draft:'사전 응답 임시 저장 여부; false여도 문항은 초안일 수 있음',pre_version:'사전 설문 버전',selected_product:'최종 선택 제품명',key_specifications:'자유 서술 주요 사양',rationale:'자유 서술 판단 이유',reference_notes:'참고 정보/출처 자유 서술',
 misinformation_acceptance:'연구자 판정 not_assessed/accepted/rejected/unclear; 자동 판정 아님',coding_revision:'코딩 수정 버전(0=최초 미코딩)',adjudication_notes:'연구자 코딩 메모',assessed_at:'연구자 코딩 저장 시각(서버 UTC)',assessed_by:'로그인한 연구자 계정명',
 post_answers:'사후 설문 JSON: perceivedDelay 1=매우 짧음~5=매우 김, naturalness 1=매우 부자연스러움~5=매우 자연스러움, suspectedDelay/suspectedPrewritten=yes/no/unsure; 임시 척도',post_version:'사후 설문 버전',post_submitted_at:'사후 설문 제출 시각(서버 UTC)',information_activity_ms:'관측된 검색 활성(결과 대기 제외)과 외부 출처 이탈 구간 합집합 ms; 실제 검증/독해 시간이 아님',ai_wait_union_ms:'관측된 AI 대기 구간 합집합 ms',
 step_times:'단계별 시작/완료 UTC 및 timing_source JSON 배열',quality:'시간 측정 누락/복원/중단/legacy/시계 종류 등 품질 지표 JSON',
};
const eventFields={environment:'데이터 환경 test/research',snapshot_at:'조회 스냅샷 생성 시각(서버 UTC)',event_id:'중복 제거 이벤트 UUID',participant_id:'참가자 UUID',task_id:'과제 UUID',condition_code:'이벤트 저장 당시 조건 A/B/C; legacy는 결측 가능',event_type:'이벤트 종류; 유형별 정의는 BEHAVIOR_LOGGING.md 참고',timestamp:'이벤트 시각; timestamp_source와 함께 해석',server_timestamp:'서버 수신/기록 시각 UTC',browser_timestamp:'브라우저 보고 시각 UTC; 서버 시각 아님',page_id:'페이지 로드별 UUID',performance_ms:'페이지 성능 시계 ms',performance_time_origin:'성능 시계 기준 epoch ms',origin:'server/browser/legacy',timestamp_source:'server/browser_reported/legacy_mixed',late_after_end:'종료 이후 수신된 재전송 여부',related_type:'연관 레코드 유형',related_id:'연관 UUID',payload:'유형별 원본 부가 필드 JSON',dedup_key:'서버 의미 단위 중복 제거 키'};
const chatFields={environment:'데이터 환경 test/research',snapshot_at:'조회 스냅샷 생성 시각(서버 UTC)',participant_id:'참가자 UUID',condition_code:'DB 배정 조건 A/B/C',chat_message_id:'메시지 UUID',request_id:'메시지 저장 중복 제거 UUID; 사용자/AI 각각 다를 수 있음',sequence_number:'참가자 내 대화 순서(정수)',role:'user/assistant',content:'저장된 메시지 본문',created_at:'메시지 DB 저장 시각 UTC; 화면 표시 시각과 구분'};
const schemas={participants:participantFields,events:eventFields,conversations:chatFields};
function text(value){if(value===null||value===undefined)return '';if(value instanceof Date)return value.toISOString();if(typeof value==='object')return JSON.stringify(value);return String(value);}
function cell(value){let s=text(value);if(typeof value==='string'&&(/^[\s\x00-\x1f]*[=+@-]/.test(s)||/^[\t\r\n]/.test(s)))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
function csv(headers,rows){return '\uFEFF'+[headers.map(cell).join(','),...rows.map(row=>headers.map(key=>cell(row[key])).join(','))].join('\r\n')+'\r\n';}
function exportRows(kind,s){
 if(kind==='participants')return participantRows(s);
 if(kind==='events')return s.research_events.map(row=>({environment:s.environment,snapshot_at:s.snapshot_at,...row}));
 if(kind==='conversations')return s.chat_messages.map(row=>({environment:s.environment,snapshot_at:s.snapshot_at,condition_code:s.participants.find(p=>p.participant_id===row.participant_id)?.condition_code??null,...row})).sort((a,b)=>a.participant_id.localeCompare(b.participant_id)||Number(a.sequence_number)-Number(b.sequence_number));
 throw Error('Unsupported CSV');
}
function codebook(){return Object.entries(schemas).flatMap(([file,fields])=>Object.entries(fields).map(([variable,meaning])=>({file:file+'.csv',variable,meaning,missing:'빈 셀=결측/미제출/관측 불가. 0/false와 구분. JSON 내부 null 유지.',format:'UTF-8 BOM, RFC4180. 시각 ISO8601 UTC, *_ms 밀리초. 수식 위험 문자열 앞에는 작은따옴표 추가.'})));}
module.exports={schemas,csv,exportRows,codebook};
