const { loadConfig } = require('./backend/config');
const { createApp } = require('./app');

if (require.main === module) {
  try {
    const { port } = loadConfig();
    const app = createApp();
    const server = app.listen(port, () => {
      console.log(`실험 앱 서버: http://localhost:${port}`);
    });
    server.on('close', () => { app.locals.getEnrollment.close?.();app.locals.getAdmin.close?.(); });
    server.on('error', () => {
      console.error('서버를 시작하지 못했습니다. 포트 사용 여부와 실행 환경을 확인하세요.');
      process.exitCode = 1;
    });
  } catch {
    console.error('서버 설정이 올바르지 않습니다. PORT는 1~65535 사이 정수여야 합니다.');
    process.exitCode = 1;
  }
}

module.exports = { createApp };
