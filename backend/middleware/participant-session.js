const { ApiError } = require('./errors');

function readToken(req, name) {
  const cookies = (req.get('cookie') || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (cookies.length > 1) throw new ApiError(401, 'SESSION_INVALID', '참여 세션이 유효하지 않습니다.');
  return cookies.length ? cookies[0].slice(name.length + 1) : undefined;
}

function sessionContext(req, res, next) {
  try {
    const { service, config } = req.app.locals.getEnrollment();
    req.enrollment = service;
    req.sessionConfig = config;
    req.sessionToken = readToken(req, config.cookieName);
    res.set('Cache-Control', 'no-store');
    res.vary('Cookie');
    next();
  } catch (error) { next(error); }
}

function sameOrigin(req, _res, next) {
  if (req.get('origin') !== req.sessionConfig.origin || req.get('x-experiment-request') !== '1' || req.get('sec-fetch-site') === 'cross-site') {
    return next(new ApiError(403, 'REQUEST_ORIGIN_REJECTED', '같은 사이트에서 요청해 주세요.'));
  }
  next();
}

async function requireParticipant(req, _res, next) {
  try {
    const status = await req.enrollment.status(req.sessionToken);
    if (!status.registered) throw new ApiError(403, 'ENROLLMENT_REQUIRED', '참여 등록을 먼저 완료해 주세요.');
    if (['withdrawn','declined','ineligible','completed'].includes(status.progress_status)) {
      throw new ApiError(403, 'PARTICIPATION_ENDED', '종료된 참여 세션으로는 실험을 진행할 수 없습니다.');
    }
    req.participant = status;
    // 이전 API의 본문 participantId는 인증 수단이 아니다. 타 참가자 지정은 금지한다.
    if (req.body?.participantId && req.body.participantId !== status.participant_id) {
      throw new ApiError(403, 'PARTICIPANT_MISMATCH', '해당 참여 정보에 접근할 수 없습니다.');
    }
    next();
  } catch (error) { next(error); }
}

async function requireWorkspace(req, _res, next) {
  try { await req.app.locals.getWorkflow().access(req.sessionToken, 'workspace'); next(); }
  catch (error) { next(error); }
}

module.exports = { sessionContext, sameOrigin, requireParticipant, requireWorkspace };
