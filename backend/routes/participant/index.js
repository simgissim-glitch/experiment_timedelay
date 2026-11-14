const router = require('express').Router();

// 업무별 라우트에서 세션·단계·입력 검증과 저장을 담당한다.
router.use('/session', require('./session'));
router.use('/progress', require('./progress'));
router.use('/participants', require('./participants'));
router.use('/conversations', require('./conversations'));
router.use('/searches', require('./searches'));
router.use('/surveys', require('./surveys'));
router.use('/decisions', require('./decisions'));
router.use('/logs', require('./logs'));

module.exports = router;
