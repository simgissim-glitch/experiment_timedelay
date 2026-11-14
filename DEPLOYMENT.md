# 배포 준비 및 검증 절차

후속 Vercel 시작 오류 수정: 현재 루트 `vercel.json`을 활성화했고 app.js가 Express를 직접 import/export하도록 변경했습니다. [오류 원인과 복구 절차](reports/VERCEL_STARTUP_FIX.md)를 먼저 참고하세요. 아래 초기 검토의 ‘템플릿만 준비/미배포’ 내용은 최초 점검 시점의 기록입니다. 현재 검토 화면 복구는 실제 연구 모집 승인을 의미하지 않습니다.

현재 판정은 **연구 실시·외부 배포 보류**입니다. 외부 배포·GitHub 업로드·실제 데이터 삭제/초기화·자동 마이그레이션을 수행하지 않았습니다. 실제 Supabase와 검색 서비스의 연결, 연구 자료/정책 승인, 서버리스 관리자 세션이 남아 있습니다. 로컬 테스트 통과를 실제 배포 성공으로 간주하지 않습니다.

## 실행 환경과 추가한 파일

Node 26.x와 npm을 사용합니다. `.nvmrc`와 package.json/lock의 엔진을 맞췄습니다. `app.js`는 포트를 열지 않는 Express 기본 export이며 `server.js`의 로컬 개발 구조는 유지합니다. `deploy/vercel.template.json`은 검토용 템플릿이며 루트 vercel.json으로 활성화하거나 배포하지 않았습니다. GitHub CI는 `.github/workflows/ci.yml`에 준비했고 실제 실행 여부는 아직 검증하지 않았습니다.

`npm test`는 격리된 PGlite/HTTP 테스트, `npm run test:browser`는 실제 Chrome 렌더링 테스트입니다. `npm run test:all`은 두 그룹을 실행합니다. 브라우저 테스트는 창 포커스 경쟁을 줄이기 위해 파일별 순차 실행하며 가상 시간 가속을 사용하지 않습니다. 테스트 참가자와 DB는 자동 테스트 전용입니다. 실제 .env의 DB에 테스트 참가자를 주입하지 않습니다.

## 환경변수

로컬 기본 설정은 기존처럼 **프로젝트 .env만** 읽습니다. 배포 시 서버의 OS/플랫폼 환경변수에 `SERVER_ENV_SOURCE=platform`을 설정합니다. Vercel은 이를 자동 선택하며 로컬 .env로 대체하지 않습니다. .env 안에 SERVER_ENV_SOURCE를 적는 것만으로 모드가 전환되지는 않습니다. 비밀값을 CLI 인수·프론트엔드·NEXT_PUBLIC_/VITE_ 변수에 넣지 않습니다. 기존 .env는 자동 변경하지 않았습니다.

| 변수 | 로컬/비공개 테스트 | 향후 승인된 실제 연구 배포 |
| --- | --- | --- |
| SERVER_ENV_SOURCE | 기본 file | platform(서버 플랫폼 설정) |
| DB_ENV | test 명시 | research 명시 |
| TEST_DATABASE_URL / DATABASE_URL | 테스트 프로젝트 앱 역할 URL | 연구 프로젝트 앱 역할 URL |
| TEST_ADMIN_DATABASE_URL / ADMIN_DATABASE_URL | 테스트 프로젝트 관리자 역할 URL | 연구 프로젝트 관리자 역할 URL |
| DB_SSL_MODE | 원격 verify-full; 로컬 DB만 disable 가능 | verify-full |
| DB_SSL_CA_FILE | 인증서 필요 시 서버 파일 | 필요 시 서버 인증서 번들 제공 방식 별도 확인; .vercelignore는 pem 파일 제외 |
| APP_ORIGIN | localhost 또는 정확한 비공개 HTTPS 테스트 Origin | 실제 HTTPS 도메인과 정확히 일치, 마지막 / 없음 |
| ELIGIBILITY_POLICY | development-only | 실제 기준 구현/승인 전 등록 차단 유지 |
| OPENAI_API_KEY / OPENAI_MODEL | 테스트 키/승인 모델; 현재 gpt-6-luna | 서버 전용 별도 연구 프로젝트 키/고정 모델 버전 검토 |
| SEARCH_PROVIDER / SEARCH_API_KEY | brave 또는 승인된 어댑터/테스트 키 | 확정 제공자/연구용 키 |
| SEARCH_COUNTRY / SEARCH_LANGUAGE / SEARCH_RESULT_COUNT | KR / ko / 10 기본 | 모든 조건에 동일 설정 |
| ADMIN_USERNAME / ADMIN_PASSWORD_HASH | 서버 전용; admin:password로 해시 생성 | 개인별 계정/감사 정책 확정; 현재 배포당 단일 계정 |
| ANALYSIS_DATABASE_URL | 연구자 로컬 읽기 전용 분석 계정, 선택 | 웹 서버 관리자 URL로 자동 대체하지 않음 |
| RESEARCH_RELEASE_APPROVED | false 유지 | 모든 검토 후 연구자가 승인한 경우에만 true |
| PORT | 기본 3000 | 상시 Node 서버의 수신 포트; Vercel app.js는 listen하지 않음 |

`.env.example`은 빈 예시입니다. 테스트/실제 연구는 서로 다른 Supabase 프로젝트와 최소 권한 계정으로 분리합니다. DB 내부 deployment_context 환경·schema_version=10도 확인해야 합니다. 배포 점검은 설정 형식 검사이며 `db:check`, `admin:verify`의 실제 연결 검사까지 대체하지 않습니다. 마이그레이션 001~010은 기존 적용 번호를 확인한 뒤 승인된 변경 절차로만 실행합니다.

## Vercel 서버리스 판정

| 항목 | 판정 | 근거와 후속 조치 |
| --- | --- | --- |
| Node/Express 진입점 | 로컬 어댑터 검증, 실제 Vercel 빌드 미실행 | app.js 기본 export, Node 26.x. [공식 Express 안내](https://vercel.com/docs/frameworks/backend/express), [지원 Node 버전](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions) |
| 환경변수 | 로딩 보완/자동 테스트 통과 | Vercel 서버 변수를 사용하고 로컬 파일 fallback 차단. [공식 환경변수 안내](https://vercel.com/docs/environment-variables) |
| DB 연결 수 | 코드 보완, 원격 연결 미검증 | 모듈 범위 풀 재사용, 서버리스 인스턴스당 max=1. 전체 연결 수는 인스턴스 수만큼 증가. Supabase transaction pooler와 TLS/역할 테스트 필요 |
| 트랜잭션 풀러 | 구조상 가능, 실 연결 시험 필요 | pg의 이름 없는 파라미터 질의 사용. 관리자 SET LOCAL ROLE은 트랜잭션 내부에서만 사용. 세션 상태/이름 있는 prepared statement에 의존하지 않음. [Supabase 연결 문서](https://supabase.com/docs/guides/database/connecting-to-postgres) |
| 최대 실행시간 | 120초 템플릿, 실제 배포 설정 미검증 | SDK 제한 60초와 목표 20초는 동시에 진행되어 일반적으로 max(생성시간, 목표시간)+DB/네트워크 비용. 120초는 여유 예산이지 성공 보장이 아님. [Vercel duration](https://vercel.com/docs/functions/configuring-functions/duration) |
| 지연 조작 | 로컬 Chrome 검증, 호스팅 실측 필요 | 답변 본문은 공개 기한 전 전송 안 함. cold start·왕복 지연·렌더링 비용으로 초과 가능. 정확히 2/9/20초를 보장하지 않으며 실제 시간을 기록 |
| HTTP 연결 중단/인스턴스 종료 | 배포 차단 사항 | 로컬의 계속 실행 동작을 서버리스 생존 보장으로 볼 수 없음. 강제 종료 시 pending lease와 명시적 재시도는 있으나 provider 호출과 DB commit 사이의 장애는 분산 작업/복구 설계로 보완 필요 |
| 관리자 세션/로그인 제한 | 서버리스 차단 | 메모리는 인스턴스마다 다름. 서로 다른 인증 인스턴스에서 세션 공유 실패를 재현했고 ADMIN_SERVERLESS_UNSUPPORTED로 차단. 공유 영속 세션/로그인 제한 또는 별도 승인 인증을 구현해야 함 |
| CSV/대용량 조회 | 서버리스 배포 전 보완 | 현재 스냅샷·CSV는 메모리 버퍼 방식. Vercel 비스트리밍 응답 4.5MB 제한에 걸릴 수 있음. 인증된 스트리밍/분할/보호된 객체 저장소 내보내기 필요. [공식 제한](https://vercel.com/docs/functions/limitations) |
| 정적 파일/캐시 | 템플릿만 준비 | Vercel은 public을 CDN 제공하며 express.static은 무시됨. 관리자 CDN 경로에도 no-store/CSP 등 템플릿 헤더 필요. 보호해야 할 단계의 저장 권한은 계속 서버 API가 검사 |

현재는 상시 실행되는 단일 Node 프로세스가 기존 인증 구조와 더 잘 맞습니다. 상시 서버에서도 재시작하면 관리자 재로그인이 필요합니다. Vercel을 선택하면 위 차단 사항을 해결한 뒤에만 비공개 테스트 환경으로 진행합니다. Edge runtime으로 바꾸지 않습니다.

## 로컬에서 재현하기

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run test:browser
npm.cmd run security:check
npm.cmd audit --omit=dev
npm.cmd run deployment:check -- --target=persistent
```

브라우저 테스트에는 Chrome이 필요합니다. Windows 기본 경로를 사용하고 다른 OS는 TEST_BROWSER에 실행 파일 경로를 지정합니다(예: CI의 /usr/bin/google-chrome). 테스트는 실제 .env DB를 읽지 않고 PGlite를 만들며 AI/검색은 대역을 사용합니다. npm ci는 의존성 설치이며 DB 삭제/초기화 명령이 아닙니다. 기존 node_modules를 다시 설치하고 싶지 않으면 설치 단계를 건너뛰고 테스트를 실행합니다.

설정 후의 실제 연결 검사는 아래 명령으로 별도로 수행합니다. ai:check는 실제 API 2회, stimulus:check는 가상 자극물 정정 1회, search:check는 실제 검색 1회를 호출하므로 승인된 테스트 키/과금 환경을 사용합니다. db:check/admin:verify는 읽기 전용이며 가짜 연결 성공을 반환하지 않습니다.

```powershell
npm.cmd run db:check
npm.cmd run ai:check
npm.cmd run stimulus:check
npm.cmd run search:check
npm.cmd run admin:verify
npm.cmd run dev
```

UI 수동 점검은 동의→설문→과제→최초 공통 답변→후속 오류 지적→선택적 검색→외부 출처 새 탭→복귀→최종 제출→사후 설문→디브리핑→완료 순서입니다. 각 중간 단계에서 새로고침하고 비동의/이용 경험 없음/중단 경로도 확인합니다. 제출 전 최종 결정·사후 설문 입력은 메모리 초안이므로 새로고침하면 복원되지 않는 현재 한계를 구분합니다. 저장된 제출과 사전 설문 초안은 서버에서 복원됩니다.

## 향후 비공개 배포에서 시험하기 — 이번에는 실행하지 않음

1. 연구자 승인, 서버리스 차단 사항 해결 또는 상시 서버 선택, 테스트 전용 DB/키 준비, 백업/이관 계획을 먼저 확정합니다.
2. 승인된 사설 저장소와 접근 제한된 테스트 배포를 준비합니다. 실제 모집 링크를 배포하지 않습니다. Vercel을 사용한다면 Deployment Protection을 설정하고 Preview에는 연구 DB/키를 넣지 않습니다.
3. 템플릿을 검토해 루트 vercel.json으로 활성화하는 작업은 별도 승인 후 진행합니다. 프로젝트에서 Fluid compute·Node26·함수 실행시간·DB 가까운 리전을 확인합니다. 템플릿의 deployment:check는 현재 서버리스 관리자 제약 때문에 차단되는 것이 정상입니다.
4. `.env`를 업로드하지 않고 플랫폼의 서버 변수만 설정합니다. APP_ORIGIN은 실제 테스트 도메인으로 지정합니다. 프리뷰 도메인이 변경되면 해당 배포의 설정도 맞춥니다. 모든 비밀값이 Preview/Production에 무차별 공유되지 않게 구분합니다.
5. /api/health, 인증 없는 관리자/CSV 401 또는 미설정 503, 타 참가자 접근 거절, TLS/DB 역할·환경 표식, 실제 OpenAI/검색 연결을 확인합니다.
6. 테스트 참가자를 만들고 DB의 A/B/C 배정이 모두 관측될 때까지 단순 무작위 배정합니다. 적은 표본에서 세 조건이 모두 나오는 것은 보장되지 않습니다. DB나 참가자 요청으로 조건을 바꾸지 않습니다. 세 조건별 최초·후속 2회 이상과 느린 생성, 새로고침, cold start/다중 인스턴스/연결 중단을 실제 브라우저에서 측정합니다.
7. 브라우저 first-character/output-completed 이벤트와 DB chat_timings/research_events를 대조합니다. 검색 실행/결과 표시/출처 클릭/이탈/복귀, 최종 제출 시각을 별도로 확인하고 서버·브라우저 시계와 performance를 혼합하지 않습니다.
8. 수집이 멈춘 동일한 테스트 스냅샷에서 관리자 숫자와 세 CSV/코드북을 대조합니다. 대용량 파일·중도 이탈자·CSV 수식 안전 처리를 포함합니다. 테스트 자료도 승인 없이 삭제하거나 연구 자료에 합치지 않습니다.

## GitHub 준비

현재 폴더는 Git 저장소가 아니어서 과거 커밋·원격 GitHub 노출 여부를 확인할 수 없습니다. 이번 작업에서 git init/commit/push/저장소 생성은 하지 않았습니다. `.gitignore`는 .env/키/자격 증명/.vercel 및 exports 경로를 제외합니다. `.vercelignore`도 비밀 파일을 제외합니다. 코드북과 테스트 측정값은 가상/격리 테스트 자료이고 실제 참가자 자료는 저장소에 넣지 않습니다.

추후 승인된 사설 저장소에서 추적 파일 목록과 이력에 비밀값이 없는지 확인하고 [GitHub secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning) 및 push protection을 활성화합니다. `.gitignore`는 이미 추적된 파일이나 과거 커밋을 정리해 주지 않습니다. 노출이 확인되면 키 교체를 우선합니다. CI는 비밀키 없이 격리 테스트만 실행하며 배포 단계가 없습니다.
