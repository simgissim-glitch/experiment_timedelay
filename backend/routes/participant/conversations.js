const router = require('express').Router();
const { validateBody, text } = require('../../middleware/validate');
const { sessionContext, sameOrigin, requireParticipant, requireWorkspace } = require('../../middleware/participant-session');
const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const timestamp=value=>typeof value==='string' && value.length<=40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
router.post('/presentation',validateBody({delivery_id:{check:uuid},event:{check:value=>['first-character','output-completed'].includes(value)},
  at:{check:timestamp},elapsed_ms:{check:value=>value===null || (Number.isFinite(value)&&value>=0&&value<=86400000)},restored:{check:value=>typeof value==='boolean'}}),
  sessionContext,sameOrigin,requireParticipant,requireWorkspace,async(req,res)=>{
    await req.app.locals.getChat().presentation(req.sessionToken,req.body);res.json({recorded:true});
  });
router.get('/',sessionContext,requireParticipant,requireWorkspace,async(req,res)=>{
  res.json(await req.app.locals.getChat().history(req.sessionToken));
});
router.post('/',validateBody({request_id:{check:uuid},message:{check:text(10000)},retry:{check:value=>typeof value==='boolean',optional:true},submitted_at:{check:timestamp,optional:true}}),
  sessionContext,sameOrigin,requireParticipant,requireWorkspace,async(req,res)=>{
    const result=await req.app.locals.getChat().send(req.sessionToken,req.body,{receivedAt:req.receivedAt});
    if(!res.destroyed)res.status(result.status==='pending'?202:200).json(result);
  });
module.exports=router;
