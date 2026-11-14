# 연구자 관리자 대시보드

접속 주소는 `/admin/`입니다. 참가자 화면의 HTML/CSS/채팅 동작은 유지합니다. 관리자 화면에 예시 인원이나 데모 통계를 주입하지 않으며, 실제 조회 실패는 오류로 표시합니다.
서버리스 점검에서 메모리 세션의 인스턴스 간 공유 불가를 확인했습니다. Vercel 관리자 인증은 현재 명시적으로 차단합니다. 플랫폼 환경변수·상시 서버/서버리스 선택과 남은 작업은 [배포 준비 안내](../DEPLOYMENT.md)를 참고하세요.

## 설정과 실행

1. 대상 프로젝트를 확인하고 기존 001~009 뒤에 `database/migrations/010_admin_dashboard.sql`을 관리자 계정으로 적용합니다. 기존 연구 데이터는 삭제하지 않습니다. 서버·로컬 분석은 schema_version=10을 요구합니다.
2. 참가자 앱 계정과 다른 전용 DB 로그인 역할을 준비하고 `ai_latency_admin` 그룹만 부여합니다. 이 그룹은 RLS를 거쳐 연구 테이블을 조회하고, 유일한 수정 경로인 `admin_code_final` 함수만 실행합니다. 테이블 직접 UPDATE/DELETE 권한을 부여하지 마세요. 플랫폼 소유자·superuser·BYPASSRLS 계정을 웹 런타임에 사용하지 마세요.
3. 터미널에서 `npm.cmd run admin:password`를 실행합니다. 입력은 화면에 표시하지 않으며 12자 이상을 요구합니다. 출력된 scrypt 해시를 `.env`에 직접 저장합니다. 원문 비밀번호를 명령 인수·코드·문서에 적지 않습니다.
4. `.env.example`을 참고해 기존 `.env`를 보존하면서 아래 항목을 추가합니다. 값은 빈 예시이며 실제 인증 정보를 뜻하지 않습니다.

```dotenv
DB_ENV=test
APP_ORIGIN=http://localhost:3000
ADMIN_USERNAME=
ADMIN_PASSWORD_HASH=
TEST_ADMIN_DATABASE_URL=
ADMIN_DATABASE_URL=
```

`DB_ENV=test`이면 TEST_ADMIN_DATABASE_URL만, research이면 ADMIN_DATABASE_URL만 사용합니다. 환경 선택을 명시해야 하며 참가자 DATABASE_URL이나 ANALYSIS_DATABASE_URL로 자동 대체하지 않습니다. DB 내부 deployment_context 환경과 버전도 검사합니다. SSL 설정은 기존 DB_SSL_MODE/DB_SSL_CA_FILE을 사용하며 원격 TLS 인증서 검증을 유지합니다. 운영 Origin은 HTTPS이어야 하고 로컬 test에서만 HTTP를 허용합니다. 테스트/연구 환경은 서로 다른 Supabase 프로젝트로 분리하세요.

5. `npm.cmd run dev` 실행 후 `/admin/`에서 로그인합니다. 인증/DB가 설정되지 않았으면 각각 명시적인 오류를 반환하고 통계 성공을 표시하지 않습니다.
DB 환경이나 연결 설정을 변경한 경우 서버를 재시작하세요. 한 실행 프로세스에서 테스트/연구 DB를 전환하지 않습니다.
6. `npm.cmd run admin:verify`로 실제 관리자 DB 스냅샷과 CSV를 대조합니다. 성공 때만 status=ok를 출력하며, 미연결·환경 불일치·권한 오류는 비정상 종료합니다. 이 명령은 읽기 전용이며 DB에 시드를 넣거나 마이그레이션을 자동 적용하지 않습니다.

## 인증과 접근 권한

| API | 용도 |
| --- | --- |
| POST /api/admin/login | username/password 로그인 |
| POST /api/admin/logout | 관리자 세션 폐기 |
| GET /api/admin/session | 로그인 상태와 만료 시각 |
| GET /api/admin/overview | 전체·조건·단계·검색 기초 통계 |
| GET /api/admin/participants?limit=50&offset=0 | 참가자 페이지 목록(limit 최대 200) |
| GET /api/admin/participants/:id | 참가자별 전체 기록 |
| POST /api/admin/participants/:id/coding | request_id/code/notes/revision; 연구자 계정은 서버 결정 |
| GET /api/admin/exports/:kind | participants/events/conversations/codebook CSV |

서버에서 scrypt와 일정 길이 timingSafeEqual로 인증 정보를 비교합니다. 브라우저 코드에 계정/해시를 하드코딩하지 않고 localStorage/sessionStorage에도 저장하지 않습니다. 입력 비밀번호는 요청 후 폼에서 지우며 로그에 남기지 않습니다. 설정을 바꾸면 기존 세션도 유효성 검사에서 거절됩니다.

관리자 전용 32바이트 난수 토큰은 HttpOnly·SameSite=Strict 쿠키로 전달합니다. HTTPS는 Secure 및 __Host 접두사를 사용합니다. 서버 메모리에는 토큰 해시만 저장하고 30분 절대 만료·로그아웃 폐기를 검사합니다. 관리자 세션은 참가자 세션과 별개이며 참가자 토큰으로 접근할 수 없습니다. 서버 재시작 시 모두 폐기됩니다. 현재 단일 Node 프로세스용 구현이므로 다중 인스턴스로 확장할 때는 공통 세션/로그인 제한 저장소가 필요합니다.

로그인 시도(성공 포함)는 IP당 15분 5회, 전체 15분 60회로 제한합니다. 서버는 임의 X-Forwarded-For를 신뢰하지 않습니다. 로그인·로그아웃·코딩 POST는 APP_ORIGIN과 X-Admin-Request:1을 검사합니다. 모든 데이터/CSV/코딩 API는 서버에서 관리자 세션을 검사합니다. no-store, CSP, 프레임 차단과 Referrer-Policy를 적용하며 동적 데이터는 textContent로 출력합니다. 계정은 현재 배포당 1개이며 코딩 이력에는 이 계정명이 남습니다.

## 화면과 지표

- 전체 참가자 = 익명 participant_id가 발급된 행. 완료·진행 중(단순 미완료 포함)·명시적 중단·적격성 종료·기존 비동의 기록을 별도 집계합니다. ID 발급 전 비동의 세션은 참가자 수에 넣지 않습니다.
- 조건별 완료율 = 해당 조건 completed / 해당 조건 전체 배정(적격성 종료 포함). 관측이 없으면 완료율/지연 평균을 0으로 만들지 않고 결측으로 표시합니다.
- 조건별 실제 지연 평균은 관측 가능한 답변을 단위로 가중한 평균입니다. `analysis/metrics.js`의 질문 전송~최초 표시 성능 시계를 우선 사용하고, 기존 first_elapsed_ms를 대체 사용합니다. 복원 표시·미관측 지연은 제외합니다. 서버 생성시간이나 목표 2/9/20초를 실제 지연으로 대체하지 않습니다. 관측 수와 결측/시계 품질은 함께 확인하세요.
- 단계별로 도달·완료·명시적 종료 후 미완료·진행 중 미완료를 구분합니다. 일정 시간이 지났다는 이유만으로 이탈을 확정하지 않습니다.
- 검색 시도(실패 포함), 제공자 실제 API 호출, 검색 완료, 출처 클릭, 복귀 기록을 분리합니다. 외부 호스트 클릭은 실제 독해/이해 또는 출처 간 독립성 증거가 아닙니다.
- 참가자 상세는 완료자뿐 아니라 중단·부적격·미완료자도 조회합니다. 사전/사후 응답, 대화 순서, 지연 원자료, 검색 결과 스냅샷, 출처 접근·복귀, 최종 답변, 행동 장부와 코딩 이력을 확인할 수 있습니다.

## 연구자 코딩

미판정/not_assessed, 수용/accepted, 비수용/rejected, 불명확/unclear를 직접 선택하고 메모를 작성합니다. 자동 판정하지 않고 참가자 API에도 공개하지 않습니다. 최종 답변 미제출자는 코딩할 수 없습니다.

`final_decision_codings`에 기존/변경 코드, 연구자 계정, 메모, 서버 시각, 버전을 남깁니다. request_id 재시도는 중복 저장하지 않으며 revision 불일치는 409로 거절합니다. 코딩 수정은 최종 제품명·사양·근거·제출 시각을 변경할 수 없습니다. 앱 역할은 코딩 함수도 실행할 수 없습니다.

## CSV와 코드북

`GET /api/admin/exports/participants`, `/events`, `/conversations`, `/codebook`에서 각각 다운로드합니다. 참가자 단위 자료에는 사전/사후 응답 JSON, 최종 답변과 연구자 코딩, 단계별 시각과 기초 시간 변수가 포함됩니다. 원본 이벤트 파일은 research_events 장부이며 기존 behavior_events의 이관 자료는 origin=legacy로 구분합니다. 대화 파일은 참가자 내 sequence_number 순서입니다.

변수별 정의는 [CODEBOOK.csv](admin/CODEBOOK.csv)와 인증 후 다운로드하는 코드북에 있습니다. UTF-8 BOM/RFC4180을 사용하고 JSON·따옴표·줄바꿈을 보존합니다. 수식 실행 위험이 있는 문자열 앞에는 작은따옴표를 추가하므로 이 셀은 원문과 한 글자 차이가 납니다. 원문 자체는 DB에서 수정하지 않습니다. 빈 셀은 결측이고 0/false와 구분합니다. 시각은 UTC ISO8601, 시간 변수는 ms입니다. 관측 활동 0ms는 관측 구간이 없다는 뜻일 수 있으며 실제 검증 시간 0을 입증하지 않습니다.

각 요청은 REPEATABLE READ 스냅샷에서 조회하고 환경·snapshot_at을 제공합니다. 화면 새로고침·개별 CSV는 서로 다른 스냅샷이므로 수집 중에는 행이 추가될 수 있습니다. 같은 시점의 정확한 배치 분석은 수집을 멈춘 후 다운로드하거나 로컬 읽기 전용 분석을 사용하세요. 테이블별 100,000행 초과 시 부분 파일을 성공으로 내보내지 않고 오류를 반환합니다. 이 규모를 넘는 연구는 서버 측 스트리밍/필터 내보내기로 확장해야 합니다.

## 운영과 검증

데이터 삭제·실험 설정 변경 UI와 실행 API는 제공하지 않습니다. `/data`, `/settings`, `/participants/:id/delete`는 인증 후에도 405입니다. 별도 작업은 대상 환경/범위 확인 → 백업 → 영향 검토 → 연구자 명시적 승인 절차 후 수행해야 하며, 이 기능을 나중에 추가할 때 서버 재인증·구체적 확인 단계를 반드시 구현해야 합니다.

자동 테스트는 격리된 PGlite에서 참가자 흐름으로 완료/진행/중단/부적격 데이터를 만든 뒤 SQL 행과 통계·CSV를 대조합니다. 테스트 AI·검색 제공자는 대역이며 실제 연구 결과가 아닙니다. `node --test tests/admin.test.js`와 `node --test tests/admin-browser.test.js`로 확인합니다. 기존 `.env`는 자동 변경하지 않습니다.
