from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shlex
import time
import uuid
from datetime import timedelta
from pathlib import Path, PurePosixPath
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig
from opensandbox.services.command import RunCommandOpts

router = APIRouter()

ROOT = Path("/home/botadmin/botconnector-code-adapter")
STORE = ROOT / "storage"
STATE_DIR = STORE / ".ptc-state"
KEY_FILE = Path("/home/botadmin/botconnector-opensandbox.key")
OSB_DOMAIN = os.getenv("OPENSANDBOX_DOMAIN", "127.0.0.1:18088")
IMAGE = os.getenv("BOTCONNECTOR_SANDBOX_IMAGE", "botconnector/opensandbox-python-office:1")
MAX_BYTES = 150 * 1024 * 1024
MAX_FILES = 64
MAX_ROUNDS = int(os.getenv("BOTCONNECTOR_PTC_MAX_ROUNDS", "20"))
MAX_TIMEOUT_MS = int(os.getenv("BOTCONNECTOR_PTC_MAX_TIMEOUT_MS", "300000"))
DEFAULT_TIMEOUT_MS = int(os.getenv("BOTCONNECTOR_PTC_DEFAULT_TIMEOUT_MS", "60000"))
EVENT_LIMIT = int(os.getenv("BOTCONNECTOR_PTC_EVENT_LIMIT_BYTES", str(4 * 1024 * 1024)))
DELIMITER = "\n---PTC_END---\n"
TOKEN_RE = re.compile(r"^[a-f0-9]{32}$")
VENDOR_DIR = Path(__file__).with_name("vendor")

ALLOWED_EXT = {
    ".txt", ".md", ".csv", ".json", ".jsonl", ".xml", ".html", ".htm",
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".pdf", ".docx",
    ".xlsx", ".xls", ".pptx", ".ppt", ".py", ".js", ".ts", ".css",
    ".yaml", ".yml", ".zip",
}


class FileRef(BaseModel):
    id: str
    resource_id: str | None = None
    name: str
    storage_session_id: str
    kind: str = "user"
    version: int | None = None


class ToolDef(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    description: str | None = None
    parameters: dict[str, Any] | None = None


class ToolResult(BaseModel):
    call_id: str
    result: Any = None
    is_error: bool = False
    error_message: str | None = None


class ProgrammaticRequest(BaseModel):
    code: str | None = Field(default=None, max_length=500_000)
    tools: list[ToolDef] | None = None
    session_id: str | None = None
    timeout: int | None = None
    files: list[FileRef] | None = None
    continuation_token: str | None = None
    tool_results: list[ToolResult] | None = None
    language: str | None = None
    lang: str | None = None
    runtime_session_hint: str | None = None


def osb_cfg() -> ConnectionConfig:
    key = KEY_FILE.read_text().strip()
    return ConnectionConfig(
        domain=OSB_DOMAIN,
        protocol="http",
        api_key=key,
        use_server_proxy=True,
        request_timeout=timedelta(seconds=120),
    )


def safe_name(name: str) -> str:
    name = name.replace("\\", "/").strip()
    if name.startswith("/mnt/data/"):
        name = name[10:]
    p = PurePosixPath(name)
    if (
        not name
        or p.is_absolute()
        or any(x in {"", ".", ".."} for x in p.parts)
        or len(name) > 240
    ):
        raise HTTPException(400, "unsafe filename")
    return str(p)


def valid_id(v: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", v):
        raise HTTPException(400, "invalid id")
    return v


def obj_path(owner: str, sid: str, fid: str) -> Path:
    return STORE / valid_id(owner) / valid_id(sid) / "objects" / valid_id(fid)


def meta_path(owner: str, sid: str, fid: str) -> Path:
    return STORE / valid_id(owner) / valid_id(sid) / "meta" / (valid_id(fid) + ".json")


def write_obj(owner: str, sid: str, fid: str, name: str, data: bytes, **extra: Any) -> None:
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "file too large")
    op, mp = obj_path(owner, sid, fid), meta_path(owner, sid, fid)
    op.parent.mkdir(parents=True, exist_ok=True)
    mp.parent.mkdir(parents=True, exist_ok=True)
    op.write_bytes(data)
    mp.write_text(
        json.dumps(
            {
                "file_id": fid,
                "filename": name,
                "storage_session_id": sid,
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "created_at": int(time.time()),
                **extra,
            },
            separators=(",", ":"),
        )
    )


def _state_path(token: str, suffix: str = ".json") -> Path:
    if not TOKEN_RE.fullmatch(token):
        raise HTTPException(400, "invalid continuation token")
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    return STATE_DIR / f"{token}{suffix}"


def _save_state(token: str, state: dict[str, Any]) -> None:
    p = _state_path(token)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, separators=(",", ":")))
    os.replace(tmp, p)


def _claim_state(token: str, owner: str) -> tuple[dict[str, Any], Path]:
    p = _state_path(token)
    inflight = _state_path(token, ".inflight")
    try:
        os.replace(p, inflight)
    except FileNotFoundError:
        raise HTTPException(400, "invalid or expired continuation token")
    try:
        state = json.loads(inflight.read_text())
        if state.get("owner") != owner:
            raise HTTPException(403, "continuation token does not belong to this user")
        if float(state.get("deadline", 0)) <= time.time():
            raise HTTPException(408, "programmatic execution expired")
        return state, inflight
    except Exception:
        if inflight.exists() and not p.exists():
            os.replace(inflight, p)
        raise


def _restore_claim(token: str, inflight: Path) -> None:
    p = _state_path(token)
    if inflight.exists() and not p.exists():
        os.replace(inflight, p)


def _decode_events(data: bytes) -> list[dict[str, Any]]:
    if len(data) > EVENT_LIMIT:
        raise HTTPException(413, "programmatic event stream exceeded limit")
    text = data.decode("utf-8", errors="replace")
    chunks = text.split(DELIMITER)
    out: list[dict[str, Any]] = []
    for raw in chunks[:-1]:
        if raw.strip():
            out.append(json.loads(raw))
    return out


async def _wait_event(sb: Sandbox, index: int, deadline: float) -> dict[str, Any]:
    while time.time() < deadline:
        try:
            raw = await sb.files.read_bytes("/mnt/data/.ptc/events.log")
        except Exception:
            raw = b""
        events = _decode_events(raw)
        if len(events) > index:
            return events[index]
        await asyncio.sleep(0.10)
    raise HTTPException(408, "programmatic execution timed out")


async def _send_message(sb: Sandbox, message: dict[str, Any]) -> None:
    name = f"/mnt/data/.ptc/send-{uuid.uuid4().hex}.json"
    payload = (json.dumps(message, separators=(",", ":")) + DELIMITER).encode()
    await sb.files.write_file(name, payload)
    await sb.commands.run(
        f"cat {shlex.quote(name)} > /mnt/data/.ptc/in && rm -f {shlex.quote(name)}"
    )


async def _connect(sandbox_id: str) -> Sandbox:
    return await Sandbox.connect(
        sandbox_id,
        connection_config=osb_cfg(),
        skip_health_check=False,
    )


async def _sandbox_paths(sb: Sandbox) -> list[str]:
    result = await sb.commands.run(
        "if [ -d /mnt/data ]; then "
        "find /mnt/data -type f -printf '%P\\n' "
        "| grep -v '^\\.ptc/' | head -n 66; fi"
    )
    out: list[str] = []
    for item in result.logs.stdout:
        for line in getattr(item, "text", str(item)).splitlines():
            if line.strip():
                out.append(line.strip())
    if len(out) > MAX_FILES:
        raise HTTPException(413, "too many generated files")
    return out


async def _collect_files(sb: Sandbox, state: dict[str, Any]) -> list[dict[str, Any]]:
    before = state.get("before", {})
    owner = state["owner"]
    out_sid = state["output_session_id"]
    refs: list[dict[str, Any]] = []
    for raw_name in await _sandbox_paths(sb):
        name = safe_name(raw_name)
        ext = Path(name).suffix.lower()
        if ext and ext not in ALLOWED_EXT:
            continue
        data = await sb.files.read_bytes("/mnt/data/" + name)
        if len(data) > MAX_BYTES:
            continue
        digest = hashlib.sha256(data).hexdigest()
        prior = before.get(name)
        if prior and prior.get("sha256") == digest:
            refs.append(
                {
                    "id": prior["id"],
                    "name": name,
                    "storage_session_id": prior["storage_session_id"],
                    "inherited": True,
                }
            )
            continue
        fid = uuid.uuid4().hex
        write_obj(owner, out_sid, fid, name, data, kind="user")
        refs.append({"id": fid, "name": name, "storage_session_id": out_sid})
    return refs


def _normalize_timeout(value: int | None) -> int:
    if value is None:
        return DEFAULT_TIMEOUT_MS
    if value < 1000 or value > MAX_TIMEOUT_MS:
        raise HTTPException(422, f"timeout must be between 1000 and {MAX_TIMEOUT_MS} ms")
    return value


def _validate_tool_calls(message: dict[str, Any], allowed: set[str]) -> list[dict[str, Any]]:
    calls = message.get("calls")
    if not isinstance(calls, list) or not calls:
        raise HTTPException(500, "sandbox returned invalid tool call batch")
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for call in calls:
        if not isinstance(call, dict):
            raise HTTPException(500, "sandbox returned malformed tool call")
        cid, name = call.get("id"), call.get("name")
        if not isinstance(cid, str) or not cid or cid in seen:
            raise HTTPException(500, "sandbox returned invalid tool call id")
        if not isinstance(name, str) or name not in allowed:
            raise HTTPException(500, "sandbox requested an unregistered tool")
        seen.add(cid)
        out.append({"id": cid, "name": name, "input": call.get("input", {})})
    return out


async def _finish_message(
    sb: Sandbox,
    state: dict[str, Any],
    message: dict[str, Any],
) -> dict[str, Any]:
    typ = message.get("type")
    if typ == "completed":
        files = await _collect_files(sb, state)
        return {
            "status": "completed",
            "session_id": state["session_id"],
            "stdout": message.get("stdout", ""),
            "stderr": message.get("stderr", ""),
            "files": files,
        }
    if typ == "error":
        return {
            "status": "error",
            "session_id": state["session_id"],
            "error": str(message.get("error") or "programmatic execution failed"),
            "stdout": message.get("stdout", ""),
            "stderr": message.get("stderr", ""),
        }
    raise HTTPException(500, "sandbox returned unknown programmatic message")


async def _start(req: ProgrammaticRequest, owner: str) -> dict[str, Any]:
    if req.code is None or req.code == "":
        raise HTTPException(422, "code is required for initial programmatic execution")
    tools = req.tools or []
    allowed = {t.name for t in tools}
    if len(allowed) != len(tools):
        raise HTTPException(422, "duplicate tool names are not allowed")

    lang = (req.language or req.lang or "py").lower()
    if lang == "python":
        lang = "py"
    if lang not in {"py", "bash"}:
        raise HTTPException(422, "programmatic language must be py/python or bash")

    timeout_ms = _normalize_timeout(req.timeout)
    deadline = time.time() + timeout_ms / 1000.0
    exec_sid = uuid.uuid4().hex
    out_sid = uuid.uuid4().hex
    sb: Sandbox | None = None
    before: dict[str, dict[str, str]] = {}

    try:
        sb = await Sandbox.create(
            IMAGE,
            timeout=timedelta(seconds=timeout_ms / 1000.0 + 60),
            ready_timeout=timedelta(seconds=90),
            resource={"cpu": "1000m", "memory": "1Gi"},
            metadata={"name": "librechat-ptc-" + exec_sid[:12]},
            connection_config=osb_cfg(),
        )
        await sb.commands.run("mkdir -p /mnt/data /mnt/data/.ptc")

        for ref in req.files or []:
            name = safe_name(ref.name)
            src = obj_path(owner, ref.storage_session_id, ref.id)
            if not src.is_file():
                raise HTTPException(404, f"input file not found: {name}")
            data = src.read_bytes()
            await sb.files.write_file("/mnt/data/" + name, data)
            before[name] = {
                "id": ref.id,
                "storage_session_id": ref.storage_session_id,
                "sha256": hashlib.sha256(data).hexdigest(),
            }

        vendor = "ptc_bash_server.py" if lang == "bash" else "ptc_server.py"
        server_path = VENDOR_DIR / vendor
        if not server_path.is_file():
            raise HTTPException(500, f"missing vendored runtime: {vendor}")
        await sb.files.write_file("/mnt/data/.ptc/server.py", server_path.read_bytes())

        await sb.commands.run(
            "rm -f /mnt/data/.ptc/in /mnt/data/.ptc/out /mnt/data/.ptc/events.log "
            "&& mkfifo /mnt/data/.ptc/in /mnt/data/.ptc/out"
        )
        launch = (
            "(tail -f /dev/null > /mnt/data/.ptc/in) & "
            "(cat /mnt/data/.ptc/out >> /mnt/data/.ptc/events.log) & "
            "python3 /mnt/data/.ptc/server.py "
            "< /mnt/data/.ptc/in > /mnt/data/.ptc/out "
            "2>/mnt/data/.ptc/server.err"
        )
        await sb.commands.run(launch, opts=RunCommandOpts(background=True))

        await _send_message(
            sb,
            {
                "code": req.code,
                "tools": [t.model_dump(exclude_none=True) for t in tools],
            },
        )
        message = await _wait_event(sb, 0, deadline)

        state: dict[str, Any] = {
            "owner": owner,
            "sandbox_id": sb.id,
            "session_id": exec_sid,
            "output_session_id": out_sid,
            "event_index": 1,
            "round_trip_count": 0,
            "deadline": deadline,
            "allowed_tools": sorted(allowed),
            "pending_ids": [],
            "before": before,
        }

        if message.get("type") == "tool_calls":
            calls = _validate_tool_calls(message, allowed)
            state["pending_ids"] = [c["id"] for c in calls]
            token = uuid.uuid4().hex
            _save_state(token, state)
            return {
                "status": "tool_call_required",
                "session_id": exec_sid,
                "continuation_token": token,
                "tool_calls": calls,
            }

        result = await _finish_message(sb, state, message)
        await sb.destroy()
        sb = None
        return result
    except Exception:
        if sb is not None:
            try:
                await sb.destroy()
            except Exception:
                pass
        raise


async def _continue(req: ProgrammaticRequest, owner: str) -> dict[str, Any]:
    token = req.continuation_token or ""
    state, inflight = _claim_state(token, owner)
    sb: Sandbox | None = None
    terminal = False
    try:
        expected = state.get("pending_ids", [])
        supplied = req.tool_results or []
        ids = [r.call_id for r in supplied]
        if len(ids) != len(set(ids)) or set(ids) != set(expected):
            raise HTTPException(400, "tool results do not match issued tool calls")

        rounds = int(state.get("round_trip_count", 0)) + 1
        if rounds > MAX_ROUNDS:
            terminal = True
            raise HTTPException(400, f"maximum programmatic round trips ({MAX_ROUNDS}) exceeded")

        sb = await _connect(state["sandbox_id"])
        await _send_message(
            sb,
            {
                "type": "tool_results",
                "results": [r.model_dump(exclude_none=True) for r in supplied],
            },
        )
        message = await _wait_event(
            sb,
            int(state["event_index"]),
            float(state["deadline"]),
        )
        state["event_index"] = int(state["event_index"]) + 1
        state["round_trip_count"] = rounds

        if message.get("type") == "tool_calls":
            calls = _validate_tool_calls(message, set(state.get("allowed_tools", [])))
            state["pending_ids"] = [c["id"] for c in calls]
            new_token = uuid.uuid4().hex
            _save_state(new_token, state)
            inflight.unlink(missing_ok=True)
            return {
                "status": "tool_call_required",
                "session_id": state["session_id"],
                "continuation_token": new_token,
                "tool_calls": calls,
            }

        terminal = True
        result = await _finish_message(sb, state, message)
        inflight.unlink(missing_ok=True)
        await sb.destroy()
        sb = None
        return result
    except HTTPException:
        if terminal:
            inflight.unlink(missing_ok=True)
            if sb is None:
                try:
                    sb = await _connect(state["sandbox_id"])
                except Exception:
                    sb = None
            if sb is not None:
                try:
                    await sb.destroy()
                except Exception:
                    pass
        else:
            _restore_claim(token, inflight)
        raise
    except Exception:
        _restore_claim(token, inflight)
        raise
    finally:
        # Sandbox SDK clients are short-lived handles; do not destroy a live PTC
        # sandbox unless the execution reached a terminal state.
        pass


@router.post("/v1/exec/programmatic")
async def programmatic(req: ProgrammaticRequest, request: Request):
    owner = request.state.code_owner
    if req.continuation_token:
        return await _continue(req, owner)
    if req.tool_results:
        raise HTTPException(422, "tool_results require continuation_token")
    return await _start(req, owner)
