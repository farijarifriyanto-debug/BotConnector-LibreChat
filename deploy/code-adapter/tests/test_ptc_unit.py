import time

import pytest
import ptc
from ptc import _decode_events, _validate_tool_calls
from fastapi import HTTPException

D = b"\n---PTC_END---\n"


def test_decode_events_only_returns_complete_frames():
    raw = b'{"type":"a"}' + D + b'{"type":"b"}' + D + b'{"partial":'
    assert _decode_events(raw) == [{"type": "a"}, {"type": "b"}]


def test_validate_tool_calls_rejects_unregistered_tool():
    try:
        _validate_tool_calls(
            {"calls": [{"id": "c1", "name": "forbidden", "input": {}}]},
            {"allowed"},
        )
    except HTTPException as exc:
        assert exc.status_code == 500
    else:
        raise AssertionError("unregistered tool was accepted")


def test_validate_tool_calls_accepts_registered_batch():
    calls = _validate_tool_calls(
        {
            "calls": [
                {"id": "c1", "name": "lookup", "input": {"x": 1}},
                {"id": "c2", "name": "lookup", "input": {"x": 2}},
            ]
        },
        {"lookup"},
    )
    assert [c["id"] for c in calls] == ["c1", "c2"]


def test_expired_continuation_is_consumed(tmp_path, monkeypatch):
    monkeypatch.setattr(ptc, "STATE_DIR", tmp_path)
    token = "a" * 32
    ptc._save_state(
        token,
        {"owner": "owner-a", "deadline": time.time() - 1},
    )

    with pytest.raises(HTTPException) as exc:
        ptc._claim_state(token, "owner-a")

    assert exc.value.status_code == 408
    assert not (tmp_path / f"{token}.json").exists()
    assert not (tmp_path / f"{token}.inflight").exists()


def test_wrong_owner_does_not_consume_continuation(tmp_path, monkeypatch):
    monkeypatch.setattr(ptc, "STATE_DIR", tmp_path)
    token = "b" * 32
    ptc._save_state(
        token,
        {"owner": "owner-a", "deadline": time.time() + 60},
    )

    with pytest.raises(HTTPException) as exc:
        ptc._claim_state(token, "owner-b")

    assert exc.value.status_code == 403
    assert (tmp_path / f"{token}.json").exists()
    assert not (tmp_path / f"{token}.inflight").exists()
