# PostgreSQL 설계 및 연결 점검

참가자 등록·배정·세션, 사전/사후 설문, 단계 시각·current_step, 대화, 최종 제출과 종료까지 연결했습니다.
009는 최종 답변 잠금·연구자 판정 열·사후 설문 제출·디브리핑 스냅샷·종료 시각과 단계 접근 검사를 추가합니다.
채팅·최초 답변 통제·웹 검색·행동 분석을 사용하려면 001~010 SQL을 순서대로 적용하세요. 서버는 schema_version=10을 요구합니다.
008은 research_tasks/research_events, 기존 기록의 legacy 이관, 실제 업무 트리거, 세션별 로그 수집, 연구자용 research_task_summary 뷰를 추가합니다. 기존 테이블의 원기록은 유지합니다. [행동 로그 문서](../BEHAVIOR_LOGGING.md)를 참고하세요.
007은 검색 결과 스냅샷·실패 상태·호출 설정, 출처 클릭 순위 및 세션별 검색/클릭 함수를 추가합니다. [웹 검색 문서](../WEB_SEARCH.md)를 참고하세요.
006은 자극물 원문·버전, 단일 연구 버전 고정, 참가자별 최초 요청·노출·정정 판정 필드 및 고정 답변 검증을 추가합니다. [최초 자극물 문서](../INITIAL_STIMULUS.md)를 참고하세요.
005는 chat_timings와 답변 본문 공개 기한·브라우저 표시 이벤트 함수를 추가합니다. [응답 지연 문서](../RESPONSE_TIMING.md)를 참고하세요.
004는 chat_requests·chat_attempts, 중복 방지·호출 제한·본인 대화 함수 및 최소 권한을 추가합니다. [채팅 문서](../CHAT.md)를 참고하세요.
실제 Supabase DB에 마이그레이션을 적용하거나 연구 데이터를 생성하지 않았습니다.
SQL과 제약·권한은 네트워크 없는 메모리 PostgreSQL(PGlite)에서만 검증합니다.

## 관계형 구조

모든 연구 테이블은 `ai_latency_private` 스키마에 있습니다.
`participant_id`는 직접 식별정보와 연결하지 않는 익명 UUID 기본키이며 나머지 6개 테이블의 외래키입니다.
UUID는 등록 시 DB가 생성하며 프론트엔드는 참가자 ID·조건을 만들지 않습니다.

| 테이블 | 주요 데이터 | 중복 방지 |
| --- | --- | --- |
| participants | 익명 ID, 동의·동의 시각, 조건 코드, 진행 상태, 시작·종료 시각 | 등록 request_id UNIQUE |
| survey_responses | pre/post, 문항 버전, JSON 응답, 제출 시각 | 참가자+phase UNIQUE, 참가자+request_id UNIQUE |
| chat_messages | user/assistant, 내용, 대화 순서, 생성 시각 | 참가자+순서 UNIQUE, 참가자+request_id UNIQUE |
| search_events | 검색어, 실행 시각, 서버 기록 시각 | 참가자+request_id UNIQUE |
| source_events | 외부 HTTP(S) URL, 접근·복귀 시각, 검색 이벤트 연결 | 참가자+request_id UNIQUE |
| behavior_events | 이벤트 유형, JSON payload, 발생·서버 기록 시각 | 참가자+request_id UNIQUE |
| final_decisions | 제품 코드, 판단 근거, 출처 메모, 제출 시각 | 참가자당 1건, 참가자+request_id UNIQUE |

모든 연구 레코드에는 UUID 기본키가 있습니다. 시간은 `timestamptz`로 저장하며 표시할 때 한국 시간으로 변환합니다.
외래키는 `ON DELETE RESTRICT`로 연결하여 참가자 삭제 시 연구 기록이 연쇄 삭제되지 않습니다.
`source_events`의 복합 외래키는 다른 참가자의 검색 이벤트를 참조하지 못하게 합니다.
외부 출처를 열고 돌아오지 않은 경우 returned_at은 NULL이며 복귀 시각은 접근 시각보다 빠를 수 없습니다.
source URL은 이번 단계에 서버가 요청하거나 크롤링하지 않습니다.

진행 상태는 registered → pre_survey → task_guide → workspace → final_decision → post_survey → completed를 기본으로 하며,
withdrawn과 declined를 별도 종료 상태로 둡니다. 종료 상태에는 ended_at이 필요합니다.
비동의는 조건 배정 없이 declined로만 기록할 수 있으며, DB 트리거가 후속 연구 레코드를 거절합니다.
이번 단계에서는 실제 비동의 기록도 저장하지 않습니다.
001의 임시 코드 c1/c2/c3는 002에서 A/B/C로 교체됩니다. 배정·세션은 [참가자 등록 문서](../ENROLLMENT.md)를 참고하세요.
동의하지 않은 경우 등록 API나 프론트엔드에서 조건을 생성하지 않습니다.

인덱스는 고유 제약이 생성하는 인덱스 외에 참가자별 검색·출처·행동 시각,
행동 유형+시각, 진행 상태+시작 시각, 출처의 검색 외래키에 둡니다.
survey의 참가자+phase, chat의 참가자+순서, final의 참가자 고유 인덱스가 각각 조회·외래키 검사도 지원합니다.

`deployment_context`는 연구 데이터가 아닌 환경·스키마 버전 확인용 운영 테이블입니다.
002는 토큰 해시·유효기간·참가자 연결을 보관하는 participant_sessions 테이블과 배정 시각·적격성 기록을 추가합니다.
003은 participant_steps, current_step, 동의·종료 기록과 사전 설문 초안·제출 버전을 추가합니다. [초기 진행 문서](../WORKFLOW.md)를 참고하세요.

## 테스트와 실제 연구 데이터 분리

1. 연구용과 테스트용 **서로 다른 Supabase 프로젝트**를 생성합니다. 같은 프로젝트의 is_test 플래그만으로 구분하지 않습니다.
2. 두 프로젝트에 동일한 SQL을 적용하되 환경 표식은 각각 research/test로 고정합니다.
3. `.env`의 `DB_ENV=test`에서는 TEST_DATABASE_URL만 사용하고 DATABASE_URL로 대체하지 않습니다.
4. `DB_ENV=research`에서만 DATABASE_URL을 사용합니다. 연결 점검은 DB 내부 환경 표식과 DB_ENV도 비교합니다.
5. 자동 테스트는 매번 생성·폐기하는 PGlite 메모리 DB만 사용하며 `.env`의 실제 DB를 사용하지 않습니다.

기존 `.env`는 수정하지 않았습니다. `.env.example`을 참고해 필요한 항목만 직접 추가하세요.

```dotenv
DB_ENV=test
TEST_DATABASE_URL=
DATABASE_URL=
DB_SSL_MODE=verify-full
DB_SSL_CA_FILE=
```

로컬 연결 문자열은 `.env`에서만 읽으며 CLI 인수·프론트엔드로 받지 않습니다. 배포는 명시적 서버 플랫폼 변수 모드를 사용합니다. [배포 준비 안내](../../DEPLOYMENT.md)의 환경 분리 규칙을 참고하세요.
실제 비밀번호가 들어간 URL은 코드·문서·Git·명령줄에 넣지 마세요. 사용자명·비밀번호의 특수 문자는 URL 인코딩해야 합니다.

Supabase Connect 화면에서 direct connection 또는 session pooler(5432) 연결 문자열을 확인합니다.
일반 Express 서버의 연결 방식 선택은 [Supabase 연결 문서](https://supabase.com/docs/guides/database/connecting-to-postgres)를 기준으로 합니다.
트랜잭션 풀러(6543)는 이 단계의 마이그레이션 실행 경로로 사용하지 않습니다.
마이그레이션은 SQL Editor 또는 direct/session 연결의 전용 관리자 계정으로 적용합니다.

원격 연결은 인증서 검증을 끄지 않습니다. 필요한 CA 인증서를 내려받고 DB_SSL_CA_FILE에 프로젝트 기준 경로를 지정하세요.
URL의 SSL 옵션과 pg의 ssl 객체가 충돌하지 않도록 URL 쿼리는 sslmode=verify-full만 허용하고 드라이버 옵션으로 정규화합니다.
[Supabase SSL 문서](https://supabase.com/docs/guides/platform/ssl-enforcement),
[node-postgres SSL 문서](https://node-postgres.com/features/ssl)를 참고했습니다.
DB_SSL_MODE=disable은 DB_ENV=test인 localhost/127.0.0.1/::1 연결에서만 허용합니다.

## 마이그레이션 적용 (현재 자동 실행하지 않음)

`migrations/001_initial_schema.sql`은 트랜잭션 단위로 적용합니다. 테이블을 삭제·덮어쓰지 않으며 재적용 시 실패합니다.
스키마·역할 생성 권한이 있는 관리자 계정으로 Supabase SQL Editor에서 다음 줄과 SQL 파일 전체를 **같은 실행**에 넣습니다.

```sql
-- 테스트 프로젝트에서만:
SET ai_latency.environment = 'test';
-- 이 아래에 migrations/001_initial_schema.sql 전체 내용을 붙여 실행합니다.
```

연구용 프로젝트에서는 위 값을 research로 바꿉니다. 프로젝트명과 접속 대상을 먼저 확인하세요.
참가자 등록을 테스트하려면 이어서 002_enrollment_sessions.sql을 적용합니다.
초기 진행과 사전 설문 저장에는 이어서 003_early_workflow.sql도 적용해야 합니다.
002는 기존 참가자가 있는 DB에서는 자동 변환을 중단합니다. 실제 연구 등록은 적격성 기준 확정 전까지 차단됩니다.
데이터 시드·자동 롤백 삭제·reset 명령은 제공하지 않습니다. 변경이 필요하면 새 번호의 마이그레이션을 추가합니다.

## 권한 구조

- 스키마를 Supabase Data API의 Exposed schemas에 추가하지 않습니다.
- PUBLIC, anon, authenticated, service_role에는 스키마·테이블 접근을 부여하지 않습니다.
- 연구 테이블과 환경 표식에 RLS ENABLE/FORCE를 적용합니다.
- ai_latency_admin은 NOLOGIN 그룹 역할로 전체 연구 자료를 조회합니다. 010의 admin_code_final 함수로 연구자 코딩만 수정하며 테이블 직접 UPDATE/DELETE 권한은 없습니다.
- ai_latency_app은 NOLOGIN 그룹 역할로 환경 표식과 002·003의 제한된 세션별 함수를 사용합니다. 연구 테이블 직접 조회·쓰기는 금지합니다.
- DB 플랫폼 관리자·슈퍼유저·BYPASSRLS 계정은 예외적인 관리 권한이므로 앱 런타임이나 참가자에게 제공하지 않습니다.

전용 서버 로그인 역할은 별도로 만들고 ai_latency_app의 멤버로만 지정합니다.
인증된 연구 관리자용 로그인에만 ai_latency_admin 멤버십을 부여합니다. 이번 SQL은 로그인·비밀번호·멤버십을 자동 생성하지 않습니다.
앱 계정은 테이블 소유자·관리자 역할·BYPASSRLS 권한을 겸하지 않아야 합니다.
기존 `/api/admin`은 관리자 인증 미구성으로 계속 503을 반환합니다. DB 역할 준비가 HTTP 관리자 인증을 대신하지 않습니다.
[Supabase RLS 문서](https://supabase.com/docs/guides/database/postgres/row-level-security)를 참고했습니다.

등록·세션은 002의 제한된 함수로 처리합니다. 다음 저장 단계에서 나머지 연구 데이터의 세션별 최소 권한을 추가합니다.
클라이언트가 보내는 participant_id만 신뢰하거나 사용자 설정값만으로 전체 조회 권한을 열면 안 됩니다.
트리거는 SECURITY INVOKER로 동작하므로 향후 앱 쓰기 권한과 함께 본인 participants 행을 읽을 정책도 마련해야 합니다.

## 입력 검증·중복 요청 처리

DB CHECK·FK·UNIQUE와 함께 `validation.js`에 7개 레코드 유형별 검증기를 준비했습니다.
일반 레코드용 검증기 외에 현재 사전 설문 API는 `services/workflow.js`의 문항별 검증과 DB 함수를 사용합니다.
조건 코드·진행 상태·생성 시각은 참가자 입력으로 받지 않습니다.
UUID·필수 문구·길이·HTTP(S) URL·UTC ISO 시각·복귀 순서를 검사하고 추가 필드는 거절합니다.
시간 입력 형식은 `2026-01-01T00:00:00.000Z`처럼 밀리초까지 포함한 UTC ISO 문자열입니다.
설문 answers와 행동 payload의 세부 문항·이벤트 허용 목록은 연구 설계 확정 후 추가합니다.

request_id는 동일 저장 동작의 재시도 동안 재사용할 멱등성 UUID이며 채팅은 메시지마다 별도 키를 사용합니다.
동일 request_id의 중복 INSERT는 UNIQUE가 거절합니다. 다음 단계 서비스에서 동일 내용 재시도인지 확인한 뒤 기존 결과를 반환하거나 409로 처리해야 합니다.
저장 요청을 충돌 무시만으로 성공 처리하지 않고, 저장된 응답과 진행 상태를 반환합니다. 단계 시작 기록의 재시도는 최초 시각을 보존합니다.
사전 설문 초안은 revision 검사 후 수정하며 제출 후에는 잠급니다. 009는 최종 제품 답변의 UPDATE/DELETE를 차단하고 연구자 판정 열을 별도로 준비합니다. 최종 제출·사후 설문·종료 처리는 [최종 진행 문서](../FINAL_WORKFLOW.md)를 참고하세요.

## 점검 명령과 결과 해석

```sh
npm.cmd run db:check
node --test tests/enrollment.test.js tests/database.test.js tests/api.test.js tests/flow.test.js
```

db:check는 실제 접속 후 읽기 전용 트랜잭션에서 SELECT 1과 환경 표식만 읽고 종료합니다.
마이그레이션이나 연구 데이터 쓰기는 하지 않습니다. 설정 누락·접속 실패·스키마 미적용·환경 불일치·권한 부족 시 종료 코드 1입니다.
URL·비밀번호·원본 DB 오류는 출력하지 않습니다. 성공은 실제 조회 완료 시에만 표시합니다.
`GET /api/health`는 기존 Express 생존 확인이며 DB 연결 성공을 의미하지 않습니다.
PGlite 테스트 성공은 SQL·제약·권한의 격리 검증이며 실제 Supabase의 네트워크·SSL·계정 설정 검증은 아닙니다.
