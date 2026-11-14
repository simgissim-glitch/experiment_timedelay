# 응답 지연 및 표시 계측

`005_response_timing.sql`을 기존 001~004 다음에 적용하고, 최초 답변 통제용 006·웹 검색용 007·행동 기록용 008도 이어서 적용합니다. 서버는 schema_version=10을 요구합니다. 실제 Supabase 프로젝트 연결과 SQL 적용은 별도로 필요합니다. 테스트는 격리된 PGlite를 사용합니다.

## 기준과 공개 경계

서버가 참가자 세션에 연결된 DB condition_code를 읽어 A=2000ms, B=9000ms, C=20000ms를 적용합니다. 첫 질문·후속 질문·명시적 재시도 모두 같은 참가자 조건을 사용합니다. 클라이언트 본문에 조건·목표 시간은 허용하지 않습니다.

브라우저 전송 시각 → 첫 글자 렌더링 확인까지를 관측 지연으로 기록합니다. 브라우저와 서버의 시계 차이를 신뢰하지 않기 때문에 공개 기한은 **서버 요청 수신 + 배정 시간**으로 계산합니다. 따라서 정상 경로에서 목표보다 일찍 전달하지 않으며, 업로드·DB·네트워크·브라우저 프레임 비용만큼 초과할 수 있습니다. 인터넷 환경에서 첫 글자를 정확히 2.000/9.000/20.000초에 표시한다고 보장하지 않습니다. 클라이언트가 제출한 날짜를 바꿔도 공개 기한은 바뀌지 않습니다.

LLM 생성 완료 시 응답 준비 시각을 저장하고, 공개 시각을 max(수신+목표, 응답 준비)로 결정합니다. 준비된 답변은 서버 DB에 보관하되 공개 시각 전에는 POST 응답뿐 아니라 GET 대화 복원 경로에서도 본문을 제외합니다. 모델 생성이 목표보다 늦으면 즉시 준비 후 전달하며 원래 준비·표시 시각과 초과분을 유지합니다. 목표에 맞춘 가짜 시각은 쓰지 않습니다.

브라우저에는 답변 공개 후 공통 코드로 첫 글자를 표시하고 이후 한 글자(유니코드 그래핌)당 최소 20ms 간격으로 출력합니다. 조건별 출력 코드·속도·안내·로딩 스타일은 없습니다. 브라우저 부하에 따른 타이머 지연은 실제 출력 완료 시각에 반영됩니다.

## 저장 시각

chat_timings는 API 시도당 한 행이며 participant_id, request_id, attempt_id로 연결됩니다. 관리자만 전체 조회할 수 있고 앱 역할은 세션별 함수만 실행합니다.

| 필드 | 기준 |
| --- | --- |
| client_submitted_at | 브라우저 전송 직전 Date 시각, 클라이언트 보고 |
| server_received_at | Express 진입 시 서버 시각 |
| response_ready_at | LLM 전체 응답 준비 후 서버 DB 시각 |
| release_at | 서버가 허용하는 공개 시각, 참가자 응답에 미포함 |
| first_character_at | 첫 글자 렌더링 확인 후 브라우저 시각 |
| output_completed_at | 마지막 글자 렌더링 확인 후 브라우저 시각 |
| first_elapsed_ms / completed_elapsed_ms | 전송 직전부터 performance.now()로 측정한 같은 페이지의 단조 시간 |
| first_event_received_at / completed_event_received_at | 계측 이벤트를 DB가 받은 서버 시각 |
| restored / completion_restored | 새 페이지에서 복원되어 측정했는지 여부 |

`experiment:chat-presentation` 브라우저 이벤트와 POST `/api/participant/conversations/presentation`을 사용합니다. 이벤트는 `delivery_id,event,at,elapsed_ms,restored`만 보내며 목표·조건을 받거나 반환하지 않습니다. 최초/완료 각각 최초 수신값을 보존하고 중복 보고로 덮어쓰지 않습니다. 실패한 보고는 sessionStorage에 비밀정보 없는 계측값만 임시 보관해 다음 조회·온라인 복귀 때 재전송합니다.
현재 행동 로그 수집기는 이 표시 보고를 IndexedDB outbox에도 보관하고, 별도의 공통 관측 이벤트에 page_id·performance.now·timeOrigin을 기록합니다. ACK·재전송과 분석 변수는 [행동 로그 문서](BEHAVIOR_LOGGING.md)를 참고하세요.

첫 글자 DOM 삽입 뒤 다음 requestAnimationFrame와 다음 태스크에서 표시를 확인합니다. 이는 브라우저가 렌더링 기회를 지난 것을 확인하는 **표시 시각의 근사 상한**입니다. OS 합성·모니터 스캔아웃의 물리적 첫 픽셀 시각은 웹 JavaScript만으로 직접 확인할 수 없습니다. 관련 근거: [HTML 렌더링 처리 표준](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering).

숨겨진 탭에서는 표시 확인과 출력을 보류합니다. 재접속으로 페이지가 바뀌면 원래 performance.now 기준이 사라지므로 elapsed_ms=null, restored=true로 기록하며 정상 관측 표본과 구분합니다. 출력 도중 새로고침하면 기존 최초 표시를 보존하고 복원 출력 완료를 따로 표시합니다. 클라이언트 계측값은 참가자가 개발자 도구로 변조할 수 있는 자기 보고이며 보안상 신뢰하는 기한 결정 입력으로 사용하지 않습니다.

## 중복과 연결 끊김

서버 작업은 HTTP 연결이 끊겨도 완료되어 DB에 저장됩니다. 새로고침은 기존 요청 상태를 조회하며 새 생성 요청을 만들지 않습니다. 동일 request_id는 DB에서 중복 생성하지 않습니다. 공개 기한도 기존 값으로 유지합니다. 참여 중단 후에는 답변 저장·조회 권한을 거절합니다. 화면의 요청 중단 버튼은 숨기고 명시적인 참여 중단 기능을 유지합니다.

서버 자체가 생성 중 비정상 종료되면 완료되지 않은 시도는 기존 임대 만료 후 중단으로 취급합니다. 이때 자동 재생성하지 않으며 명시적 재시도만 허용합니다. 외부 API까지 포함한 과금의 exactly-once는 보장하지 않습니다.

## 검증

`node --test tests/timing-browser.test.js`는 실제 시간으로 동작하는 Chrome CDP를 사용해 A/B/C 각각 최초·후속 답변, 느린 생성(2.4초), 목표 전 GET 본문 차단, 중복 POST 및 새로고침 재생성 방지를 검증합니다. 실제 Supabase나 유료 OpenAI 호출은 하지 않고 일정한 테스트 답변을 사용합니다. 결과는 `tests/timing-results.json`에 기록합니다. 가상 시간 가속을 쓰지 않으며 Chrome 설치가 필요합니다.
