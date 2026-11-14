class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notImplemented(feature) {
  return (_req, _res, next) => next(new ApiError(
    501, 'NOT_IMPLEMENTED', `${feature} 기능은 아직 구현되지 않았습니다. 데이터는 저장되거나 처리되지 않았습니다.`,
  ));
}

function errorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);
  let safeError = error;
  if (!(error instanceof ApiError)) {
    if (error.type === 'entity.parse.failed') {
      safeError = new ApiError(400, 'INVALID_JSON', '올바른 JSON 형식으로 요청해 주세요.');
    } else if (error.type === 'entity.too.large') {
      safeError = new ApiError(413, 'PAYLOAD_TOO_LARGE', '요청 본문은 64KB 이하여야 합니다.');
    } else if (error.status === 415) {
      safeError = new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '지원하지 않는 요청 인코딩입니다.');
    } else {
      safeError = new ApiError(500, 'INTERNAL_ERROR', '서버에서 요청을 처리하지 못했습니다.');
      // 입력 본문·환경 변수·원본 오류는 로그 또는 응답에 노출하지 않는다.
      console.error('API INTERNAL_ERROR');
    }
  }
  const body = { code: safeError.code, message: safeError.message };
  if (safeError.details) body.details = safeError.details;
  res.status(safeError.status).json({ error: body });
}

module.exports = { ApiError, notImplemented, errorHandler };
