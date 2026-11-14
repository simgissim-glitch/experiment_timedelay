const router = require('express').Router();
const { validateBody, participantId, isRecord } = require('../../middleware/validate');
const { notImplemented } = require('../../middleware/errors');
const { sessionContext, sameOrigin, requireParticipant } = require('../../middleware/participant-session');
router.post('/post',sessionContext,sameOrigin,validateBody({
  request_id:{check:value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)},
  answers:{check:isRecord},
}),async(req,res)=>res.json(await req.app.locals.getWorkflow().final(req.sessionToken,'post',req.body)));

router.post('/pre', validateBody({
  answers: { check: isRecord },
  mode: { check: (value) => ['draft','submit'].includes(value) },
  revision: { check: (value) => Number.isInteger(value) && value >= 0 && value < 2147483647 },
}), sessionContext, sameOrigin, async (req, res) => {
  res.json(await req.app.locals.getWorkflow().savePre(req.sessionToken, req.body));
});

// TODO: 설문 확정 후 answers의 문항별 값·필수 여부·척도를 검증한다.
router.post('/', validateBody({
  participantId: { check: participantId },
  stage: { check: (value) => ['pre', 'post'].includes(value) },
  answers: { check: (value) => isRecord(value) && Object.keys(value).length > 0 },
}), sessionContext, sameOrigin, requireParticipant, notImplemented('설문 제출'));

module.exports = router;
