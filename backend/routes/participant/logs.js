const router=require('express').Router();
const {sessionContext,sameOrigin}=require('../../middleware/participant-session');
const {validateBody}=require('../../middleware/validate');
const {validEvent}=require('../../services/telemetry');
router.get('/context',sessionContext,async(req,res)=>res.json(await req.app.locals.getTelemetry().context(req.sessionToken)));
router.post('/',validateBody({events:{check:events=>Array.isArray(events)&&events.length>0&&events.length<=20&&events.every(validEvent)}}),sessionContext,sameOrigin,async(req,res)=>{
 res.json(await req.app.locals.getTelemetry().ingest(req.sessionToken,req.body.events));
});
module.exports=router;
