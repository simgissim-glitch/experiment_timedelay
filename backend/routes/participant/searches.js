const router=require('express').Router();
const {validateBody,text}=require('../../middleware/validate');
const {sessionContext,sameOrigin,requireParticipant,requireWorkspace}=require('../../middleware/participant-session');
const {validSourceURL}=require('../../search/provider');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const date=value=>typeof value==='string'&&value.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value));
router.get('/',sessionContext,requireParticipant,requireWorkspace,async(req,res)=>{
  res.json(await req.app.locals.getSearch().history(req.sessionToken));
});
router.post('/sources',validateBody({request_id:{check:uuid},search_event_id:{check:uuid},rank:{check:value=>Number.isInteger(value)&&value>=1&&value<=20},source_url:{check:validSourceURL},clicked_at:{check:date}}),
  sessionContext,sameOrigin,requireParticipant,requireWorkspace,async(req,res)=>{
    res.json(await req.app.locals.getSearch().click(req.sessionToken,req.body));
  });
router.post('/',validateBody({request_id:{check:uuid},query:{check:value=>text(600)(value)&&value.trim().split(/\s+/u).length<=75},submitted_at:{check:date,optional:true}}),
  sessionContext,sameOrigin,requireParticipant,requireWorkspace,async(req,res)=>{
    const result=await req.app.locals.getSearch().execute(req.sessionToken,req.body);
    if(!res.destroyed)res.status(result.status==='pending'?202:200).json(result);
  });
module.exports=router;
