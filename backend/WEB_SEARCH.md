# 웹 검색

## 현재 연결 상태와 설정

검색 UI·서버 인터페이스·DB 기록과 Brave Search 어댑터를 구현했습니다. 서비스가 확정되지 않은 상태의 기본값은 미설정입니다. 가짜 검색 결과, ChatGPT로 생성한 검색 결과, HTML 스크래핑 대체 결과를 제공하지 않습니다. 실제 외부 검색의 성공은 키가 설정된 뒤에만 확인할 수 있습니다.

`.env`에 아래 값을 추가합니다. 기존 파일과 비밀키는 덮어쓰지 마세요.

```dotenv
SEARCH_PROVIDER=brave
SEARCH_API_KEY=
SEARCH_COUNTRY=KR
SEARCH_LANGUAGE=ko
SEARCH_RESULT_COUNT=10
```

Brave Search 사용이 확정되면 발급받은 Web Search API 키를 입력합니다. 빈 제공자·키·지원하지 않는 제공자는 SEARCH_NOT_CONFIGURED(503)입니다. 국가 설정은 KR/US/GB/JP, 언어는 ko/en/ja, 결과 수는 1~20을 지원합니다. 설정은 서버의 프로젝트 `.env`에서만 읽습니다. 실제 `.env`는 이번 구현에서 변경하지 않았습니다.

기존 001~006 뒤에 `007_web_search.sql`과 `008_research_events.sql`을 적용하고 `npm.cmd run db:check`, `npm.cmd run search:check`로 각각 DB와 실제 검색 연결을 확인합니다. 검색 점검은 기본 검색어 PostgreSQL documentation으로 실제 API를 한 번 호출하며 사용량/요금이 발생할 수 있습니다. 다른 검색어는 `npm.cmd run search:check -- "검색어"`로 지정합니다. 이 명령은 DB 쓰기 검사가 아닙니다. 서버는 schema_version=10을 요구합니다. 앱 실행은 `npm.cmd run dev`입니다.

다른 제공자를 채택하려면 `backend/search/provider.js`와 동일한 `{id,policy,search(query)}` 인터페이스의 서버 어댑터를 만들고 config 로더와 server.js의 생성 지점을 연결합니다. search(query)는 `{rank,title,description,url}[]`를 반환합니다. 프론트엔드 API 계약과 DB 기록 경로는 그대로 유지합니다. 실제 server.js에는 테스트 응답 선택 옵션이 없습니다.

## 실제 API와 표시 방식

서버가 고정 HTTPS 엔드포인트 `https://api.search.brave.com/res/v1/web/search`에 요청하고 서버 헤더 X-Subscription-Token으로 인증합니다. 브라우저 키·서버 세션·참가자 ID·조건·브라우저 IP·개인화 쿠키를 검색 제공자에게 전달하지 않습니다. 검색어 자체는 제공자에게 전송됩니다. 외부 제공자 전송 및 보관 정책은 실제 연구 동의 정책 확정 시 연구자가 반영해야 합니다.

전 조건이 동일한 country/search_lang/count, safesearch=moderate, spellcheck=false, result_filter=web, text_decorations=false를 사용합니다. 조건별 사이트 추가·제외, AI 기반 재정렬·요약, 지연 조작은 하지 않습니다. 제공자 순위·제목·설명·URL을 보존하며 강조 HTML만 제거하고 텍스트로 표시합니다. 실행 가능한 URL과 인증정보 포함 URL을 제외하므로 순위에 빈 번호가 생길 수 있습니다. 설명이 없으면 설명이 제공되지 않았다는 안내만 표시합니다. 검색어는 제공자 제한에 맞춰 600자·75단어 이하입니다.

다른 시각의 검색 결과까지 항상 동일하다고 보장하지 않습니다. 제공자 인덱스가 바뀔 수 있으며 이번 요구사항은 동일한 처리 방식으로 구현했습니다. 실제 제공된 결과 배열과 제공자 설정을 각 검색 이벤트에 보존해 순위와 내용을 사후 확인할 수 있습니다. 제목·설명은 일반 텍스트로 렌더링하고 URL은 HTTP(S)만 허용합니다. 공식 계약: [Brave Web Search API](https://api-dashboard.search.brave.com/api-reference/web/search/get).

## API와 기록

세션·등록·진행 단계를 검증하며 참가자 ID는 본문으로 받지 않습니다. 현재 작업 화면에서만 허용하고 다른 참가자의 검색을 읽거나 클릭한 것으로 기록하지 못합니다. POST는 기존 Origin 및 X-Experiment-Request 검사를 적용합니다. 관리자 인증 미구성 경로는 기존처럼 차단됩니다.

| 요청 | 입력/응답 |
| --- | --- |
| GET /api/participant/searches | 본인의 최신 검색 상태·결과 또는 null; 제공자·키·조건 미포함 |
| POST /api/participant/searches | request_id(UUID), query, submitted_at(선택 ISO 날짜) |
| POST /api/participant/searches/sources | request_id(UUID), search_event_id(UUID), rank, source_url, clicked_at(ISO 날짜) |

검색 응답은 search_event_id, request_id, query, executed_at, status, error_code, results입니다. 정상 200, 진행 중 동일 요청은 202, 명확한 실패는 안전한 오류와 4xx/5xx를 반환합니다. 상태 조회에서 failed 결과는 오류 코드와 빈 배열이며 성공 검색을 의미하지 않습니다. 실제 API가 정상적으로 0건을 반환한 경우만 completed 및 빈 배열로 표시합니다.

search_events에는 검색어·브라우저 제출 시각(client_submitted_at)·서버 검색 접수 시각(executed_at)·API 호출 시작 시각(provider_requested_at)·완료 시각·실제 결과 스냅샷·공통 제공자 설정·실패 코드를 저장합니다. 미설정 검색 시도도 failed로 기록하고 provider_requested_at은 비워 실제 API 실행과 구분합니다. results가 없는 레거시 기록을 정상 빈 검색으로 표시하지 않습니다.

source_events에는 별도의 클릭 request_id·연결된 검색 ID·출처 URL·순위·클릭 시각(accessed_at)·서버 기록 시각(recorded_at)을 저장합니다. 검색어와 검색 시각은 search_event_id로 검색 이벤트에 연결됩니다. 서버에 저장된 해당 검색 결과의 URL/순위와 정확히 일치해야 기록합니다. 외부 페이지 본문을 서버가 가져오지는 않습니다. 행동 로그 단계에서 관측된 앱 복귀를 returned_at 및 source_return 이벤트에 연결합니다. [행동 로그 문서](BEHAVIOR_LOGGING.md)를 참고하세요.

검색 결과 링크는 target=_blank, rel=noopener noreferrer로 새 탭을 엽니다. 일반·Ctrl/Meta·가운데 버튼 클릭을 수집하고 keepalive POST로 별도 전송합니다. 페이지 방문 성공·페이지 읽음으로 간주하지 않습니다. 컨텍스트 메뉴에서 링크를 열거나 URL을 복사하는 동작은 일반 클릭 이벤트로 보장되지 않습니다. 클릭 기록 전송 실패는 화면에 표시하고 현재 페이지에서 온라인 복귀 시 같은 이벤트 ID로 재시도합니다.

## 중복·실패

동일 참가자/request_id는 한 번만 검색합니다. 동일 키의 다른 검색어는 409, 진행 중 중복은 202, 완료 중복은 저장 결과를 반환합니다. 연결이 끊기거나 새로고침되어도 기존 서버 요청을 새로 생성하지 않습니다. 명확한 실패 후 참가자가 다시 검색하면 새 ID로 새 검색을 기록합니다. 비용 제한은 참가자별 분당 10회·총 200회와 전체 분당 60회이며 모든 조건에 같습니다. API 자동 재시도는 없습니다.

10초 시간 제한, 429, 인증/통신 실패, 잘못된 JSON/결과 형식을 구분하거나 안전한 오류로 처리하며 원본 오류·키는 로그/브라우저에 내보내지 않습니다. 45초 임대가 만료된 서버 미완료 요청은 조회 시 실패로 표시하고 자동 재호출하지 않습니다. DB 저장 실패를 검색 완료로 표시하지 않습니다. 검색 또는 클릭 실패를 AI 답변으로 대체하지 않습니다.

## 검사

`node --test tests/search.test.js`는 격리 PGlite와 테스트 HTTP 응답으로 공통 파라미터·순위·저장·권한·중복·클릭·오류 처리를 검사합니다. 테스트 응답의 example.org 문서는 실제 검색 결과라고 주장하지 않으며 테스트 코드에서만 사용합니다.

`node --test tests/browser.test.js`는 Chrome으로 AI 대기 중 검색, 검색 결과 표시, 새 탭 페이지 열기, 클릭 DB 기록, 검색·AI 복원과 기존 화면 진행을 검사합니다. 이 테스트도 로컬 전용 출처와 대역 검색 제공자를 사용합니다. 실제 검색 성공 검증은 설정 후 search:check로 별도 수행해야 합니다.
