# ai-latency-experiment

종합 검증 결과는 [테스트 보고서](reports/COMPREHENSIVE_TEST_REPORT.md), 로컬/호스팅 점검 방법과 환경변수는 [배포 준비 안내](DEPLOYMENT.md)에 정리합니다. 현재는 연구 실시·외부 배포를 보류하며 실제 데이터 삭제/초기화를 하지 않습니다.

연구자 관리자 화면은 `/admin/`입니다. [관리자 설정·통계·CSV 안내](backend/ADMIN.md)와 [변수 코드북](backend/admin/CODEBOOK.csv)을 참고하세요. 관리자 인증 정보와 별도 DB 연결을 설정한 뒤 사용하며, 미설정 상태에서는 데이터 접근을 차단합니다.

생성형 AI의 응답 지연이 사용자의 정보 검증 행동에 미치는 영향을 연구하기 위한 웹앱입니다.
HTML, CSS, JavaScript와 Node.js·Express 기반 실험 앱입니다.
7단계 HTML과 서버 참가자 등록·조건 배정·DB 세션 복원이 구현되어 있습니다.
동의·사전 설문·과제 안내 완료와 진행 단계는 DB에 저장합니다.
최초 공통 질문·고정 답변, 후속 AI 채팅, 서버 웹 검색·행동 로그에 이어 최종 의사결정과 사후 설문 저장, 디브리핑·종료까지 연결했습니다. 제출 잠금과 승인 정책은 [최종 진행 문서](backend/FINAL_WORKFLOW.md)를 참고하세요.

## 실행 방법

Node.js 22 이상과 npm이 필요합니다. 프로젝트 폴더에서 실행하세요.

```sh
npm install
npm run dev
```

브라우저에서 http://localhost:3000 에 접속합니다. 개발 서버는 파일 변경 시 자동 재시작합니다.
종료는 터미널에서 Ctrl+C를 누릅니다. 자동 재시작 없이 실행하려면 `npm start`를 사용합니다.

PowerShell 실행 정책으로 npm.ps1 오류가 발생하면 `npm.cmd install`, `npm.cmd run dev`, `npm.cmd start`를 사용하세요.

`.env`가 없는 경우에만 `.env.example`을 복사해 `.env`를 생성하세요.
기존 `.env`는 덮어쓰지 마세요. 선택 항목인 `PORT`의 기본값은 `3000`입니다.
다른 포트를 설정했다면 해당 포트로 접속하고 APP_ORIGIN도 일치시켜 주세요.
참가자 등록·초기 진행·채팅·검색·행동 기록에는 DB 접속 정보와 마이그레이션 001~010 적용이 필요합니다.
`.env`에 `OPENAI_API_KEY`와 `OPENAI_MODEL=gpt-6-luna`를 설정하세요. 키는 서버에서만 읽습니다.
실제 API 연결과 두 차례의 후속 대화 점검은 `npm.cmd run ai:check`로 실행합니다(API 사용료 발생).
대화 저장·재시도·호출 제한은 [채팅 문서](backend/CHAT.md)를 참고하세요.
조건별 공개 기한·실제 표시 계측·테스트는 [응답 지연 문서](backend/RESPONSE_TIMING.md)를 참고하세요.
첫 질문·답변의 설정·버전 보존·노출 및 정정 로그는 [최초 자극물 문서](backend/INITIAL_STIMULUS.md)를 참고하세요. test 환경은 가상 제품 파일을 사용하며 연구용 파일은 TODO 상태로 차단됩니다.
웹 검색은 [검색 연결 문서](backend/WEB_SEARCH.md)를 참고해 SEARCH_PROVIDER·SEARCH_API_KEY를 설정하세요. 미설정/실패 시 가짜 결과를 표시하지 않습니다. Brave 연결 어댑터를 제공하며 실제 호출 점검은 `npm.cmd run search:check`입니다.
공통 행동 장부·기록 보관함·복귀 관측·시간 변수와 연구자용 분석 명령은 [행동 로그 문서](backend/BEHAVIOR_LOGGING.md)에 정리했습니다. 최종 제출 시각은 실제 제출 저장 이후에만 존재합니다.

## 파일 구조

```text
ai-latency-experiment/
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/ (app.js, chat.js)
├── backend/
│   ├── routes/
│   ├── middleware/
│   ├── services/
│   └── database/migrations/
├── server.js
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
└── README.md
```

`server.js`는 public 폴더와 연결 확인용 `GET /api/health`를 제공합니다.
연결 확인은 브라우저에서 `/api/health`에 직접 접속하여 할 수 있습니다.
backend 하위 폴더에는 API 라우트, 입력 검증, 등록 서비스와 SQL 마이그레이션이 분리되어 있습니다.

## 환경 변수와 비밀키

실제 환경 변수는 `.env`에서 관리하고 코드에 비밀키를 직접 입력하지 마세요.
`.env`, 환경별 `.env.*`, 인증서·키 파일 및 secrets 폴더는 Git 제외 대상입니다.
`.env.example`에는 예시와 빈 설정만 유지하세요. 새 비밀 파일을 만들 때는 Git 제외 여부를 확인하세요.
이미 Git에 추적된 파일에는 `.gitignore`가 소급 적용되지 않습니다.

## 화면 이동 테스트

동의 → 사전 설문 → 업무 과제 → AI 대화·웹 검색 → 최종 결과 제출 → 사후 설문 → 종료 순서로 진행합니다.
각 화면의 이전/다음 버튼으로 이동하며, 상단 단계 링크로 순서를 건너뛸 수 없습니다.
동의 여부, 개발용 적격성 확인, 사전 설문 3개는 초기 진행의 필수 항목입니다.
AI 이용 경험이 없다고 제출하면 적격성 기준으로 종료합니다. 문항과 척도는 연구자 확정 전 초안입니다.
최종 제품명·주요 사양·판단 이유와 사후 설문 네 문항은 필수이고, 참고 출처는 선택입니다. 문항·척도는 임시 초안입니다.
비동의 선택 후 진행하면 별도 종료 안내를 표시합니다.

사전 설문은 자동·수동 임시 저장과 최종 제출을 지원하고 새로고침 시 저장된 응답·진행 단계를 복원합니다.
동의·적격성 확인 후 참가자 등록은 실제 DB 트랜잭션으로 처리하며, HttpOnly 쿠키로 동일 참가자를 복원합니다.
재접속 시 동일 참가자의 DB current_step으로 재개합니다. 명시적 중단과 단순 미완료를 구분합니다.
서버 진행은 현재 작업 화면 진입까지 연결되어 있으며 이후 단계는 저장 기능 구현 전까지 차단합니다.
프론트엔드는 참가자 ID나 조건을 생성하지 않으며 토큰을 localStorage 등에 복사하지 않습니다.
실제 연구 적격성 기준은 미정이므로 현재 등록은 test 환경에서만 허용합니다.

## 서버 API

참가자 경로 `/api/participant`와 관리자 경로 `/api/admin`를 분리했습니다.
참가자·대화·검색·설문·로그의 입력 계약과 응답은 [backend/API.md](backend/API.md)를 참고하세요.
등록·세션·초기 설문·진행·대화·검색/출처 클릭 API는 DB 연동 상태에서 동작합니다. 그 외 업무 API는 접근 검증 후 501, 관리자 API는 503을 반환합니다.
등록·배정 구현과 한계는 [참가자 등록 문서](backend/ENROLLMENT.md)에 설명합니다.
저장·접근 검사와 종료 구분은 [초기 진행 문서](backend/WORKFLOW.md)를 참고하세요.
서버 검사는 `node --test tests/telemetry.test.js tests/search.test.js tests/stimulus.test.js tests/chat.test.js tests/workflow.test.js tests/enrollment.test.js tests/api.test.js tests/flow.test.js tests/database.test.js`로 실행합니다.

## PostgreSQL 준비

Supabase PostgreSQL용 스키마·연결 점검, 참가자·세션·사전 설문·단계 시각 저장을 구현했습니다.
7개 연구 테이블, 환경 분리, 권한, SQL 적용 절차는 [DB 설계 문서](backend/database/README.md)를 참고하세요.
연결 정보는 `.env`에만 설정하며 기본 점검 대상은 TEST_DATABASE_URL입니다.
`npm.cmd run db:check`는 실제 접속과 환경 표식 조회를 검사하고 미설정·실패 시 오류로 종료합니다.
자동 SQL 검증은 격리된 메모리 PostgreSQL에서만 수행합니다.

상태 전이 검사(추가 패키지 불필요):

```sh
node --test tests/flow.test.js
```

Chrome 헤드리스 화면 검사(Chrome 설치 필요, 기존 프로필 대신 임시 프로필 사용):

```sh
node --test tests/browser.test.js
```

기본 Chrome 경로가 다른 경우 `TEST_BROWSER` 환경 변수에 브라우저 실행 파일 경로를 지정하세요.
