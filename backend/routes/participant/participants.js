const router = require('express').Router();
const { validateBody, validateParticipantId, isRecord } = require('../../middleware/validate');
const { ApiError } = require('../../middleware/errors');
const { sessionContext, sameOrigin, requireParticipant } = require('../../middleware/participant-session');

router.post('/', validateBody({
  consent: { check: (value) => typeof value === 'boolean' },
  eligibility: { check: (value) => isRecord(value) && Object.keys(value).length === 1 && typeof value.testEligible === 'boolean' },
}), sessionContext, sameOrigin, async (req, res) => {
  res.json(await req.enrollment.register(req.sessionToken, req.body));
});
router.get('/:participantId', validateParticipantId, sessionContext, requireParticipant, (req, res, next) => {
  if (req.params.participantId !== req.participant.participant_id) return next(new ApiError(403, 'PARTICIPANT_MISMATCH', '해당 참여 정보에 접근할 수 없습니다.'));
  res.json(req.participant);
});

module.exports = router;
