# API 구조 (참가자 등록·초기 진행 연동 단계)

`server.js`는 앱 구성과 실행을 담당하며 public 정적 제공을 유지합니다.
`backend/config.js`에서 서버 설정과 .env 파일을 읽습니다. 비밀키는 브라우저에 제공하지 않습니다.
`routes/participant/`는 업무별 경로, `routes/admin.js`는 관리자 경로입니다.
`middleware/validate.js`와 `middleware/errors.js`는 입력 검사와 공통 오류 처리를 담당합니다.
향후 실제 업무 처리는 `services/`, DB 연결은 `database/`로 분리합니다.

## 경로와 임시 입력 계약

| 메서드 | 경로 | JSON 본문 | 현재 응답 |
| --- | --- | --- | --- |
| GET | /api/health | 없음 | 200, 서버 상태만 확인 |
| POST | /api/participant/session | 빈 객체 `{}` | DB 세션 발급 또는 기존 세션 유지 |
| GET | /api/participant/session | 없음 | 본인 등록 상태만 조회 |
| GET | /api/participant/progress | 없음 | 본인 current_step·저장 응답·종료 상태 복원 |
| POST | /api/participant/surveys/pre | answers, mode, revision | 사전 설문 임시 저장·제출 |
| POST | /api/participant/progress/navigate | step | 서버 권한 검사 후 단계 이동 |
| POST | /api/participant/progress/task-guide/complete | acknowledged: true | 과제 안내 완료·작업 화면 시작 |
| POST | /api/participant/progress/end | reason | 비동의 또는 명시적 중단 |
| POST | /api/participant/participants | consent: true, eligibility: {testEligible: true} | 개발 적격성·세션 검증 후 등록 또는 기존 참가자 반환 |
| GET | /api/participant/participants/:participantId | 없음 | 인증된 본인 정보만 조회, 타인은 403 |
| GET | /api/participant/conversations | 없음 | 작업 화면 접근을 검증하고 본인 대화·요청 상태 복원 |
| POST | /api/participant/conversations | request_id(UUID), message, retry(선택 boolean) | 사용자 메시지 저장 → OpenAI 호출 → 답변 저장 후 반환; 기존 진행 요청은 202 |
| POST | /api/participant/conversations/presentation | delivery_id, event, at, elapsed_ms, restored | 본인 답변의 최초 표시·출력 완료 계측, 중복 기록 방지 |
| GET | /api/participant/searches | 없음 | 본인 최신 검색·결과 복원 |
| POST | /api/participant/searches | request_id, query, submitted_at(선택) | 실제 서버 검색 호출·결과 기록; 미설정 503, 진행 중 중복 202 |
| POST | /api/participant/searches/sources | request_id, search_event_id, rank, source_url, clicked_at | 본인 검색 결과의 출처 클릭을 별도 기록 |
| POST | /api/participant/surveys | participantId, stage, answers | 본인 세션 검증 후 501 |
| GET | /api/participant/logs/context | 없음 | 본인의 서버 발급 task_id·수집 활성 상태, 조건 미포함 |
| POST | /api/participant/logs | events(공통 이벤트 배열, 최대 20개) | 세션별 기록과 event_id별 ACK; 재전송 중복 방지 |
| GET | /api/admin/participants | 없음 | 503, 관리자 인증 미구성 |
| GET | /api/admin/conversations | 없음 | 503, 관리자 인증 미구성 |
| GET | /api/admin/searches | 없음 | 503, 관리자 인증 미구성 |
| GET | /api/admin/surveys | 없음 | 503, 관리자 인증 미구성 |
| GET | /api/admin/logs | 없음 | 503, 관리자 인증 미구성 |

POST 요청은 `Content-Type: application/json`이 필요하고 JSON 본문은 최대 64KB입니다.
명시하지 않은 최상위 필드는 허용하지 않습니다.
participantId는 영문·숫자·밑줄·하이픈으로 된 1~128자 문자열입니다.
이 값만으로 인증하지 않으며 HttpOnly 쿠키에 연결된 본인 ID와 일치해야 합니다.
참가자 식별자는 등록 시 DB에서 생성하며 등록 전에는 참가자를 만들지 않습니다.
message는 최대 10,000자, query는 최대 600자·75단어, event는 최대 100자이며 공백만 있는 값은 거절합니다.
stage는 `pre` 또는 `post`, answers는 비어 있지 않은 객체, data는 객체입니다.
TODO: 설문과 이벤트가 확정되면 중첩 데이터까지 세부 검증을 추가합니다.
consent가 false이면 등록을 거절하며 참가자와 조건을 저장하지 않습니다.
현재 적격성은 test 환경의 개발용 확인만 허용하며 실제 연구 환경의 등록은 차단합니다.
POST는 APP_ORIGIN과 일치하는 Origin 및 `X-Experiment-Request: 1` 헤더가 필요합니다.
쿠키·조건·배정 시각은 JSON 응답에 포함하지 않습니다. 등록 성공 응답은 registered, participant_id, progress_status만 포함합니다.

## 응답 원칙

관리자 `/api/admin`은 별도 로그인·HttpOnly 세션으로 보호합니다. 집계/상세/연구자 코딩/CSV 경로는 [관리자 문서](ADMIN.md)에 정리했습니다. 기존 미구현 업무는 HTTP 501과 `NOT_IMPLEMENTED`를 반환합니다.
관리자 경로는 인증·권한 검사가 구현되기 전까지 HTTP 503으로 전체 차단합니다.
등록·세션·사전/사후 설문·단계 진행·대화·검색/출처 클릭·행동 이벤트·최종 의사결정을 DB에 저장합니다. 최종 제출과 종료 API는 [최종 진행 문서](FINAL_WORKFLOW.md)에 정리했습니다.
이벤트 필드·시계·종료 후 재전송·분석 변수는 [행동 로그 문서](BEHAVIOR_LOGGING.md)를 참고하세요. 종료 후 로그 재전송은 세션 소유권을 확인해 late_after_end로 표시하며 새 실험 행동이나 제출 API의 권한을 열지 않습니다.
검색 제공자·설정·결과 스냅샷과 실패 처리 계약은 [웹 검색 문서](WEB_SEARCH.md)를 참고하세요.
대화 API는 participantId를 받지 않고 세션으로 본인을 결정합니다. 실패·중단·재시도 계약은 [채팅 문서](CHAT.md)를 참고하세요.
대화 POST는 선택 submitted_at(ISO 날짜 문자열)을 측정용으로 받습니다. 조건·목표 시간은 허용하지 않습니다. 답변 본문은 서버 공개 기한까지 모든 대화 응답에서 숨깁니다. [응답 지연 문서](RESPONSE_TIMING.md)를 참고하세요.
대화 조회/응답에는 initial_required와 initial_question을 포함합니다. 최초 질문을 서버에서 검증하고 고정 답변을 제공한 뒤 자유 후속 대화로 전환합니다. 버전·오류·정답 정보는 반환하지 않습니다. [최초 자극물 문서](INITIAL_STIMULUS.md)를 참고하세요.
DB 설정 미완료·환경/스키마 불일치·저장 실패는 503을 반환하며 성공으로 대체하지 않습니다.
DB 스키마·연결 점검은 [DB 문서](database/README.md), 등록·세션은 [등록 문서](ENROLLMENT.md)에 설명합니다.
프론트엔드는 초기 진행 API와 연결되어 있으며 서버에서 단계별 필수 절차를 검사합니다.
요청 형식과 종료 상태·복원은 [초기 진행 문서](WORKFLOW.md)를 참고하세요.
health 성공은 프로세스의 응답 가능 여부만 뜻하며 DB·AI 연결 상태를 뜻하지 않습니다.

공통 오류 예시:

```json
{
  "error": {
    "code": "NOT_IMPLEMENTED",
    "message": "설문 제출 기능은 아직 구현되지 않았습니다. 데이터는 저장되거나 처리되지 않았습니다."
  }
}
```

입력 오류 400, 미지원 Content-Type 415, 본문 크기 초과 413, 없는 경로 404,
예상하지 못한 오류 500을 사용합니다. 입력 원문·스택·비밀키는 오류 응답에 포함하지 않습니다.

## 검사

```sh
node --test tests/workflow.test.js tests/enrollment.test.js tests/database.test.js tests/api.test.js tests/flow.test.js
npm run dev
```

PowerShell에서 npm 실행 정책 오류가 발생하면 `npm.cmd run dev`를 사용합니다.
서버 실행 후 `GET http://localhost:3000/api/health`로 상태를 확인합니다.
PORT 환경 변수를 설정했다면 해당 포트로 확인하세요.
