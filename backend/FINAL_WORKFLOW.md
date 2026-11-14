# 최종 의사결정·사후 설문·디브리핑

기존 001~008 다음에 `database/migrations/009_final_workflow.sql`을 관리자 계정으로 적용하고 관리자 기능용 010도 이어 적용합니다. 기존 데이터는 삭제하지 않습니다. 서버와 분석 명령은 schema_version=10을 요구합니다. 실제 연구 등록은 기존 미확정 적격성 정책에 따라 계속 차단됩니다.

## 저장과 진행

- `POST /api/participant/progress/workspace/complete`: `{acknowledged:true}`. 작업 단계를 완료하고 최종 결정 화면을 시작합니다. 진행 중인 AI/검색 요청이 있으면 거절합니다.
- `POST /api/participant/decisions`: `{request_id,product,specifications,rationale,references}`. 제품명(100자), 주요 사양·판단 이유(각 10,000자)는 필수, 참고 출처는 선택입니다. 서버 시각으로 저장한 후 사후 설문을 시작합니다.
- `POST /api/participant/surveys/post`: `{request_id,answers:{perceivedDelay,naturalness,suspectedDelay,suspectedPrewritten}}`. 앞 두 항목은 문자열 1~5, 뒤 두 항목은 yes/no/unsure입니다. 의심의 두 대상을 별도 문항으로 나눴습니다. 문항·척도는 모두 임시 초안입니다.
- `POST /api/participant/progress/debriefing/complete`: `{acknowledged:true}`. 안내 확인 시 debriefing 단계를 완료하고 progress_status=completed, ended_at을 기록합니다.
- `GET /api/participant/progress`: 저장된 답변·진행·일곱 단계의 시작/완료 시각과 본인에게 제공된 디브리핑을 복원합니다. 제출 전 최종 답변과 사후 설문 입력은 메모리 초안이며 새로고침 복원 대상이 아닙니다.

모든 쓰기는 HttpOnly 세션과 동일 출처 검사로 보호합니다. participant_id, 조건, 제출 시각, 판정 결과는 클라이언트가 지정할 수 없습니다. 세션 행 잠금·참가자별 UNIQUE 제약으로 동시 제출을 직렬화합니다. 동일 내용 재시도는 기존 상태를 반환하고, 다른 내용은 409로 거절합니다. 응답을 받지 못해도 저장 성공으로 추정하지 않습니다. 제출된 최종 답변은 DB 트리거로 UPDATE/DELETE를 차단합니다.

최종 제출은 final_decisions.submitted_at과 research_tasks.submitted_at, final_submitted 이벤트에 기록됩니다. 전체 과제 시간은 작업 화면 시작부터 최종 제출까지이며 사후 설문·디브리핑 시간을 포함하지 않습니다. 단계 시작/완료는 participant_steps에 서버 시각으로 기록하며, 중단·미완료는 완료로 처리하지 않습니다. 최종 제출 후에는 작업 화면으로 되돌아갈 수 없고 저장된 최종 답변만 읽기 전용으로 확인할 수 있습니다.

## 연구자 판정과 편집

`final_decisions.misinformation_acceptance`는 not_assessed(기본), accepted, rejected, unclear 중 하나이며 assessed_at/assessed_by를 함께 기록합니다. 자동 판정하지 않고 참가자 API에도 노출하지 않습니다. 연구자 판정은 인증된 [관리자 화면](ADMIN.md)에서 수행하며, 010의 제한된 코딩 함수와 수정 이력을 사용합니다. 최종 답변 본문은 바꾸지 않습니다.

연구자 편집 영역은 서버 전용 `study/development.json`과 `study/research.json`입니다. explanation, correction, contactPolicy를 편집합니다. HTML에는 이를 textContent로 표시하는 읽기 전용 영역만 있으며 참가자는 내용을 편집할 수 없습니다. 사후 설문 제출 시 디브리핑 버전·내용을 참가자 레코드에 스냅샷으로 저장하므로 이후 파일 변경으로 이미 제공된 설명이 바뀌지 않습니다. 설문 버전은 survey_responses.questionnaire_version에 저장합니다.

development.json은 가상 루멘 T1의 잘못된 12시간을 8시간으로 정정하는 개발 전용 초안입니다. 실제 제품 사양이나 가짜 출처를 사용하지 않습니다. research.json은 TODO와 approved:false 상태입니다. research 환경에서는 미승인·TODO·임시 문구·테스트 환경 혼용을 거절하며, 최초 자극물의 별도 승인도 확인합니다. 사후 설문 문항/척도를 실제 연구용으로 확정할 때 HTML·서버 검증·SQL 검증·surveyVersion을 함께 변경하고 연구자 승인 후 approved를 변경해야 합니다. 승인 표시만 바꿔 실제 연구 준비를 완료했다고 간주하지 마세요. 동의서·적격성·보관/철회 정책의 기존 차단도 별도로 유지됩니다.

## 확인

`node --test tests/workflow.test.js tests/flow.test.js`로 필수값·순서 검사, 제출 잠금과 재시도, 응답 복원, 일곱 단계 시각, 연구자 판정 비노출과 미승인 자료 차단을 검사합니다. `node --test tests/browser.test.js`는 숨김 Chrome과 격리된 PGlite에서 실제 화면 이동을 확인합니다. 브라우저 테스트의 AI·검색 제공자는 테스트 대역이며 실제 OpenAI/Supabase 연결 성공을 뜻하지 않습니다.
