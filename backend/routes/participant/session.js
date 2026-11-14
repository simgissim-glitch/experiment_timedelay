const router = require('express').Router();
const { validateBody } = require('../../middleware/validate');
const { sessionContext, sameOrigin } = require('../../middleware/participant-session');

router.get('/', sessionContext, async (req, res) => {
  res.json(await req.enrollment.status(req.sessionToken));
});
router.post('/', validateBody({}), sessionContext, sameOrigin, async (req, res) => {
  const result = await req.enrollment.prepare(req.sessionToken);
  if (result.token) {
    const config = req.sessionConfig;
    res.cookie(config.cookieName, result.token, {
      httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/', maxAge: config.ttlSeconds * 1000,
    });
  }
  res.json(result.status);
});

module.exports = router;
