import json
import subprocess
import sys
from pathlib import Path

DELIM = "\n---PTC_END---\n"
SCRIPT = Path(__file__).resolve().parents[1] / "vendor" / "ptc_server.py"


def send(proc, obj):
    proc.stdin.write(json.dumps(obj) + DELIM)
    proc.stdin.flush()


def recv(proc):
    buf = ""
    while DELIM not in buf:
        line = proc.stdout.readline()
        if line == "":
            raise AssertionError("PTC server exited before delimiter")
        buf += line
    return json.loads(buf.split(DELIM, 1)[0])


def test_python_programmatic_round_trip():
    proc = subprocess.Popen(
        [sys.executable, str(SCRIPT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd="/tmp",
    )
    try:
        send(
            proc,
            {
                "code": 'r = await lookup(q="hello")\nprint(r["value"])',
                "tools": [{"name": "lookup", "parameters": {"type": "object"}}],
            },
        )
        first = recv(proc)
        assert first["type"] == "tool_calls"
        assert len(first["calls"]) == 1
        call = first["calls"][0]
        assert call["name"] == "lookup"
        assert call["input"] == {"q": "hello"}

        send(
            proc,
            {
                "type": "tool_results",
                "results": [
                    {
                        "call_id": call["id"],
                        "result": {"value": 42},
                        "is_error": False,
                    }
                ],
            },
        )
        final = recv(proc)
        assert final["type"] == "completed"
        assert final["stdout"].strip() == "42"
        assert final["stderr"] == ""
        assert proc.wait(timeout=5) == 0
    finally:
        if proc.poll() is None:
            proc.kill()


def test_unregistered_python_name_errors_without_tool_call():
    proc = subprocess.Popen(
        [sys.executable, str(SCRIPT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd="/tmp",
    )
    try:
        send(proc, {"code": "await missing_tool(x=1)", "tools": []})
        result = recv(proc)
        assert result["type"] == "error"
        assert "missing_tool" in (result.get("error") or result.get("stderr") or "")
    finally:
        if proc.poll() is None:
            proc.kill()


def test_bash_programmatic_round_trip(tmp_path):
    script = Path(__file__).resolve().parents[1] / "vendor" / "ptc_bash_server.py"
    env = dict(__import__("os").environ)
    env["PTC_BASH_DIR"] = str(tmp_path / ".ptc")
    proc = subprocess.Popen(
        [sys.executable, str(script)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=str(tmp_path),
        env=env,
    )
    try:
        send(
            proc,
            {
                "code": "value=$(lookup '{\"q\":\"hello\"}')\necho \"$value\"",
                "tools": [{"name": "lookup", "parameters": {"type": "object"}}],
            },
        )
        first = recv(proc)
        assert first["type"] == "tool_calls"
        assert first["calls"][0]["name"] == "lookup"
        assert first["calls"][0]["input"] == {"q": "hello"}

        send(
            proc,
            {
                "type": "tool_results",
                "results": [
                    {
                        "call_id": first["calls"][0]["id"],
                        "result": {"value": 42},
                        "is_error": False,
                    }
                ],
            },
        )
        final = recv(proc)
        assert final["type"] == "completed"
        assert '"value": 42' in final["stdout"]
        assert proc.wait(timeout=5) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
