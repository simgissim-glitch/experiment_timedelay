const path = require('node:path');
const express = require('express');
const { loadConfig } = require('./backend/config');
const apiRouter = require('./backend/routes');
const { ApiError, errorHandler } = require('./backend/middleware/errors');
const { createEnrollmentProvider } = require('./backend/services/enrollment-provider');
const { createWorkflowService, STEPS } = require('./backend/services/workflow');
const { sessionContext } = require('./backend/middleware/participant-session');

function createApp({ getEnrollment = createEnrollmentProvider(), getWorkflow, getChat, getSearch, getAdmin=require('./backend/admin/provider').createAdminProvider(), adminAuth } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.getAdmin=getAdmin;
  app.locals.adminAuth=adminAuth||require('./backend/admin/auth').createAdminAuth(()=>require('./backend/admin/auth').parseAdminConfig(require('./backend/config').readOpenAIEnv()));
  app.use(['/admin','/api/admin'],(_req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});next();
  });
  app.use((req,_res,next)=>{req.receivedAt=new Date().toISOString();next();});
  app.locals.getEnrollment = getEnrollment;
  let telemetry;
  app.locals.getTelemetry=()=>telemetry||(telemetry=require('./backend/services/telemetry').createTelemetryService(getEnrollment().repository));
  let search;
  app.locals.getSearch=getSearch||(()=>{
    if(!search)search=require('./backend/services/search').createSearchService({repository:getEnrollment().repository,
      getProvider:()=>require('./backend/search/provider').createBraveProvider(require('./backend/config').loadSearchConfig())});
    return search;
  });
  let chat;
  app.locals.getChat = getChat || (() => {
    if (!chat) chat = require('./backend/services/chat').createChatService({
      repository:getEnrollment().repository,
      getStimulus:()=>require('./backend/stimuli').loadStimulus(getEnrollment().repository.environment),
      getProvider:()=>require('./backend/ai/openai').createOpenAIProvider(require('./backend/config').loadOpenAIConfig()),
    });
    return chat;
  });
  let workflow;
  app.locals.getWorkflow = getWorkflow || (() => {
    if (!workflow) workflow = createWorkflowService(getEnrollment().repository);
    return workflow;
  });
  app.use('/api', apiRouter);
  app.get('/experiment/:step', sessionContext, async (req, res) => {
    if (!STEPS.includes(req.params.step)) throw new ApiError(404, 'NOT_FOUND', '요청한 단계를 찾을 수 없습니다.');
    await app.locals.getWorkflow().access(req.sessionToken, req.params.step);
    res.sendFile(path.join(__dirname, 'public/index.html'));
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', '요청한 경로를 찾을 수 없습니다.')));
  app.use(errorHandler);
  return app;
}

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
