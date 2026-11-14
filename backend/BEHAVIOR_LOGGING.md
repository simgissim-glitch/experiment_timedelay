# 행동 로그와 연구 분석

## 적용과 검증 범위

기존 001~007 다음에 `008_research_events.sql`을 적용합니다. 서버는 schema_version=10을 요구합니다. 원래 participants/chat_timings/search_events/source_events/final_decisions/behavior_events 기록을 삭제하지 않습니다. 연구 장부는 별도의 research_events이며 기존 기록의 시각·원문을 legacy로 구분해 복사합니다. 과거 브라우저 표시·복귀·성능 시간을 추측해서 채우지 않습니다.

작업 화면 진입 시 서버가 research_tasks.task_id를 발급합니다. 참가자·조건은 DB 세션에서 결정하며 클라이언트가 보내거나 변경할 수 없습니다. 프론트엔드에는 task_id와 수집 활성 상태만 돌려줍니다. 조건은 연구자용 DB/분석 결과에서만 조회합니다. 모든 조건의 수집 코드와 안내는 같습니다.

최종 제출 화면은 서버와 연결되어 있습니다. final_decisions에 **실제 INSERT가 성공할 때만** 최종 제출 시각·final_submitted 이벤트·과제 종료 시각을 기록합니다. 브라우저가 보낸 가짜 제출 이벤트는 거절합니다. 제출 데이터가 없으면 제출 시각과 전체 과제 시간은 null입니다. 이후 사후 설문·디브리핑 시간은 전체 과제 시간에 포함하지 않습니다.

## 공통 이벤트 구조

| 필드 | 의미 |
| --- | --- |
| participant_id | HttpOnly 세션에 연결된 익명 참가자, 서버에서 결정 |
| condition_code | 해당 참가자의 A/B/C, 서버에서 채움 |
| event_id | 단일 이벤트 UUID; 같은 ID 재전송은 한 번만 저장 |
| task_id | 서버가 발급한 과제 UUID; 참가자와 복합 FK 연결 |
| event_type | 허용 목록의 이벤트 종류 |
| timestamp | 이벤트의 기준 시각, 시간 종류는 timestamp_source로 확인 |
| timestamp_source | server / browser_reported / legacy_mixed |
| server_timestamp | 실제 이벤트 장부에 도착한 DB 서버 시각 |
| browser_timestamp | 브라우저가 보고한 날짜 시각, 없으면 null |
| page_id | 페이지 인스턴스 UUID, 새로고침하면 바뀜 |
| performance_ms | 해당 페이지 performance.now() 값 |
| performance_time_origin | 해당 페이지의 단조 시계 기준점 |
| origin | server(실제 DB 기록에서 수집), browser(관측 자기 보고), legacy(이관) |
| related_type / related_id | 대화 요청/시도, 검색, 클릭, 활동 구간 연결 |
| payload | 허용된 최소 정보: 검색어·URL·상태·복원/가시성 등; 대화 본문·키·쿠키 제외 |
| late_after_end | 참여 종료 후 도착한 재전송/자기 보고인지 여부 |

timestamp는 모든 이벤트에 존재하지만 서버 시각과 브라우저 시각을 한 시계처럼 빼지 않습니다. origin=server라도 ai_first_character/ai_output_completed/source_access의 기준 시각은 기존 DB에 저장된 브라우저 보고 시각이므로 timestamp_source=browser_reported입니다. server_timestamp는 이와 별도로 보존합니다. legacy의 server_timestamp는 이관 수신 시각이며 과거 접수 시각으로 가장하지 않습니다.

재전송은 원래 event_id·브라우저 시각·성능 값을 유지합니다. 같은 ID의 다른 본문은 거절합니다. 다른 참가자의 task_id로 저장하거나 서버 전용 이벤트·조건·참가자 ID를 보내는 요청도 거절합니다. 종료 후 지연 도착한 자기 보고는 보관하되 late_after_end로 표시합니다. 두 기기의 날짜 시계 차이 때문에 유효한 과거 로그를 자동 삭제하지 않습니다. 웹앱은 중단 요청 전 새 수집을 멈추며 종료 후 수신을 종료 전 행동으로 자동 판정하지 않습니다.

## 수집 이벤트

실제 저장 트랜잭션에서 task_started, question_received, ai_response_ready, ai_first_character, ai_output_completed, search_executed, search_api_requested, search_completed/search_failed, source_access, final_submitted를 자동 기록합니다. 동일 원기록의 UPDATE/재시도는 논리 키로 중복을 막습니다.

브라우저는 question_sent, ai_first_character_observed, ai_output_completed_observed, search_submitted, search_results_presented, search_activity_start/end, source_click/left/return, tab_hidden/visible, window_blur/focus, offline/online, transport_failed/restored, page_start/exit, heartbeat를 기록합니다.

search_executed는 검색 시도 접수이며 검색어·횟수·실행 시각은 search_events에서 집계합니다. 실제 외부 API 호출 횟수는 provider_requested_at으로 따로 셉니다. API 미설정/실패를 정상 결과 확인으로 세지 않습니다. source_access와 클릭 URL·횟수는 source_events에서 집계합니다. 이벤트 장부의 같은 의미를 가진 브라우저/서버 관측을 모두 더해 횟수를 부풀리지 않습니다.

검색 결과 표시 이벤트는 결과 영역이 뷰포트에 들어오고 렌더링 기회를 지난 뒤 기록합니다. 0건일 때는 빈 결과 안내의 가시화를 기록합니다. 결과를 읽거나 확인을 마쳤다는 판정이 아닙니다. AI 첫 글자도 기존 렌더링 확인 시각이며 물리적 모니터 첫 픽셀의 직접 측정은 아닙니다.

외부 출처는 검색 결과 링크의 클릭과 이후 앱의 blur/hidden → focus/visible 복귀로 연결합니다. 클릭 URL과 페이지 이동 성공은 다릅니다. 배경 탭으로만 열어 앱을 떠나지 않았다면 복귀 시간을 만들지 않습니다. 복수 출처의 연속 클릭으로 연결이 모호하면 ambiguous, 다른 페이지에서 복원되면 restored로 표시합니다. 크로스 도메인 페이지의 본문·스크롤·열람·이해를 추적하지 않습니다. 컨텍스트 메뉴나 복사한 URL로 밖에서 여는 행동도 보장되지 않습니다.

offline/online은 브라우저 신호이며 실제 인터넷 연결의 확정 판정이 아닙니다. 실제 기록 요청 실패/성공은 transport_failed/restored로 별도로 기록합니다. 15초 heartbeat는 관측 누락 탐지용입니다. 숨김 탭의 타이머 제한·절전·강제 종료 때문에 심박이 없을 수도 있으므로 이를 곧바로 연결 단절로 판정하지 않습니다. 관련 근거: [MDN onLine](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine), [visibilitychange](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event).

## 분석 시간 변수

`backend/analysis/metrics.js`의 analyzeTask는 원기록과 이벤트를 받아 아래 값을 계산합니다. 같은 page_id이면 performance.now 차이를 우선합니다. 페이지가 다르면 브라우저 날짜 시각의 차이를 fallback으로 명시하고, 음수·누락은 null로 남깁니다. 재전송 수신 시각을 행동 발생 시각으로 사용하지 않습니다. 단조 시계와 기준점의 근거: [W3C High Resolution Time](https://www.w3.org/TR/hr-time-2/).

| 변수 | 계산/해석 |
| --- | --- |
| chats[].ai_wait_ms | 해당 시도 질문 전송 → 첫 글자 관측; 기존 first_elapsed_ms도 별도 성능 시계 근거로 사용 가능 |
| chats[].output_duration_ms | 첫 글자 → 마지막 글자 출력 관측 |
| chats[].first_search_after_display_ms | 해당 AI 첫 글자 이후의 첫 실제 검색 시도까지; 대기 중 이미 검색했다면 search_before_display=true, 이후 검색이 없으면 null |
| searches[].results_render_latency_ms | 원래 검색 전송 → 결과 영역 최초 가시화; 재전송의 새 전송 시각으로 대체하지 않음 |
| searches[].provider_latency_ms | 서버 API 요청 시작 → 결과 저장 완료; 브라우저 표시 시간과 별도 |
| observed_search_panel_active_ms | 앱이 보이고 포커스가 있는 검색 영역의 관측 시작/종료 구간 합집합 |
| observed_search_activity_excluding_result_wait_ms | 검색 영역 활동 중 검색 결과 대기와 겹친 구간을 제외 |
| sources[].click_to_return_ms | 출처 클릭 → 앱 복귀 관측 |
| sources[].away_ms | 실제 앱 blur/hidden → 복귀; 읽기 시간이라고 명명하지 않음 |
| observed_source_away_ms | 모호/복원 연결을 제외한 출처 이탈 구간 합집합 |
| observed_information_activity_ms | 검색 영역 활동에서 결과 대기를 뺀 구간과 출처 이탈 구간의 합집합; 검증 의도/성공이 아닌 행동 대리지표 |
| information_activity_during_ai_wait_ms | 위 정보 활동과 AI 대기의 교집합 |
| ai_wait_without_observed_information_activity_ms | AI 대기 합집합에서 관측된 정보 활동을 뺀 값; 관측되지 않은 다른 행동이 없었다는 의미는 아님 |
| total_task_ms | 서버의 과제 진입 started_at → 실제 최종 제출 submitted_at |

중첩된 구간은 합집합으로 처리해 이중 합산하지 않습니다. 활동 구간의 종료·출처 복귀가 없으면 임의 종료 시각을 채우지 않고 미완결로 표시합니다. 활동 총합은 **관측된 구간의 하한**입니다. 새로고침·복수 탭·날짜 시계 변경·중단 후 도착 등 품질 플래그를 함께 검토해야 합니다.

search_attempt_count/search_api_count, source_click_count, unique_source_url_count를 분리합니다. APP_ORIGIN 호스트와 다른 URL은 external_source_click_count로 집계하고 unique_external_hostname_count를 제공합니다. 고유 호스트 수는 eTLD+1/발행인 수가 아니며 도메인 독립성이나 독립적으로 읽었다는 증거도 아닙니다. APP_ORIGIN이 없으면 외부 분류는 null입니다. reading_confirmed=false는 읽음이 확인되지 않았다는 뜻입니다.

## 보관·실패·재전송

public/js/telemetry.js는 이벤트와 기존 AI 표시/출처 클릭 기록을 IndexedDB outbox에 먼저 보관하고 sessionStorage에 보조 사본을 둡니다. 서버 ACK가 확인된 항목만 브라우저 대기열에서 제거하며 DB 원자료는 삭제하지 않습니다. 새로고침·온라인 복귀·주기적 재시도·수동 재전송을 지원합니다. 같은 ID로 재전송하므로 중복 행이 생기지 않습니다. 다른 세션 task_id의 대기 기록을 현재 참가자에게 재귀속하지 않습니다.

기록 실패 안내와 '기록 전송 다시 시도' 버튼은 조건과 무관한 공통 UI입니다. 종료/숨김에서는 keepalive fetch로 시도하지만 전송 시도 자체를 저장 성공으로 보지 않습니다. 브라우저 강제 종료·디스크 오류·사이트 데이터 삭제·컨텍스트 발급 전 종료까지 완벽히 복구한다고 보장하지 않습니다. 로컬 저장이 실패하면 안내하고 메모리/보조 사본으로 재시도합니다. 서버가 영구 거절한 항목도 성공한 것처럼 지우지 않습니다.

미전송 연구 기록은 해당 브라우저에 남을 수 있으므로 공유 기기 정리·보관 기한·참여 철회 시 삭제 정책은 기존 동의 정책 TODO와 함께 연구자가 확정해야 합니다. 이번 단계에서는 미확정 정책에 따라 데이터를 자동 삭제하지 않습니다. 키·쿠키·조건·participant_id는 브라우저 대기열에 넣지 않습니다.

## 관리자 분석

앱 역할은 세션별 ingest/context 함수만 실행하며 전체 장부·분석 뷰를 읽을 수 없습니다. ai_latency_admin은 연구 자료를 읽을 수 있습니다. 관리자 웹 인증이 없는 전체 조회 API는 계속 차단합니다.

`.env`의 ANALYSIS_DATABASE_URL에는 연구자 전용 읽기 계정을 별도로 지정합니다. 웹 서버는 이 연결을 사용하지 않습니다. 로컬에서 다음을 실행하면 읽기 전용 반복 가능 스냅샷으로 해당 과제의 JSON 분석 결과를 출력합니다.

```sh
npm.cmd run logs:analyze -- <서버가_발급한_task_id>
```

설정이나 읽기 권한이 없으면 오류로 종료하며 가짜 분석 결과를 만들지 않습니다. research_task_summary 뷰는 서버 과제 시간과 실제 검색/출처 횟수의 SQL 요약을 제공합니다. 브라우저 구간 분석은 metrics.js에서 수행합니다.

## 검사

`node --test tests/telemetry.test.js`는 ID·조건·소유권·중복/변조·검색/복귀·실제 최종 INSERT·읽기 권한·기존 데이터 보존·분석 공식과 시계 역전을 검사합니다. `node --test tests/browser.test.js`는 실제 Chrome에서 첫 기록 요청을 실패시킨 뒤 새로고침해 동일 이벤트가 한 번 저장되는지, 대화/검색 관측과 실제 새 탭의 출처 복귀가 기록되는지 검사합니다. offline/online 및 window blur/focus 처리기는 하네스 이벤트로도 검증합니다. 검색/AI는 테스트 대역이며 DB는 격리 PGlite입니다. 실제 Supabase 연결 성공이나 실제 최종 제출 UI 연결을 뜻하지 않습니다.
