const router = require('express').Router();
const { validateBody } = require('../../middleware/validate');
const { sessionContext, sameOrigin } = require('../../middleware/participant-session');
const { STEPS } = require('../../services/workflow');

router.use(sessionContext);
router.get('/', async (req, res) => res.json(await req.app.locals.getWorkflow().state(req.sessionToken)));
router.get('/access/:step', async (req, res) => {
  await req.app.locals.getWorkflow().access(req.sessionToken, req.params.step);
  res.json({ allowed: true });
});
router.post('/navigate', sameOrigin, validateBody({ step: { check: (value) => STEPS.includes(value) } }), async (req, res) => {
  res.json(await req.app.locals.getWorkflow().navigate(req.sessionToken, req.body.step));
});
router.post('/task-guide/complete', sameOrigin, validateBody({ acknowledged: { check: (value) => value === true } }), async (req, res) => {
  res.json(await req.app.locals.getWorkflow().completeTask(req.sessionToken));
});
router.post('/end', sameOrigin, validateBody({ reason: { check: (value) => ['declined','withdrawn'].includes(value) } }), async (req, res) => {
  res.json(await req.app.locals.getWorkflow().terminate(req.sessionToken, req.body.reason));
});
for (const [path,action] of [['workspace/complete','open'],['debriefing/complete','finish']]) {
  router.post('/'+path,sameOrigin,validateBody({acknowledged:{check:value=>value===true}}),async(req,res)=>{
    res.json(await req.app.locals.getWorkflow().final(req.sessionToken,action));
  });
}

module.exports = router;
