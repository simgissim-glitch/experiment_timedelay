# Vercel 함수 시작 오류 수정

관측: `https://experiment-timedelay.vercel.app/`와 `/api/health`는 HTTP 500 / FUNCTION_INVOCATION_FAILED, `/css/style.css`는 HTTP 200이었습니다. 정적 CDN은 동작하고 함수 실행 경로가 실패했습니다. 런타임 상세 로그는 별도 확인이 필요합니다.

재현한 코드 결함: Vercel Express 빌더는 관례적인 진입 파일의 **자체 소스**에서 Express import를 찾고 app/index/server 순서로 선택합니다. 기존 app.js는 server.js의 createApp을 간접 호출했으므로 탐지되지 않았습니다. 대신 직접 Express를 import하는 server.js가 선택되었지만, 이 파일의 export는 Express 함수가 아닌 `{createApp}` 객체였습니다. 로컬에서 app.js를 직접 require하는 기존 테스트는 이 탐지 차이를 잡지 못했습니다.

근거: [Vercel 공식 빌더의 탐지 구현](https://github.com/vercel/vercel/blob/main/packages/express/src/build.ts), [Express 배포 문서](https://vercel.com/docs/frameworks/backend/express).

수정:

- app.js가 Express를 직접 import하고, 기존 createApp 구현 및 기본 Express 인스턴스를 export합니다.
- server.js는 로컬 포트 실행과 createApp 재노출만 담당합니다. 기존 테스트 import 경로를 보존합니다.
- 루트 vercel.json에 framework=express, app.js 실행시간 120초, 정적/설정 파일 포함과 관리자 CDN 보안 헤더를 지정했습니다. DB/키/연구자 승인이나 관리자 서버리스 제한은 완화하지 않았습니다.
- 실제 탐지 규칙을 적용해 선택되는 파일이 app.js이고 함수 export인지 검사하는 회귀 테스트를 추가했습니다. VERCEL=1/DB·AI 미설정 환경에서 import가 포트를 열거나 DB에 연결하지 않는지도 검사합니다.

배포 후 확인:

로컬 검증: `npm test`의 서버 테스트 80개 통과. 활성 설정의 buildCommand/outputDirectory override까지 확인하는 진입점 회귀 테스트 3개도 통과했습니다. 실제 배포 복구 여부는 새 배포 응답으로 별도 확인합니다.

1. GitHub 연결 프로젝트는 수정 커밋의 새 배포가 Ready인지 확인합니다. 자동 반영이 없으면 Vercel에서 최신 커밋으로 Redeploy합니다.
2. Framework Preset은 Express, Root Directory는 저장소 루트, Output Directory override는 끕니다. Build Command에 `npm start`, `npm run dev`, 기존 `deployment:check`를 넣지 않습니다. 이는 번들 시작/검토 화면 복구 설정이며 연구 승인 검사를 통과했다는 뜻이 아닙니다.
3. `/api/health`가 200 JSON, `/`가 앱 HTML, CSS/JS가 200인지 확인합니다. 환경변수가 없어도 health는 동작해야 합니다.
4. 참가자 세션은 DB_ENV/test DB URL/APP_ORIGIN 등 올바른 서버 설정과 SQL 001~010 적용이 필요합니다. 미설정 시 앱의 JSON 503이 반환되는 것이 정상이며 함수 시작 500과 구분합니다.
5. 계속 FUNCTION_INVOCATION_FAILED라면 Logs에서 최신 배포의 첫 스택/오류를 확인합니다. 계정 전용 로그에 접근하지 못한 상태에서는 모든 배포 원인이 해결되었다고 단정할 수 없습니다.

이 변경은 기존 .env·연구 데이터·조건 배정·설문 문구를 수정하지 않습니다. 서버리스 관리자 세션, 실제 연구용 적격성/자극물·동의서 승인 등 기존 제한은 유지합니다.
