const path = require('node:path');
const express = require('express');
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
  // Explicit file responses also work when Vercel bypasses express.static().
  // Literal require.resolve calls make these HTML assets visible to file tracing.
  const indexPage = require.resolve('./public/index.html');
  const adminPage = require.resolve('./public/admin/index.html');
  app.get('/', (_req, res) => res.sendFile(indexPage));
  app.get(['/admin', '/admin/'], (_req, res) => res.sendFile(adminPage));
  app.get('/experiment/:step', sessionContext, async (req, res) => {
    if (!STEPS.includes(req.params.step)) throw new ApiError(404, 'NOT_FOUND', '요청한 단계를 찾을 수 없습니다.');
    await app.locals.getWorkflow().access(req.sessionToken, req.params.step);
    res.sendFile(indexPage);
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', '요청한 경로를 찾을 수 없습니다.')));
  app.use(errorHandler);
  return app;
}

// Vercel must discover a callable default Express export in this file.
module.exports = createApp();
module.exports.createApp = createApp;
