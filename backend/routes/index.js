const express = require('express');
const { ApiError } = require('../middleware/errors');
const participantRouter = require('./participant');
const adminRouter = require('./admin');
const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', message: 'Express 서버에 정상적으로 연결되었습니다.' });
});
router.use((req, _res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
    return next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type: application/json으로 요청해 주세요.'));
  }
  next();
});
router.use(express.json({ limit: '64kb', strict: true }));
router.use('/participant', participantRouter);
router.use('/admin', adminRouter);
router.use((_req, _res, next) => next(new ApiError(404, 'API_NOT_FOUND', '요청한 API 경로를 찾을 수 없습니다.')));

module.exports = router;
