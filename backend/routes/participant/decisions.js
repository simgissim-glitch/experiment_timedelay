const router = require('express').Router();
const {validateBody}=require('../../middleware/validate');
const {sessionContext,sameOrigin}=require('../../middleware/participant-session');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
router.post('/',sessionContext,sameOrigin,validateBody({
 request_id:{check:uuid},product:{check:value=>typeof value==='string'},
 specifications:{check:value=>typeof value==='string'},rationale:{check:value=>typeof value==='string'},
 references:{check:value=>typeof value==='string'},
}),async(req,res)=>res.json(await req.app.locals.getWorkflow().final(req.sessionToken,'decision',req.body)));
module.exports=router;
