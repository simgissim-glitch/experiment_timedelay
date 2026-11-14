const router=require('express').Router();
const {requireAdmin}=require('../middleware/admin-access');
const {validateBody}=require('../middleware/validate');
const {ApiError}=require('../middleware/errors');
const {overview,detail,participantRows}=require('../admin/data');
const {schemas,csv,exportRows,codebook}=require('../admin/csv');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
router.post('/login',validateBody({username:{check:v=>typeof v==='string'&&v.length>0&&v.length<=100},password:{check:v=>typeof v==='string'&&v.length>0&&v.length<=1000}}),async(req,res)=>res.json(await req.app.locals.adminAuth.login(req,res,req.body.username,req.body.password)));
router.post('/logout',(req,res)=>res.json(req.app.locals.adminAuth.logout(req,res)));
router.use(requireAdmin);
router.get('/session',(req,res)=>res.json({authenticated:true,...req.admin}));
router.get('/overview',async(req,res)=>res.json(overview(await req.app.locals.getAdmin().snapshot())));
router.get('/participants',async(req,res)=>{
 const rawLimit=req.query.limit??'50',rawOffset=req.query.offset??'0';
 if(typeof rawLimit!=='string'||typeof rawOffset!=='string'||!/^\d+$/.test(rawLimit)||!/^\d+$/.test(rawOffset)||Number(rawLimit)<1||Number(rawLimit)>200||!Number.isSafeInteger(Number(rawOffset)))throw new ApiError(400,'VALIDATION_ERROR','목록 범위를 확인해 주세요.');
 const s=await req.app.locals.getAdmin().snapshot(),rows=participantRows(s);
 res.json({environment:s.environment,snapshot_at:s.snapshot_at,total:rows.length,participants:rows.slice(Number(rawOffset),Number(rawOffset)+Number(rawLimit))});
});
router.get('/participants/:id',async(req,res)=>{if(!uuid(req.params.id))throw new ApiError(400,'VALIDATION_ERROR','참가자 ID 형식을 확인해 주세요.');res.json(detail(await req.app.locals.getAdmin().snapshot(),req.params.id));});
router.post('/participants/:id/coding',(req,res,next)=>{try{req.app.locals.adminAuth.checkOrigin(req);next();}catch(error){next(error);}},validateBody({request_id:{check:uuid},code:{check:v=>['not_assessed','accepted','rejected','unclear'].includes(v)},notes:{check:v=>typeof v==='string'&&v.length<=2000},revision:{check:v=>Number.isInteger(v)&&v>=0&&v<2147483647}}),async(req,res)=>{
 if(!uuid(req.params.id))throw new ApiError(400,'VALIDATION_ERROR','참가자 ID 형식을 확인해 주세요.');
 res.json(await req.app.locals.getAdmin().code(req.params.id,req.body,req.admin.username));
});
router.get('/exports/:kind',async(req,res)=>{
 const kind=req.params.kind;let body,environment;
 if(kind==='codebook'){body=csv(['file','variable','meaning','missing','format'],codebook());environment='definitions';}
 else {if(!Object.hasOwn(schemas,kind))throw new ApiError(404,'NOT_FOUND','다운로드 종류를 확인해 주세요.');const s=await req.app.locals.getAdmin().snapshot();environment=s.environment;body=csv(Object.keys(schemas[kind]),exportRows(kind,s));}
 res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${environment}-${kind}.csv"`}).send(body);
});
router.all(['/data','/settings','/participants/:id/delete'],(_req,_res)=>{throw new ApiError(405,'ADMIN_OPERATION_DISABLED','데이터 삭제와 실험 설정 변경은 비활성화되어 있습니다. 별도 운영 확인 절차가 필요합니다.');});
module.exports=router;
