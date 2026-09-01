// Проверка auth-ядра без БД и сети: node scripts/check-auth-core.js (или npm run check).
// Падает с AssertionError, если сломана логика режимов log/enforce, ролей или владельца.
const assert = require("assert");
process.env.JWT_SECRET='s1'; process.env.JWT_REFRESH_SECRET='s2';
const auth = require('../lib/auth');
const jwt = require('jsonwebtoken');
function mkReq(token, extra={}){ return { headers: token?{authorization:'Bearer '+token}:{}, method:'GET', baseUrl:'', path:'/user/orders', ip:'1.2.3.4', query:{}, ...extra }; }
function mkRes(){ const r={code:null,body:null,headersSent:false, status(c){r.code=c;return r;}, json(b){r.body=b;r.headersSent=true;return r;}}; return r; }
const row = {id:7,name:'Иван',l_name:'Иванов',email:'i@i.ru',phone:'+7',loyalty_id:'1234 5678',code:'4321',password:'x',voipToken:'t',socketId:'s',access:0,role:null,date:'2025-01-01'};
const userTok = auth.signUserToken(row);
const pl = jwt.verify(userTok,'s1');
assert(pl.code===undefined && pl.voipToken===undefined && pl.password===undefined, 'secrets leaked');
assert(pl.role==='user' && pl.scope==='user' && pl.name==='Иван', 'payload fields');
const legacy = jwt.sign(row, 's1', {expiresIn:'30d'}); // старый токен = вся строка
const staffTok = auth.signStaffToken({id:3,email:'a@b'});
const agentTok = auth.signAgentToken({...row, role:'agent'});
const refresh = auth.signRefreshToken(7,'user');
assert(auth.verifyAccessToken(refresh)===null, 'refresh must not pass as access');
assert(auth.verifyRefreshToken(refresh).id===7, 'refresh verify');
assert(auth.verifyAccessToken('garbage')===null);

function run(mode, mw, token){ process.env.AUTH_MODE=mode; const req=mkReq(token), res=mkRes(); let nexted=false; mw(req,res,()=>{nexted=true;}); return {req,res,nexted}; }
const userMw = auth.requireAuth(['user']); const staffMw = auth.requireAuth(['staff']); const strictUser = auth.requireAuth(['user'],{strict:true});
// log mode
let r=run('log',userMw,null); assert(r.nexted && r.req.auth===null, 'log: missing passes');
r=run('log',userMw,'bad'); assert(r.nexted, 'log: invalid passes');
r=run('log',userMw,userTok); assert(r.nexted && r.req.auth.id===7 && r.req.authUser.id===7, 'log: valid user');
r=run('log',userMw,legacy); assert(r.nexted && r.req.auth.role==='user', 'legacy token accepted');
r=run('log',staffMw,userTok); assert(r.nexted && r.req.auth.role==='user', 'log: forbidden passes with identity');
r=run('log',strictUser,null); assert(!r.nexted && r.res.code===401, 'strict enforces in log');
// enforce
r=run('enforce',userMw,null); assert(!r.nexted && r.res.code===401, 'enforce missing');
r=run('enforce',userMw,'bad'); assert(r.res.code===401, 'enforce invalid');
r=run('enforce',staffMw,userTok); assert(r.res.code===403, 'enforce forbidden');
r=run('enforce',staffMw,staffTok); assert(r.nexted && r.req.authStaff.id===3 && r.req.auth.role==='staff', 'enforce staff ok');
r=run('enforce',userMw,agentTok); assert(r.nexted && r.req.auth.role==='agent', 'agent satisfies user');
r=run('enforce',auth.requireAuth(['agent']),userTok); assert(r.res.code===403, 'user is not agent');
// log-only path override
process.env.AUTH_LOG_ONLY_PATHS='/user/orders,/orders';
r=run('enforce',userMw,null); assert(r.nexted, 'log-only path passes in enforce');
process.env.AUTH_LOG_ONLY_PATHS='';
// owner resolution
process.env.AUTH_MODE='enforce';
let req=mkReq(userTok); userMw(req,mkRes(),()=>{}); let res=mkRes();
assert(auth.resolveOwnerId(req,res,'7')===7, 'own id'); assert(auth.resolveOwnerId(req,res,undefined)===7, 'no id -> token');
res=mkRes(); assert(auth.resolveOwnerId(req,res,'8')===null && res.code===403, 'foreign id -> 403');
res=mkRes(); assert(auth.assertOrderOwner(req,res,8)===false && res.code===403, 'order owner mismatch');
assert(auth.assertOrderOwner(req,mkRes(),null)===true, 'guest order ok');
let sreq=mkReq(staffTok); staffMw(sreq,mkRes(),()=>{}); assert(auth.resolveOwnerId(sreq,mkRes(),'99')==='99', 'staff any id');
process.env.AUTH_MODE='log'; res=mkRes(); assert(auth.resolveOwnerId(req,res,'8')==='8' && res.code===null, 'log mode mismatch passes');
let greq=mkReq(null); userMw(greq,mkRes(),()=>{}); assert(auth.resolveOwnerId(greq,mkRes(),'5')==='5', 'no auth log mode -> requested');
console.log('ALL AUTH CORE CHECKS PASSED');
