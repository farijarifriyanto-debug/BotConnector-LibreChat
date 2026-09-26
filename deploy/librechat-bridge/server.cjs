'use strict';
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { URL, URLSearchParams } = require('node:url');

const HOST='127.0.0.1', PORT=18442;
const ISSUER='https://botconnector.xyz/botconnector-oidc';
const CLIENT_ID='botconnector-librechat';
const REDIRECT_URIS=new Set([
  'https://botconnector.xyz/oauth/openid/callback',
  'https://app.botconnector.id/oauth/openid/callback',
]);
const CENTRAL_LOGIN='https://botconnector.id/app-login/start';
const CENTRAL='http://127.0.0.1:49250';
const GATEWAY='http://127.0.0.1:49260';
const STARTER_POLICY_FILE=process.env.BOTCONNECTOR_STARTER_ROUTE_POLICY_FILE||'/home/botadmin/newbotconnector/production-candidate/artifacts/starter-route-policy.json';
const IMAGE_ROUTER='http://127.0.0.1:18115';
const MEMORY_LOCAL='http://127.0.0.1:47182';
const LOCAL_TRIAL_MODELS=[
  {
    id:'qwen3-0.6b-local-trial',
    baseURL:'http://127.0.0.1:47189',
    exact_model:'Qwen/Qwen3-0.6B',
    display_name:'Qwen3 0.6B',
    publisher:'Qwen',
    quantization:'Q4_0',
    format:'GGUF',
    runtime:'llama.cpp',
    compute_target:'botconnector_local_trial',
    capabilities:['chat','tools'],
    capability_evidence:{chat:'runtime_verified',tools:'experimental'},
    max_input_tokens:3072,
    max_output_tokens:512,
    starterFreeEligible:true,
    owned_by:'botconnector-local-trial',
    container:'botconnector-local-trial-qwen3-0.6b',
  },
  {
    id:'qwen2.5-coder-0.5b-local-trial',
    baseURL:'http://127.0.0.1:47190',
    exact_model:'Qwen/Qwen2.5-Coder-0.5B-Instruct',
    display_name:'Qwen2.5-Coder 0.5B Instruct',
    publisher:'Qwen',
    quantization:'Q4_K_M',
    format:'GGUF',
    runtime:'llama.cpp',
    compute_target:'botconnector_local_trial',
    capabilities:['chat','coding'],
    capability_evidence:{chat:'runtime_verified',coding:'runtime_verified'},
    max_input_tokens:3072,
    max_output_tokens:512,
    starterFreeEligible:true,
    owned_by:'botconnector-local-trial',
    container:'botconnector-local-trial-coder-0.5b',
  },
  {
    id:'smolvlm2-500m-local-trial',
    baseURL:'http://127.0.0.1:47193',
    exact_model:'ggml-org/SmolVLM2-500M-Video-Instruct-GGUF',
    display_name:'SmolVLM2 500M Video Instruct',
    publisher:'Hugging Face / ggml-org',
    quantization:'Q8_0',
    format:'GGUF + mmproj Q8_0',
    runtime:'llama.cpp',
    compute_target:'botconnector_local_trial',
    capabilities:['chat','vision'],
    capability_evidence:{chat:'runtime_verified',vision:'runtime_verified'},
    max_input_tokens:3072,
    max_output_tokens:512,
    starterFreeEligible:true,
    owned_by:'botconnector-local-trial',
    container:'botconnector-local-trial-vision-500m',
  },
];
const LOCAL_TRIAL_BY_ID=new Map(LOCAL_TRIAL_MODELS.map(m=>[m.id,m]));
const CLOUD_MODEL_CAPABILITY_METADATA=new Map([
  ['xkiro:qwen3.7-flash-free',{capabilities:['chat','tools'],capability_evidence:{chat:'runtime_verified',tools:'runtime_verified'}}],
  ['xkiro:minimax-m3-free',{capabilities:['chat'],capability_evidence:{chat:'source_declared'}}],
  ['xkiro:mistral-medium-3.5-free',{capabilities:['chat','tools'],capability_evidence:{chat:'runtime_verified',tools:'runtime_verified'}}],
  ['xkiro:qwen3-coder-plus-free',{capabilities:['chat','coding','tools'],capability_evidence:{chat:'runtime_verified',coding:'source_declared',tools:'runtime_verified'}}],
  ['xkiro:qwen3.8-omni-flash-free',{capabilities:['chat','tools'],capability_evidence:{chat:'runtime_verified',tools:'runtime_verified'}}],
  ['openrouter:stealth/space-bunny-alpha',{capabilities:['chat'],capability_evidence:{chat:'source_declared'}}],
  ['agnes:agnes-3.0-flash',{capabilities:['chat','tools'],capability_evidence:{chat:'runtime_verified',tools:'runtime_verified'}}],
  ['novita:ling-3.0-flash',{capabilities:['chat'],capability_evidence:{chat:'runtime_verified'}}],
  ['novita:mistral-nemo',{capabilities:['chat'],capability_evidence:{chat:'runtime_verified',tools:'unsupported'}}],
  ['novita:nemotron-3-nano-30b-a3b',{capabilities:['chat'],capability_evidence:{chat:'source_declared'}}],
  ['novita:deepseek-v4-flash',{capabilities:['chat','tools'],capability_evidence:{chat:'runtime_verified',tools:'runtime_verified'}}],
  ['novita:tencent-hy3',{capabilities:['chat','tools'],capability_evidence:{chat:'runtime_verified',tools:'experimental'}}],
  ['novita:mimo-v2.5',{capabilities:['chat'],capability_evidence:{chat:'source_declared'}}],
  ['gmi:ling-3.0-flash',{capabilities:['chat'],capability_evidence:{chat:'source_declared'}}],
  ['gmi:glm-5.3-flash',{capabilities:['chat'],capability_evidence:{chat:'source_declared'}}],
]);
const LOCAL_TRIAL_IDLE_MS=5*60*1000;
const localTrialState=new Map(LOCAL_TRIAL_MODELS.map(m=>[m.id,{active:0,lastUsed:0,startPromise:null}]));

function execDocker(args,timeout=30000){
  return new Promise((resolve,reject)=>execFile('/usr/bin/docker',args,{timeout,windowsHide:true},(err,stdout,stderr)=>{
    if(err)return reject(new Error(String(stderr||err.message||'docker failed').trim()));
    resolve(String(stdout||'').trim());
  }));
}
function resourceSnapshot(){
  try{
    const txt=fs.readFileSync('/proc/meminfo','utf8');
    const get=k=>Number((txt.match(new RegExp('^'+k+':\\s+(\\d+)','m'))||[])[1]||0);
    const psi=name=>{
      const p=fs.readFileSync('/proc/pressure/'+name,'utf8').match(/^full .*?avg10=([0-9.]+)/m);
      return p?Number(p[1]):0;
    };
    return {available:get('MemAvailable'),swapUsed:get('SwapTotal')-get('SwapFree'),memFull10:psi('memory'),ioFull10:psi('io')};
  }catch{return {available:0,swapUsed:0,memFull10:100,ioFull10:100}}
}
async function trialRunning(model){
  try{return (await execDocker(['inspect','-f','{{.State.Running}}',model.container],5000))==='true'}catch{return false}
}
async function ensureLocalTrialReady(model){
  const state=localTrialState.get(model.id);
  if(await trialRunning(model)){state.lastUsed=Date.now();return}
  if(state.startPromise)return state.startPromise;
  state.startPromise=(async()=>{
    const mem=resourceSnapshot();
    if(mem.available<4*1024*1024||mem.memFull10>=20||mem.ioFull10>=25||(mem.swapUsed>6*1024*1024&&mem.available<6*1024*1024))throw new Error('LOCAL_TRIAL_RESOURCE_GUARD');
    for(const other of LOCAL_TRIAL_MODELS){
      if(other.id===model.id)continue;
      const otherState=localTrialState.get(other.id);
      if(await trialRunning(other)){
        if(otherState.active>0)throw new Error('LOCAL_TRIAL_BUSY');
        await execDocker(['stop','-t','10',other.container],15000);
      }
    }
    await execDocker(['start',model.container],30000);
    const deadline=Date.now()+60000;
    while(Date.now()<deadline){
      try{
        const r=await fetch(model.baseURL+'/health',{signal:AbortSignal.timeout(2000)});
        if(r.ok){state.lastUsed=Date.now();return}
      }catch{}
      await new Promise(r=>setTimeout(r,1000));
    }
    throw new Error('LOCAL_TRIAL_START_TIMEOUT');
  })().finally(()=>{state.startPromise=null});
  return state.startPromise;
}
function acquireLocalTrial(model){
  const state=localTrialState.get(model.id);state.active++;state.lastUsed=Date.now();
  let released=false;
  return ()=>{
    if(released)return;
    released=true;
    state.active=Math.max(0,state.active-1);
    state.lastUsed=Date.now();
  };
}
setInterval(async()=>{
  for(const model of LOCAL_TRIAL_MODELS){
    const state=localTrialState.get(model.id);
    if(state.active!==0)continue;
    const running=await trialRunning(model);
    if(!running){state.lastUsed=0;continue}
    if(state.lastUsed===0){state.lastUsed=Date.now();continue}
    if(Date.now()-state.lastUsed>=LOCAL_TRIAL_IDLE_MS){
      try{await execDocker(['stop','-t','10',model.container],15000)}catch{}
      state.lastUsed=0;
    }
  }
},30000).unref();
const STATE_DIR='/home/botadmin/.local/state/botconnector-librechat-bridge';
const APP_TOKEN_FILE='/home/botadmin/newbotconnector/production-candidate/secrets/app_auth_internal_token';
const BFF_SECRET_FILE='/home/botadmin/newbotconnector/production-candidate/secrets/web_bff_secret';
const CLIENT_SECRET=fs.readFileSync(STATE_DIR+'/oidc-client-secret','utf8').trim();
const PRIVATE_KEY=fs.readFileSync(STATE_DIR+'/oidc-private.pem','utf8');
const PUBLIC_KEY=fs.readFileSync(STATE_DIR+'/oidc-public.pem','utf8');
const APP_TOKEN=fs.readFileSync(APP_TOKEN_FILE,'utf8').trim();
const BFF_SECRET=fs.readFileSync(BFF_SECRET_FILE,'utf8').trim();
const SESSION_FILE=STATE_DIR+'/sessions.json';
const authTx=new Map(), oidcCodes=new Map(), accessTokens=new Map();

function b64u(v){return Buffer.from(v).toString('base64url')}
function json(res,status,obj,headers={}){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers});res.end(JSON.stringify(obj))}
function redirect(res,url){res.writeHead(303,{location:url,'cache-control':'no-store'});res.end()}
function parseForm(body){return Object.fromEntries(new URLSearchParams(body))}
function readBody(req,limit=1024*1024){return new Promise((resolve,reject)=>{let n=0,b=[];req.on('data',c=>{n+=c.length;if(n>limit){reject(new Error('too large'));req.destroy();return}b.push(c)});req.on('end',()=>resolve(Buffer.concat(b).toString()));req.on('error',reject)})}

// Some OpenAI-compatible providers stream a tool call in two phases: the first
// delta contains id/name with arguments="", and later deltas contain only the
// argument fragments. LibreChat's custom-endpoint agent path can persist the
// first empty value and lose the later fragments. Coalesce only tool-call
// deltas at the BotConnector boundary while leaving normal text streaming live.
function pipeNormalizedOpenAIToolStream(up,res){
  let buffer='';
  const pending=new Map(); // choice index -> tool index -> accumulated call
  const roleSeen=new Set();
  let lastEnvelope={};
  const emit=(obj)=>res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const pendingFor=(choiceIndex)=>{
    let tools=pending.get(choiceIndex);
    if(!tools){tools=new Map();pending.set(choiceIndex,tools)}
    return tools;
  };
  const accumulate=(choiceIndex,toolCall)=>{
    const toolIndex=Number.isInteger(toolCall?.index)?toolCall.index:0;
    const tools=pendingFor(choiceIndex);
    const prev=tools.get(toolIndex)||{index:toolIndex,id:'',type:'function',function:{name:'',arguments:''}};
    if(toolCall?.id)prev.id=toolCall.id;
    if(toolCall?.type)prev.type=toolCall.type;
    if(toolCall?.function?.name)prev.function.name+=toolCall.function.name;
    if(typeof toolCall?.function?.arguments==='string')prev.function.arguments+=toolCall.function.arguments;
    tools.set(toolIndex,prev);
  };
  const flush=(choiceIndex,envelope={},finishReason=null)=>{
    const tools=pending.get(choiceIndex);
    if(!tools||tools.size===0)return false;
    const tool_calls=[...tools.values()].sort((a,b)=>a.index-b.index);
    const base={...lastEnvelope,...envelope};
    delete base.choices;
    emit({...base,choices:[{index:choiceIndex,delta:{tool_calls},finish_reason:finishReason}]});
    pending.delete(choiceIndex);
    return true;
  };
  const flushAll=()=>{for(const choiceIndex of [...pending.keys()])flush(choiceIndex,lastEnvelope)};
  const handlePayload=(payload)=>{
    if(payload==='[DONE]'){flushAll();res.write('data: [DONE]\n\n');return}
    let obj;
    try{obj=JSON.parse(payload)}catch{res.write(`data: ${payload}\n\n`);return}
    lastEnvelope={...obj};delete lastEnvelope.choices;
    const choices=Array.isArray(obj.choices)?obj.choices:[];
    if(choices.length===0){emit(obj);return}
    const passthrough=[];
    for(const choice of choices){
      const choiceIndex=Number.isInteger(choice?.index)?choice.index:0;
      const delta=choice?.delta&&typeof choice.delta==='object'?{...choice.delta}:{};
      // OpenAI-compatible clients determine the message chunk class from the
      // first delta role. Some routed providers emit text before the later
      // role=assistant chunk, which makes LangChain accumulate a generic
      // ChatMessageChunk and breaks subsequent tool-result replay. Canonicalize
      // the first delta for each choice to assistant at the bridge boundary.
      if(typeof delta.role==='string'&&delta.role.length>0)roleSeen.add(choiceIndex);
      else if(!roleSeen.has(choiceIndex)){delta.role='assistant';roleSeen.add(choiceIndex)}
      const calls=Array.isArray(delta.tool_calls)?delta.tool_calls:null;
      if(calls){for(const call of calls)accumulate(choiceIndex,call);delete delta.tool_calls}
      // Keep OpenAI's terminal tool-call signal on the SAME normalized chunk
      // as the complete calls. LibreChat's eager ToolNode path keys off that
      // co-location; forwarding a second empty finish chunk can end the graph.
      if(choice?.finish_reason==='tool_calls'){
        const flushed=flush(choiceIndex,obj,'tool_calls');
        if(flushed)continue;
      }
      const hasDelta=Object.keys(delta).some(k=>delta[k]!==null&&delta[k]!==undefined);
      if(hasDelta||choice?.finish_reason!=null||!calls){passthrough.push({...choice,delta})}
    }
    if(passthrough.length)emit({...obj,choices:passthrough});
  };
  const handleEvent=(event)=>{
    const lines=event.split(/\r?\n/);
    const dataLines=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart());
    if(dataLines.length===0){if(event.trim())res.write(event+'\n\n');return}
    handlePayload(dataLines.join('\n'));
  };
  up.setEncoding('utf8');
  up.on('data',chunk=>{
    buffer+=chunk;
    while(true){
      const m=buffer.match(/\r?\n\r?\n/);
      if(!m||m.index==null)break;
      const event=buffer.slice(0,m.index);
      buffer=buffer.slice(m.index+m[0].length);
      handleEvent(event);
    }
  });
  up.on('end',()=>{if(buffer.trim())handleEvent(buffer);flushAll();res.end()});
  up.on('error',()=>res.destroy());
}
function safeEq(a,b){a=Buffer.from(String(a||''));b=Buffer.from(String(b||''));return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function validUuid(x){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(x||''))}
function loadSessions(){try{return JSON.parse(fs.readFileSync(SESSION_FILE,'utf8'))}catch{return {}}}
function saveSessions(x){const t=SESSION_FILE+'.tmp';fs.writeFileSync(t,JSON.stringify(x),{mode:0o600});fs.renameSync(t,SESSION_FILE)}
function storeSession(userId,sessionToken,expiresAt,email,name){const s=loadSessions();s[userId]={session_token:sessionToken,expires_at:expiresAt,email:email||'',name:name||''};saveSessions(s)}
function getSession(userId){const s=loadSessions()[userId];if(!s||!s.session_token||Number(s.expires_at)<=Math.floor(Date.now()/1000))return null;return s}
function removeSession(userId){const s=loadSessions();const previous=s[userId]||null;if(Object.prototype.hasOwnProperty.call(s,userId)){delete s[userId];saveSessions(s)}return previous}
function verifyIdToken(token){
  try{
    const parts=String(token||'').split('.');if(parts.length!==3)return null;
    const header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
    if(header.alg!=='RS256'||header.kid!=='bc-lc-1')return null;
    const input=Buffer.from(parts[0]+'.'+parts[1]);
    const signature=Buffer.from(parts[2],'base64url');
    if(!crypto.verify('RSA-SHA256',input,PUBLIC_KEY,signature))return null;
    const audOk=claims.aud===CLIENT_ID||(Array.isArray(claims.aud)&&claims.aud.includes(CLIENT_ID));
    if(claims.iss!==ISSUER||!audOk||!validUuid(claims.sub)||!Number.isFinite(claims.exp)||claims.exp<=Math.floor(Date.now()/1000))return null;
    return claims;
  }catch{return null}
}
function prune(map){const now=Date.now();for(const [k,v] of map)if(v.expiresAt<=now)map.delete(k)}
setInterval(()=>{prune(authTx);prune(oidcCodes);prune(accessTokens)},60000).unref();

function jwk(){const j=crypto.createPublicKey(PUBLIC_KEY).export({format:'jwk'});return {kty:j.kty,n:j.n,e:j.e,use:'sig',alg:'RS256',kid:'bc-lc-1'}}
function signJwt(claims){const h=b64u(JSON.stringify({alg:'RS256',typ:'JWT',kid:'bc-lc-1'}));const p=b64u(JSON.stringify(claims));const input=h+'.'+p;const sig=crypto.sign('RSA-SHA256',Buffer.from(input),PRIVATE_KEY).toString('base64url');return input+'.'+sig}
async function centralPost(path,body){const r=await fetch(CENTRAL+path,{method:'POST',headers:{'content-type':'application/json','x-botconnector-app-internal-token':APP_TOKEN},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});const txt=await r.text();let data={};try{data=JSON.parse(txt)}catch{}if(!r.ok)throw Object.assign(new Error('central rejected'),{status:r.status,data});return data}
function validateClientSecret(req,form){let supplied=form.client_secret||'';const a=req.headers.authorization||'';if(a.startsWith('Basic ')){try{const [id,sec]=Buffer.from(a.slice(6),'base64').toString().split(':');if(id===CLIENT_ID)supplied=sec}catch{}}return safeEq(supplied,CLIENT_SECRET)}
function pkceOk(tx,verifier){if(!tx.code_challenge)return true;if(tx.code_challenge_method!=='S256'||!verifier)return false;return safeEq(crypto.createHash('sha256').update(verifier).digest('base64url'),tx.code_challenge)}

let modelRegistryCache={expiresAt:0,models:[]};
function starterEligibilityMap(){
  try{
    const policy=JSON.parse(fs.readFileSync(STARTER_POLICY_FILE,'utf8'));
    const routes=Array.isArray(policy.routes)?policy.routes:[];
    return new Map(routes.map(route=>[String(route.canonicalModelId||''),route.starterFreeEligible===true]));
  }catch{return new Map();}
}
async function getGatewayModels(){
  if(modelRegistryCache.expiresAt>Date.now()&&modelRegistryCache.models.length)return modelRegistryCache.models;
  const r=await fetch(GATEWAY+'/v1/models',{signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw new Error('model registry unavailable');
  const x=await r.json();
  const eligibility=starterEligibilityMap();
  const models=(Array.isArray(x.data)?x.data:[]).map(model=>({
    ...model,
    starterFreeEligible:eligibility.get(String(model.id||''))===true,
  }));
  modelRegistryCache={expiresAt:Date.now()+30000,models};
  return models;
}
function starterAlias(id){
  let x=String(id||'');
  if(x.includes(':'))x=x.slice(x.indexOf(':')+1);
  return x.endsWith('-free')?x.slice(0,-5):x;
}
function libreChatModelMetadata(model,idOverride){
  const rawContext=Number(model&&model.max_input_tokens);
  const contextLength=Number.isFinite(rawContext)&&rawContext>0?Math.floor(rawContext):32000;
  const {baseURL,...publicModel}=model||{};
  const capabilityMetadata=CLOUD_MODEL_CAPABILITY_METADATA.get(String(model&&model.id||''));
  return {
    ...publicModel,
    ...(capabilityMetadata||{}),
    ...(idOverride?{id:idOverride}:{}),
    context_length:contextLength,
    // BotConnector owns provider pricing/billing. LibreChat needs numeric rates
    // to build its token-config cache, but must not double-charge users.
    pricing:{prompt:'0',completion:'0'},
  };
}
async function getBridgeModels(){
  const gatewayModels=await getGatewayModels();
  return [...gatewayModels,...LOCAL_TRIAL_MODELS];
}
function starterMaps(models){
  const eligible=models.filter(m=>m&&m.starterFreeEligible===true);
  const free=[],aliasToCanonical=new Map(),canonicalToAlias=new Map();
  for(const m of eligible){
    const alias=starterAlias(m.id);
    // BotConnector exposes one model identity to users. Provider duplicates stay internal.
    if(aliasToCanonical.has(alias))continue;
    aliasToCanonical.set(alias,m.id);
    canonicalToAlias.set(m.id,alias);
    free.push(m);
  }
  return {free,aliasToCanonical,canonicalToAlias};
}
async function resolvePlanForBridge(userId){
  if(!validUuid(userId))return {plan:'starter',session:null};
  const session=getSession(userId);
  if(!session)return {plan:'starter',session:null};
  try{
    const ctx=await centralPost('/v1/app-auth/session/resolve',{session_token:session.session_token});
    return {plan:['starter','pro','team'].includes(ctx.plan)?ctx.plan:'starter',session,ctx};
  }catch{return {plan:'starter',session:null};}
}
async function proxyGateway(req,res,url){
 const isHealth=url.pathname==='/api/botconnector/health';
 const isModels=url.pathname==='/v1/models';
 const userId=req.headers['x-botconnector-user-id'];
 if(isHealth){
   const target=new URL(url.pathname+url.search,GATEWAY);
   const up=http.request({hostname:target.hostname,port:target.port,path:target.pathname+target.search,method:req.method,headers:{}},u=>{res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});
   up.on('error',()=>json(res,502,{error:{code:'GATEWAY_UNAVAILABLE',message:'BotConnector gateway unavailable.'}}));req.pipe(up);return;
 }
 const auth=await resolvePlanForBridge(userId);
 const plan=auth.plan;
 if(isModels){
   try{
     const models=await getBridgeModels();
     if(plan==='starter'){
       const {free,canonicalToAlias}=starterMaps(models);
       return json(res,200,{object:'list',data:free.map(m=>libreChatModelMetadata({...m,owned_by:m.owned_by||'botconnector'},canonicalToAlias.get(m.id)))});
     }
     return json(res,200,{object:'list',data:models.map(m=>libreChatModelMetadata(m))});
   }catch{return json(res,502,{error:{code:'MODEL_REGISTRY_UNAVAILABLE',message:'BotConnector model registry unavailable.'}});}
 }
 if(!validUuid(userId))return json(res,401,{error:{code:'BOTCONNECTOR_LOGIN_REQUIRED',message:'Sign in with BotConnector is required.'}});
 if(!auth.session)return json(res,401,{error:{code:'BOTCONNECTOR_SESSION_REQUIRED',message:'BotConnector session is missing or expired. Sign in again.'}});
 const targetBase=url.pathname.startsWith('/v1/images/')?IMAGE_ROUTER:GATEWAY;
 const target=new URL(url.pathname+url.search,targetBase);
 const headers={};
 for(const [k,v] of Object.entries(req.headers)){const l=k.toLowerCase();if(['host','connection','content-length','authorization','x-botconnector-internal-auth','x-botconnector-request-id','x-botconnector-web-plan','x-botconnector-privacy-mode','x-botconnector-privacy-confirmed','x-botconnector-privacy-intent'].includes(l))continue;headers[k]=v}
 headers['x-botconnector-internal-auth']=BFF_SECRET;headers['x-botconnector-user-id']=userId;headers['x-botconnector-request-id']=crypto.randomUUID();headers['x-botconnector-web-plan']=plan;headers['x-botconnector-privacy-mode']='balanced';

 if(url.pathname==='/v1/chat/completions'&&req.method==='POST'){
   let raw,body;
   try{raw=await readBody(req,25*1024*1024)}catch{return json(res,413,{error:{code:'REQUEST_TOO_LARGE',message:'Request too large.'}})}
   try{body=JSON.parse(raw)}catch{return json(res,400,{error:{code:'INVALID_JSON',message:'Invalid JSON body.'}})}
   if(String(body.model||'')==='qwen-memory-local'){
     const localTarget=new URL(url.pathname+url.search,MEMORY_LOCAL);
     const localHeaders={'content-type':'application/json','content-length':Buffer.byteLength(raw)};
     const up=http.request({hostname:localTarget.hostname,port:localTarget.port,path:localTarget.pathname+localTarget.search,method:req.method,headers:localHeaders},u=>{
       res.writeHead(u.statusCode||502,u.headers);u.pipe(res);
     });
     up.on('error',()=>json(res,502,{error:{code:'LOCAL_MEMORY_UNAVAILABLE',message:'Local memory model unavailable.'}}));
     up.end(raw);return;
   }
   const localTrial=LOCAL_TRIAL_BY_ID.get(String(body.model||''));
   if(localTrial){
     try{await ensureLocalTrialReady(localTrial)}
     catch(e){
       const code=String(e.message||'LOCAL_TRIAL_UNAVAILABLE');
       return json(res,503,{error:{code,message:code==='LOCAL_TRIAL_BUSY'?'Another Local Trial model is currently serving a request.':'BotConnector Local Trial is temporarily unavailable because the host resource guard is active.'}});
     }
     const releaseLocalTrial=acquireLocalTrial(localTrial);
     const localTarget=new URL(url.pathname+url.search,localTrial.baseURL);
     const localHeaders={'content-type':'application/json','content-length':Buffer.byteLength(raw)};
     const normalizeLocalToolStream=body.stream===true&&Array.isArray(body.tools)&&body.tools.length>0;
     const up=http.request({hostname:localTarget.hostname,port:localTarget.port,path:localTarget.pathname+localTarget.search,method:req.method,headers:localHeaders},u=>{
       u.once('end',releaseLocalTrial);u.once('close',releaseLocalTrial);
       const contentType=String(u.headers['content-type']||'');
       if(normalizeLocalToolStream&&(u.statusCode||500)<400&&contentType.includes('text/event-stream')){
         const outHeaders={...u.headers};delete outHeaders['content-length'];
         res.writeHead(u.statusCode||200,outHeaders);
         pipeNormalizedOpenAIToolStream(u,res);
         return;
       }
       res.writeHead(u.statusCode||502,u.headers);u.pipe(res);
     });
     up.on('error',()=>{releaseLocalTrial();json(res,502,{error:{code:'LOCAL_TRIAL_UNAVAILABLE',message:'BotConnector Local Trial model unavailable.'}})});
     up.end(raw);return;
   }
   if(plan==='starter'){
     const models=await getBridgeModels();
     const {free,aliasToCanonical}=starterMaps(models);
     const freeIds=new Set(free.map(m=>m.id));
     const requested=String(body.model||'');
     const canonical=aliasToCanonical.get(requested)||requested;
     if(!freeIds.has(canonical))return json(res,403,{error:{code:'STARTER_FREE_MODEL_ONLY',message:'Starter can use available Free Cloud and BotConnector Local Trial models only.'}});
     body.model=canonical;raw=JSON.stringify(body);
   }
   const normalizeToolStream=body.stream===true&&Array.isArray(body.tools)&&body.tools.length>0;
   headers['content-length']=Buffer.byteLength(raw);
   const up=http.request({hostname:target.hostname,port:target.port,path:target.pathname+target.search,method:req.method,headers},u=>{
     const contentType=String(u.headers['content-type']||'');
     if(normalizeToolStream&&(u.statusCode||500)<400&&contentType.includes('text/event-stream')){
       const outHeaders={...u.headers};delete outHeaders['content-length'];
       res.writeHead(u.statusCode||200,outHeaders);
       pipeNormalizedOpenAIToolStream(u,res);
       return;
     }
     res.writeHead(u.statusCode||502,u.headers);u.pipe(res);
   });
   up.on('error',()=>json(res,502,{error:{code:'GATEWAY_UNAVAILABLE',message:'BotConnector gateway unavailable.'}}));up.end(raw);return;
 }
 const up=http.request({hostname:target.hostname,port:target.port,path:target.pathname+target.search,method:req.method,headers},u=>{res.writeHead(u.statusCode||502,u.headers);u.pipe(res)});
 up.on('error',()=>json(res,502,{error:{code:'GATEWAY_UNAVAILABLE',message:'BotConnector gateway unavailable.'}}));req.pipe(up);
}

const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://'+HOST+':'+PORT);
  if(url.pathname==='/health')return json(res,200,{ok:true,service:'botconnector-librechat-bridge'});
  if(url.pathname==='/.well-known/openid-configuration')return json(res,200,{issuer:ISSUER,authorization_endpoint:ISSUER+'/authorize',token_endpoint:ISSUER+'/token',userinfo_endpoint:ISSUER+'/userinfo',jwks_uri:ISSUER+'/jwks',end_session_endpoint:ISSUER+'/logout',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],scopes_supported:['openid','profile','email'],token_endpoint_auth_methods_supported:['client_secret_basic','client_secret_post'],claims_supported:['sub','iss','aud','exp','iat','nonce','email','email_verified','name','preferred_username']});
  if(url.pathname==='/jwks')return json(res,200,{keys:[jwk()]});
  if(url.pathname==='/logout'&&req.method==='GET'){
    const claims=verifyIdToken(url.searchParams.get('id_token_hint'));
    if(!claims)return json(res,400,{error:'invalid_logout_request'});
    const previous=removeSession(claims.sub);
    for(const [token,value] of accessTokens){if(value.userId===claims.sub)accessTokens.delete(token)}
    for(const [code,value] of oidcCodes){if(value.userId===claims.sub)oidcCodes.delete(code)}
    if(previous?.session_token){try{await centralPost('/v1/app-auth/session/revoke',{session_token:previous.session_token})}catch{}}
    const requested=url.searchParams.get('post_logout_redirect_uri');
    const allowed=new Set(['https://botconnector.id/','https://app.botconnector.id/login']);
    return redirect(res,allowed.has(requested)?requested:'https://botconnector.id/');
  }
  if(url.pathname==='/authorize'&&req.method==='GET'){
    const q=Object.fromEntries(url.searchParams);
    if(q.client_id!==CLIENT_ID||!REDIRECT_URIS.has(q.redirect_uri)||q.response_type!=='code'||!String(q.scope||'').split(/\s+/).includes('openid')||!q.state)return json(res,400,{error:'invalid_request'});
    const state=crypto.randomBytes(32).toString('base64url');authTx.set(state,{...q,expiresAt:Date.now()+10*60*1000});
    const c=new URL(CENTRAL_LOGIN);c.searchParams.set('client_id',CLIENT_ID);c.searchParams.set('state',state);return redirect(res,c.toString());
  }
  if(url.pathname==='/central-callback'&&req.method==='GET'){
    const state=url.searchParams.get('state'),code=url.searchParams.get('code'),tx=authTx.get(state);authTx.delete(state);if(!tx||!code)return json(res,400,{error:'invalid_state'});
    const ex=await centralPost('/v1/app-auth/exchange',{code,state,client_id:CLIENT_ID});const uid=String(ex.user_id||'');if(!validUuid(uid)||!ex.session_token)throw new Error('invalid exchange');
    const ctx=await centralPost('/v1/app-auth/session/resolve',{session_token:ex.session_token});storeSession(uid,ex.session_token,Number(ex.expires_at||0),ctx.email,ctx.display_name);const oc=crypto.randomBytes(48).toString('base64url');
    oidcCodes.set(oc,{userId:uid,nonce:tx.nonce||'',redirect_uri:tx.redirect_uri,code_challenge:tx.code_challenge||'',code_challenge_method:tx.code_challenge_method||'',expiresAt:Date.now()+2*60*1000});
    const cb=new URL(tx.redirect_uri);cb.searchParams.set('code',oc);cb.searchParams.set('state',tx.state);return redirect(res,cb.toString());
  }
  if(url.pathname==='/token'&&req.method==='POST'){
    const form=parseForm(await readBody(req));if(form.grant_type!=='authorization_code'||!validateClientSecret(req,form))return json(res,401,{error:'invalid_client'});
    const tx=oidcCodes.get(form.code);oidcCodes.delete(form.code);if(!tx||tx.redirect_uri!==form.redirect_uri||!pkceOk(tx,form.code_verifier))return json(res,400,{error:'invalid_grant'});
    const now=Math.floor(Date.now()/1000),at=crypto.randomBytes(32).toString('base64url');accessTokens.set(at,{userId:tx.userId,expiresAt:Date.now()+3600*1000});
    const sess=getSession(tx.userId)||{};const email=sess.email||tx.userId+'@accounts.botconnector.internal';const name=sess.name||email.split('@')[0];const claims={iss:ISSUER,sub:tx.userId,aud:CLIENT_ID,iat:now,exp:now+3600,email,email_verified:true,name,preferred_username:email};if(tx.nonce)claims.nonce=tx.nonce;
    return json(res,200,{access_token:at,token_type:'Bearer',expires_in:3600,id_token:signJwt(claims),scope:'openid profile email'});
  }
  if(url.pathname==='/userinfo'&&req.method==='GET'){
    const a=String(req.headers.authorization||''),tok=a.startsWith('Bearer ')?a.slice(7):'',x=accessTokens.get(tok);if(!x||x.expiresAt<=Date.now())return json(res,401,{error:'invalid_token'});
    const sess=getSession(x.userId)||{};const email=sess.email||x.userId+'@accounts.botconnector.internal';const name=sess.name||email.split('@')[0];return json(res,200,{sub:x.userId,email,email_verified:true,name,preferred_username:email});
  }
  if(url.pathname.startsWith('/v1/')||url.pathname.startsWith('/api/botconnector/'))return proxyGateway(req,res,url);
  return json(res,404,{error:'not_found'});
 }catch(e){return json(res,500,{error:'bridge_error'});}
});
server.listen(PORT,HOST,()=>console.log('BotConnector LibreChat bridge listening on '+HOST+':'+PORT));
