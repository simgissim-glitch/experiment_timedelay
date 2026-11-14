# 동의·사전 설문·과제 안내의 서버 진행 관리

현재 범위는 동의 → 사전 설문 → 과제 안내 → 작업 화면 진입까지입니다.
최종 제출·사후 설문·완료 단계도 서버와 연결했습니다. 추가 API와 승인 정책은 [최종 진행 문서](FINAL_WORKFLOW.md)를 참고하세요.
기존과 같이 실제 연구 환경의 등록은 아직 차단합니다. 개발 테스트에서만 임시 적격성 확인을 허용합니다.
실제 Supabase 연결 정보가 없는 현재 환경에서는 저장 성공으로 대체하지 않고 503을 반환합니다.

## 연구 문구·적격성

- 동의서, 예상 소요 시간, 연락처, 개인정보 수집·보관·삭제·철회 정책은 연구자 확정 전 TODO입니다.
- 초안 동의서 버전은 `draft-consent-v1`이며 승인된 연구 동의서로 가장하지 않습니다.
- 사전 설문은 이용 경험 여부, 이용 빈도, 과제 사전지식으로 구성합니다.
- 문항·척도는 임시 초안이고 저장 버전은 `pre-draft-v1`입니다. 최종 제출되어도 문항 자체는 여전히 초안입니다.
- 이용 경험 some이면 빈도와 사전지식까지 필수입니다. 빈도 never는 경험 있음과 함께 최종 제출할 수 없습니다.
- 이용 경험 none을 제출하면 빈도를 never로 정규화하고 적격성 종료합니다. 불필요한 나머지 문항 응답을 강제하지 않습니다.
- 배정은 기존 개발용 등록 단계에서 이미 이루어지므로, 사전 설문에서 부적격이 확인된 참가자의 배정 기록은 변경·재배정하지 않고 제외 사유를 별도로 기록합니다.
- 조건 코드·지연 시간은 참가자 UI와 API 응답에 포함하지 않습니다. 정확성 검사나 AI 오류 탐지에 관한 새 안내도 추가하지 않습니다.

## 저장 데이터와 상태

`participant_sessions`에는 동의 시작 기준 시각(created_at), 동의 결정·완료 시각·문구 버전과 종료 구분을 저장합니다.
비동의는 참가자 ID·조건을 생성하지 않고 이 세션에만 기록합니다. 이후 같은 세션의 등록·진행을 거절합니다.

`participants`에는 current_step, screening_status, termination_reason과 기존 progress_status·ended_at을 저장합니다.
current_step은 현재 보는 단계이고, progress_status는 연구 진행·종료 상태입니다. 이전 화면 검토만으로 완료 이력을 취소하지 않습니다.
`participant_steps`에는 단계별 최초 시작·완료 시각을 저장합니다. 재방문·재시도는 이 시각을 다시 쓰지 않습니다.
완료하지 않고 중단한 단계의 completed_at은 NULL로 남습니다. 시각은 모두 서버 DB 시계 기준입니다.

`survey_responses`의 pre 행은 참가자당 한 건입니다.
is_draft, revision, questionnaire_version, answers, submitted_at, updated_at으로 초안·제출을 구분합니다.
빈 응답이나 일부 응답은 초안으로 저장할 수 있지만, 최종 제출은 필수 항목을 검증합니다.
초안에는 submitted_at이 없고, 최종 제출 시에만 서버가 시각을 기록합니다.
최종 제출 후에는 읽기 전용입니다. 문항 수정·재응답 정책은 추후 연구자가 결정해야 합니다.

| 상황 | 세션 disposition | 참가자 progress_status | ended_at |
| --- | --- | --- | --- |
| 진행 중·창 닫기·연결 끊김 | active | 마지막 진행 상태 | NULL |
| 최초 비동의 | declined | 참가자 행 없음 | 세션 terminated_at만 기록 |
| AI 이용 경험 없음 | ineligible | ineligible | 기록 |
| 참여 중단 버튼으로 확인 | withdrawn | withdrawn | 기록 |

브라우저 종료·visibilitychange·unload를 참여 중단으로 처리하지 않습니다.
명시적 중단은 확인 대화상자 이후 서버가 기록하며, 서버 저장이 실패하면 중단 완료를 표시하지 않습니다.
중단은 자료 자동 삭제를 뜻하지 않습니다. 보관·철회·삭제 정책은 TODO이며 실제 삭제 기능은 구현하지 않았습니다.

## API

기존 HttpOnly 쿠키를 사용하며 POST는 같은 Origin과 X-Experiment-Request 헤더를 검사합니다.
participant_id, 조건, 클라이언트 시각은 이 요청들의 본문으로 받지 않습니다.

| 요청 | 본문 | 처리 |
| --- | --- | --- |
| GET /api/participant/progress | 없음 | 본인 응답·current_step·단계 시각·종료 상태 복원 |
| POST /api/participant/surveys/pre | answers, mode: draft 또는 submit, revision | 초안 저장·최종 제출·경험 기준 종료 |
| POST /api/participant/progress/navigate | step | 이미 허가된 단계로 이동, current_step 갱신 |
| GET /api/participant/progress/access/:step | 없음 | 접근 가능 여부 검사 |
| POST /api/participant/progress/task-guide/complete | acknowledged: true | 과제 안내 완료와 작업 화면 시작 기록 |
| POST /api/participant/progress/end | reason: declined 또는 withdrawn | 비동의 또는 자발적 중단 기록 |
| GET /experiment/:step | 없음 | 서버가 접근을 검사한 뒤 HTML 제공 |

사전 설문 제출 예시:

```json
{
  "answers": { "aiExperience": "some", "aiFrequency": "weekly", "priorKnowledge": "medium" },
  "mode": "submit",
  "revision": 0
}
```

aiFrequency 임시 값은 never, rarely, monthly, weekly, daily입니다.
priorKnowledge 임시 값은 low, medium, high입니다.
revision은 마지막으로 복원한 pre_survey.revision입니다. 다른 탭이 수정한 오래된 버전은 409로 거절합니다.
같은 초안·최종 제출의 재시도는 중복 행·완료 시각을 만들지 않고 저장된 상태를 반환합니다.
DB 트랜잭션은 세션 행을 잠그므로 중단·제출·단계 이동이 경합해도 중단 후 새로운 저장으로 진행하지 않습니다.

## 복원·접근 검사

프론트엔드는 처음 열릴 때 서버의 current_step과 응답을 적용합니다.
선택 변경 후 약 700ms가 지나면 임시 저장하며, 임시 저장 버튼으로 바로 저장할 수도 있습니다.
다음 단계나 이전 화면으로 이동하기 전에는 진행 중인 저장을 기다립니다.
저장 전 새로고침하면 아직 서버에 보내지 않은 변경은 복원되지 않습니다. 화면의 저장 상태를 확인해야 합니다.
저장 실패 시 입력을 화면에 유지하고 실패를 표시합니다. 메모리 상태를 DB 저장 성공으로 표시하지 않습니다.

상단 링크와 URL의 해시도 서버 navigate API를 거칩니다. 해시는 서버에 전달되지 않으므로 이것만 권한으로 사용하지 않습니다.
실제 /experiment/:step 경로는 Express에서도 검사합니다. 허가된 진입 후에는 기본 주소로 정리하고 이후 새로고침은 DB 상태를 복원합니다.
사전 설문 제출 전 과제 안내, 과제 안내 확인 전 작업 화면, 최종 제출 전 사후 설문, 사후 설문 제출 전 디브리핑은 403입니다.
대화·검색 API도 작업 화면 접근 조건을 검사합니다. DOM을 변경하거나 HTTP를 직접 보내도 이 조건을 우회할 수 없습니다.
종료 상태는 새로고침해도 종료 안내를 복원하고, 단계 이동·새로운 설문 저장을 거절합니다.

## 마이그레이션·검증

001·002 다음에 `database/migrations/003_early_workflow.sql`을 신뢰할 수 있는 마이그레이션 관리자 계정으로 적용합니다.
실제 DB에 자동 적용하지 않았고 기존 .env도 수정하지 않았습니다.
003은 기존 참가자 ID·조건·배정 시각을 바꾸지 않습니다.
기존 DB 시각에서 이관한 단계 기록에는 timing_source=legacy-derived를 붙여 실제 화면 관찰 시각과 구분합니다.
신규 기록은 observed입니다. 미확정 과거 문구 버전은 legacy-unspecified로 표시합니다.
이전 버전에서 수동 입력한 설문·복잡한 진행 상태가 있으면 연구자가 상태 이관 기준을 검토해야 합니다.

DB 앱 역할에는 제한된 SECURITY DEFINER 함수 실행만 허용하고 테이블 직접 접근은 금지합니다.
현재 버전 요구는 3이며 미적용·권한 부족·접속 실패 시 503입니다.

```sh
node --test tests/workflow.test.js tests/enrollment.test.js tests/database.test.js tests/api.test.js tests/flow.test.js
node --test tests/browser.test.js
npm.cmd run db:check
npm.cmd run dev
```

자동 테스트는 매번 폐기하는 메모리 PostgreSQL(PGlite)에서 실제 SQL을 실행합니다. 실제 Supabase 연구 데이터는 사용하지 않습니다.
Chrome 테스트는 정상 진행, 동의·초안·제출·current_step 복원, URL 차단, 비동의·경험 없음·명시적 중단의 종료 복원을 확인합니다.
실제 Supabase 네트워크·SSL·마이그레이션 적용은 연결 정보 설정 후 별도로 확인해야 합니다.
