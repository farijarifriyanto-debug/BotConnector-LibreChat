from __future__ import annotations
import hashlib, json, os, re, shutil, time, uuid, shlex
import jwt
from datetime import timedelta
from pathlib import Path, PurePosixPath
from typing import Any
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig

ROOT=Path("/home/botadmin/botconnector-code-adapter")
STORE=ROOT/"storage"
KEY_FILE=Path("/home/botadmin/botconnector-opensandbox.key")
OSB_DOMAIN=os.getenv("OPENSANDBOX_DOMAIN","127.0.0.1:18088")
IMAGE=os.getenv("BOTCONNECTOR_SANDBOX_IMAGE","botconnector/opensandbox-python-office:1")
TTL=int(os.getenv("BOTCONNECTOR_CODE_ARTIFACT_TTL_SECONDS","86400"))
MAX_BYTES=150*1024*1024
MAX_FILES=64
ALLOWED_EXT={".txt",".md",".csv",".json",".jsonl",".xml",".html",".htm",".png",".jpg",".jpeg",".webp",".gif",".svg",".pdf",".docx",".xlsx",".xls",".pptx",".ppt",".py",".js",".ts",".css",".yaml",".yml",".zip"}

JWT_PUBLIC_KEY_FILE=Path(os.getenv("CODEAPI_JWT_PUBLIC_KEY_FILE","/run/botconnector/codeapi-public.pem"))
JWT_ISSUER=os.getenv("CODEAPI_JWT_ISSUER","librechat")
JWT_AUDIENCE=os.getenv("CODEAPI_JWT_AUDIENCE","codeapi")
JWT_KID=os.getenv("CODEAPI_JWT_KID","botconnector-code-20260924")
JWT_MAX_TTL=int(os.getenv("CODEAPI_JWT_MAX_TTL_SECONDS","300"))
JWT_PUBLIC_KEY=JWT_PUBLIC_KEY_FILE.read_text()

app=FastAPI(title="BotConnector OpenSandbox Code Adapter",version="1.0.0")

class FileRef(BaseModel):
    id:str
    resource_id:str|None=None
    name:str
    storage_session_id:str
    kind:str="user"
    version:int|None=None
    inherited:bool|None=None

class ExecRequest(BaseModel):
    lang:str="bash"
    code:str=Field(min_length=1,max_length=500_000)
    args:list[str]|None=None
    files:list[FileRef]|None=None
    runtime_session_hint:str|None=None

def osb_cfg():
    key=KEY_FILE.read_text().strip()
    return ConnectionConfig(domain=OSB_DOMAIN,protocol="http",api_key=key,use_server_proxy=True,request_timeout=timedelta(seconds=120))

def safe_name(name:str)->str:
    name=name.replace("\\","/").strip()
    if name.startswith("/mnt/data/"): name=name[10:]
    p=PurePosixPath(name)
    if not name or p.is_absolute() or any(x in {"",".",".."} for x in p.parts) or len(name)>240:
        raise HTTPException(400,"unsafe filename")
    return str(p)

def valid_id(v:str)->str:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}",v): raise HTTPException(400,"invalid id")
    return v

def owner_key(tenant_id:str,sub:str)->str:
    return hashlib.sha256((tenant_id+"\0"+sub).encode()).hexdigest()[:32]

def obj_path(owner:str,sid:str,fid:str)->Path:
    return STORE/valid_id(owner)/valid_id(sid)/"objects"/valid_id(fid)

def meta_path(owner:str,sid:str,fid:str)->Path:
    return STORE/valid_id(owner)/valid_id(sid)/"meta"/(valid_id(fid)+".json")

def write_obj(owner:str,sid:str,fid:str,name:str,data:bytes,**extra):
    if len(data)>MAX_BYTES: raise HTTPException(413,"file too large")
    op,mp=obj_path(owner,sid,fid),meta_path(owner,sid,fid)
    op.parent.mkdir(parents=True,exist_ok=True); mp.parent.mkdir(parents=True,exist_ok=True)
    op.write_bytes(data)
    mp.write_text(json.dumps({"file_id":fid,"filename":name,"storage_session_id":sid,"size":len(data),"sha256":hashlib.sha256(data).hexdigest(),"created_at":int(time.time()),**extra},separators=(",",":")))

def read_meta(owner:str,sid:str,fid:str):
    p=meta_path(owner,sid,fid)
    if not p.is_file(): raise HTTPException(404,"file not found")
    return json.loads(p.read_text())

def cleanup():
    STORE.mkdir(parents=True,exist_ok=True); now=time.time()
    for d in list(STORE.iterdir()):
        if not d.is_dir(): continue
        try:
            newest=max((p.stat().st_mtime for p in d.rglob("*") if p.is_file()),default=d.stat().st_mtime)
            if now-newest>TTL: shutil.rmtree(d,ignore_errors=True)
        except FileNotFoundError: pass

async def sandbox_paths(sb:Sandbox):
    r=await sb.commands.run("if [ -d /mnt/data ]; then find /mnt/data -type f -printf '%P\\n' | head -n 65; fi")
    out=[]
    for x in r.logs.stdout:
        for line in getattr(x,"text",str(x)).splitlines():
            if line.strip(): out.append(line.strip())
    if len(out)>MAX_FILES: raise HTTPException(413,"too many generated files")
    return out



@app.middleware("http")
async def require_code_jwt(request:Request,call_next):
    if request.url.path in {"/health","/v1/health"}:
        return await call_next(request)
    auth=request.headers.get("authorization","")
    if not auth.startswith("Bearer "):
        return JSONResponse({"detail":"unauthorized"},status_code=401)
    token=auth[7:].strip()
    try:
        header=jwt.get_unverified_header(token)
        if header.get("kid")!=JWT_KID or header.get("alg")!="EdDSA":
            raise ValueError("unexpected key")
        claims=jwt.decode(token,JWT_PUBLIC_KEY,algorithms=["EdDSA"],
            issuer=JWT_ISSUER,audience=JWT_AUDIENCE,
            options={"require":["exp","iat","nbf","sub","tenant_id","jti"]})
        iat=int(claims["iat"]); exp=int(claims["exp"])
        if exp<=iat or exp-iat>JWT_MAX_TTL: raise ValueError("invalid ttl")
        sub=str(claims["sub"]).strip(); tenant=str(claims["tenant_id"]).strip()
        if not sub or not tenant: raise ValueError("missing principal")
    except Exception:
        return JSONResponse({"detail":"unauthorized"},status_code=401)
    request.state.code_owner=owner_key(tenant,sub)
    return await call_next(request)

@app.get("/health")
@app.get("/v1/health")
async def health():
    return {"status":"UP","sandbox":"opensandbox-gvisor","image":IMAGE,"network":"isolated"}

@app.post("/v1/upload")
async def upload(request:Request,file:UploadFile=File(...),kind:str=Form("user"),id:str=Form("user"),version:int|None=Form(None)):
    cleanup()
    if kind not in {"user","agent","skill"}: raise HTTPException(400,"invalid kind")
    data=await file.read(MAX_BYTES+1)
    if len(data)>MAX_BYTES: raise HTTPException(413,"file too large")
    name=safe_name(file.filename or "upload.bin"); sid=uuid.uuid4().hex; fid=uuid.uuid4().hex
    write_obj(request.state.code_owner,sid,fid,name,data,kind=kind,resource_id=id,version=version)
    return {"message":"success","storage_session_id":sid,"files":[{"fileId":fid,"filename":name}]}

@app.post("/v1/upload/batch")
async def upload_batch(request:Request,file:list[UploadFile]=File(...),kind:str=Form("user"),id:str=Form("user"),version:int|None=Form(None),read_only:bool=Form(False)):
    cleanup()
    if kind not in {"user","agent","skill"}: raise HTTPException(400,"invalid kind")
    sid=uuid.uuid4().hex; rows=[]; ok=bad=0
    for f in file[:MAX_FILES]:
        try:
            data=await f.read(MAX_BYTES+1)
            if len(data)>MAX_BYTES: raise ValueError("file too large")
            name=safe_name(f.filename or "upload.bin"); fid=uuid.uuid4().hex
            write_obj(request.state.code_owner,sid,fid,name,data,kind=kind,resource_id=id,version=version,read_only=bool(read_only))
            rows.append({"status":"success","fileId":fid,"filename":name}); ok+=1
        except Exception as e:
            rows.append({"status":"error","filename":f.filename or "upload.bin","error":str(e)}); bad+=1
    return {"message":"success" if ok else "error","storage_session_id":sid,"files":rows,"succeeded":ok,"failed":bad}

@app.get("/v1/download/{sid}/{fid}")
async def download(sid:str,fid:str,request:Request,kind:str=Query("user"),id:str=Query("")):
    meta=read_meta(request.state.code_owner,sid,fid); p=obj_path(request.state.code_owner,sid,fid)
    if not p.is_file(): raise HTTPException(404,"file not found")
    return FileResponse(p,filename=meta.get("filename",fid),media_type="application/octet-stream")

@app.delete("/v1/files/{sid}/{fid}")
async def delete_file(sid:str,fid:str,request:Request,kind:str=Query("user"),id:str=Query("")):
    obj_path(request.state.code_owner,sid,fid).unlink(missing_ok=True); meta_path(request.state.code_owner,sid,fid).unlink(missing_ok=True)
    return {"message":"success"}

@app.get("/v1/files/{sid}")
async def list_files(sid:str,request:Request,kind:str=Query("user"),id:str=Query("")):
    rows=[]; d=STORE/request.state.code_owner/valid_id(sid)/"meta"
    if d.is_dir():
        for p in sorted(d.glob("*.json")):
            try:
                m=json.loads(p.read_text())
                rows.append({"id":m["file_id"],"name":m["filename"],"storage_session_id":sid})
            except Exception: pass
    return {"session_id":sid,"files":rows}

@app.post("/v1/exec")
async def execute(req:ExecRequest,request:Request):
    cleanup(); owner=request.state.code_owner; exec_sid=uuid.uuid4().hex; out_sid=uuid.uuid4().hex; sb=None
    before={}
    try:
        sb=await Sandbox.create(
            IMAGE,timeout=timedelta(minutes=3),ready_timeout=timedelta(seconds=90),
            resource={"cpu":"1000m","memory":"1Gi"},
            metadata={"name":"librechat-"+exec_sid[:12]},connection_config=osb_cfg())
        await sb.commands.run("mkdir -p /mnt/data")
        for ref in req.files or []:
            name=safe_name(ref.name); src=obj_path(owner,ref.storage_session_id,ref.id)
            if not src.is_file(): raise HTTPException(404,f"input file not found: {name}")
            data=src.read_bytes(); await sb.files.write_file("/mnt/data/"+name,data)
            before[name]=(ref,hashlib.sha256(data).hexdigest())

        lang=req.lang.lower().strip()
        if lang in {"bash","sh","shell"}:
            command=req.code + ((" "+" ".join(shlex.quote(x) for x in req.args)) if req.args else "")
            result=await sb.commands.run(command)
        elif lang in {"python","python3","py"}:
            await sb.files.write_file("/tmp/botconnector_exec.py",req.code.encode())
            result=await sb.commands.run("python3 /tmp/botconnector_exec.py")
        else:
            raise HTTPException(400,f"unsupported language: {req.lang}")

        stdout="\n".join(getattr(x,"text",str(x)).rstrip("\n") for x in result.logs.stdout)
        stderr="\n".join(getattr(x,"text",str(x)).rstrip("\n") for x in result.logs.stderr)
        refs=[]
        for raw_name in await sandbox_paths(sb):
            name=safe_name(raw_name); ext=Path(name).suffix.lower()
            if ext and ext not in ALLOWED_EXT: continue
            data=await sb.files.read_bytes("/mnt/data/"+name)
            if len(data)>MAX_BYTES: continue
            digest=hashlib.sha256(data).hexdigest(); prior=before.get(name)
            if prior and prior[1]==digest:
                old=prior[0]
                refs.append({"id":old.id,"name":name,"storage_session_id":old.storage_session_id,"inherited":True})
                continue
            fid=uuid.uuid4().hex; write_obj(owner,out_sid,fid,name,data,kind="user")
            refs.append({"id":fid,"name":name,"storage_session_id":out_sid})
        return {"session_id":exec_sid,"stdout":stdout,"stderr":stderr,"files":refs}
    finally:
        if sb is not None:
            try: await sb.destroy()
            except Exception: pass

✅ Process 3797596 has finished execution

[executed on device: botadmin (ad252971-0050-474c-bfad-e81361ff2498)]

# LibreChat Programmatic Tool Calling routes are isolated in ptc.py so the
# existing /v1/exec and file API remain byte-for-byte compatible.
from ptc import router as ptc_router
app.include_router(ptc_router)
