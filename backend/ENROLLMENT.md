# 참가자 등록·조건 배정·세션

실제 연구의 적격성 기준은 미정이므로 **개발 테스트만 허용**합니다.
`DB_ENV=research`의 등록은 `503 ELIGIBILITY_NOT_CONFIGURED`로 차단합니다.
서버는 클라이언트의 임의 eligible 또는 condition 값을 받아 실제 연구 등록을 허용하지 않습니다.

## 등록 흐름

1. 최초 화면에서 GET `/api/participant/session`으로 쿠키 세션을 확인합니다.
2. 쿠키가 없는 신규 방문만 POST `/api/participant/session`으로 빈 세션을 발급합니다.
   이 시점에는 참가자 ID·조건을 만들지 않습니다. HttpOnly 쿠키와 DB의 토큰 해시만 준비합니다.
3. 개발 테스트에서 참여 동의와 임시 적격성 확인을 완료합니다.
4. POST `/api/participant/participants`로 서버 검증을 거쳐 등록합니다.
5. DB 함수가 세션 행을 `FOR UPDATE`로 잠그고, 아직 등록되지 않은 세션에만 UUID 참가자를 생성합니다.
   조건·배정 시각·적격성 검증 버전을 같은 트랜잭션에 기록하고 세션과 연결합니다.
6. 등록된 세션은 반복 요청·동시 요청·서버 재시작에도 같은 참가자를 반환합니다.

등록 본문(개발용):

```json
{ "consent": true, "eligibility": { "testEligible": true } }
```

참가자용 성공 JSON에는 registered, participant_id, progress_status만 있습니다.
조건 코드·지연 시간·배정 시각·원본 토큰·토큰 해시는 포함하지 않습니다.
등록 전 JSON은 `{ "registered": false }`입니다.
조건별 UI·문구·로딩 테마는 분기하지 않습니다. 실제 AI 응답 대기 동작은 아직 구현하지 않았습니다.
기존에 등록한 동의·자격 확인은 이전 화면에서 수정할 수 없습니다. 003 이후 참여 중단은 명시적으로 기록하며, 자료 철회·삭제 정책과 삭제 기능은 아직 TODO입니다.

## 무작위 배정

서버 `crypto.randomInt(3)`의 결과를 A/B/C에 대응시킵니다.
각 신규 참가자는 서로 독립적으로 1/3의 확률로 A=2초, B=9초, C=20초에 배정됩니다.
단순 무작위 배정이며 블록·쿼터·현재 인원수에 의한 보정은 사용하지 않습니다.
**240명 모집 시에도 조건별 정확히 80명을 보장하지 않습니다.**
[Node.js crypto 문서](https://nodejs.org/api/crypto.html#cryptorandomintmin-max-callback)를 참고했습니다.

조건 매핑은 `services/enrollment.js`의 서버 전용 상수입니다.
DB participants의 condition_code, assigned_at, eligible, eligibility_version으로 배정 기록을 확인합니다.
DB 트리거는 배정 후 조건·배정 시각·검증 버전 변경을 거절합니다.
같은 세션의 요청이 경합하더라도 첫 저장만 유지하며 후속 요청은 기존 참가자를 반환합니다.
participants.request_id와 participant_sessions.participant_id의 UNIQUE 제약도 중복을 방지합니다.

## 세션 및 요청 검증

- 256비트 난수 토큰을 HttpOnly·SameSite=Lax·Path=/ 쿠키로만 전송합니다.
- DB에는 SHA-256 해시만 저장하며 원본 토큰은 JSON·로그·브라우저 저장소에 복사하지 않습니다.
- HTTPS 배포에서는 `__Host-ai_latency_session` 이름과 Secure를 사용하고 Domain은 지정하지 않습니다.
- 로컬 test HTTP에서만 `ai_latency_session` 이름을 사용하며 Secure 없이 개발할 수 있습니다.
- 쿠키와 DB 만료는 30일입니다. 폐기·만료·변조 세션은 401이며 자동 재배정하지 않습니다.
- POST 요청은 APP_ORIGIN과 정확히 같은 Origin 및 `X-Experiment-Request: 1`을 요구합니다.
- GET 응답은 읽기 전용이고 세션 관련 응답은 Cache-Control: no-store로 캐시하지 않습니다.
- 참가자별 API는 쿠키로 검증한 본인 ID만 허용합니다. 타인의 ID를 본문이나 URL에 넣으면 403입니다.
- DB 앱 역할에는 참가자·세션 테이블 직접 접근 대신 제한된 SECURITY DEFINER 함수 실행만 허용합니다.
  함수의 search_path는 pg_catalog로 고정하며 PUBLIC·anon·authenticated·service_role의 실행 권한을 제거합니다.

등록 전 빈 세션은 연구 참가자 레코드가 아닙니다. 최초 발급의 여러 탭 경합은 지원 브라우저의 Web Locks로 직렬화합니다.
쿠키를 삭제하거나 다른 브라우저·기기를 사용하면 같은 사람인지 자동으로 알아낼 수 없습니다.
완전한 개인 식별 없이 이 경우의 중복 참여까지 막을 수는 없습니다. DB의 기존 참가자 조건을 변경하지는 않습니다.
만료된 쿠키 자체를 브라우저가 지운 경우에도 기존 참가자와 연결할 수 없습니다.
필요하면 추후 승인된 재접속·중복 참여 정책을 설계해야 합니다.

## DB 적용 및 실행

실제 DB에는 자동으로 적용하지 않았습니다. 테스트용 Supabase 프로젝트와 기존 `.env`를 사용하세요.

1. `database/migrations/001_initial_schema.sql`, `002_enrollment_sessions.sql`, `003_early_workflow.sql`을 순서대로 적용합니다.
2. 002는 기존 참가자 행이 있으면 자동 전환하지 않고 중단합니다. 기존 배정 기록을 추정·덮어쓰지 않습니다.
3. 마이그레이션 소유자는 신뢰할 수 있는 전용 관리자 역할이어야 합니다. 런타임 계정은 마이그레이션 소유자나 관리자 역할을 겸하지 않습니다.
4. 서버 DB 로그인에 ai_latency_app 그룹 역할만 부여합니다. public 스키마/Data API로 연구 테이블을 노출하지 않습니다.
5. 실제 `.env`는 덮어쓰지 말고 아래 항목을 추가합니다.

```dotenv
DB_ENV=test
TEST_DATABASE_URL=
DB_SSL_MODE=verify-full
DB_SSL_CA_FILE=
APP_ORIGIN=http://localhost:3000
ELIGIBILITY_POLICY=development-only
```

APP_ORIGIN은 브라우저에서 실제 사용하는 scheme·host·port와 일치해야 하고 마지막 /는 붙이지 않습니다.
localhost와 127.0.0.1은 다른 Origin입니다. 포트를 바꾸면 APP_ORIGIN도 함께 바꾸세요.
연결 문자열·인증서·최소 권한 설정은 [DB 문서](database/README.md)를 참고하세요.

```sh
npm.cmd run db:check
npm.cmd run dev
```

DB 연결 누락·환경 불일치·003까지 미적용·저장 실패는 503으로 처리하며 메모리 저장 성공으로 대체하지 않습니다.
현재 실제 Supabase 연결은 구성되지 않았으므로 로컬 앱에서 등록하려면 별도 DB 설정이 필요합니다.
003 마이그레이션 이후에는 사전 설문·current_step도 복원합니다. [초기 진행 문서](WORKFLOW.md)를 참고하세요.
실제 연구 문구·보관·철회 정책은 여전히 TODO이며 개발 테스트만 허용합니다.

## 개발 검증

```sh
node --test tests/enrollment.test.js tests/database.test.js tests/api.test.js tests/flow.test.js
node --test tests/browser.test.js
```

테스트는 외부 DB 대신 매번 폐기하는 PGlite 메모리 PostgreSQL에서 실제 마이그레이션과 SQL을 실행합니다.
A/B/C 각각의 저장·재접속·서버 인스턴스 재생성, 동시 HTTP 등록 12건, 토큰·권한·CSRF·개발 환경 제한을 검사합니다.
PGlite는 단일 연결 실행 모델이므로 실제 Supabase 다중 연결의 부하·경합 검증까지 수행한 것은 아닙니다.
실제 암호학적 난수로 90명을 배정하는 표본 테스트는 균등 인원수를 단언하지 않습니다.
Chrome 검사는 새로고침 후 같은 참가자 유지, HttpOnly 토큰의 JavaScript 접근 차단, 기존 단계 이동을 확인합니다.
테스트 성공은 실제 Supabase 네트워크·인증서·계정 설정이나 연구용 등록 준비가 완료되었다는 뜻이 아닙니다.
