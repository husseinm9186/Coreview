"""
The JSON-lines contract between Rust and the sidecar (docs/DISCOVERY-SPEC.md,
"Sidecar contract"). One object per line each way. Rust writes requests;
the sidecar answers each request `id` exactly once and may emit `event`
lines in between. Secrets travel on stdin only — never argv, never the
environment, never a file — and are never echoed back.

Requests:
    {"op":"hello","id":..,"protocol":1,"templates_dir":"…"}
    {"op":"open","id":..,"session":"s1","host":..,"port":22,"os":"cisco_ios",
     "auth":{"username":..,"password":..,"enable":..,"private_key":..},
     "timeouts":{"connect_ms":8000,"auth_ms":20000},
     "known_host_key":"SHA256:…" or null}      (LT-529: the fingerprint Coreview remembers;
                                                a different key ends the open with status
                                                "host_key" before any credential is sent)
    {"op":"run","id":..,"session":"s1","cmd":"show ip route","parser":"textfsm:cisco_ios_show_ip_route","also":[],"timeout_ms":30000}
    {"op":"switch","id":..,"session":"s1","context":{"kind":"vdom","name":"root"}}
    {"op":"parse","id":..,"os":"cisco_ios","cmd":"show ip arp","parser":"textfsm:…","raw":"…"}
    {"op":"close","id":..,"session":"s1"}
    {"op":"quit","id":..}

Responses:
    {"id":..,"session":..,"device":..,"cmd":..,"status":"ok|unsupported|timeout|auth|parse_error|refused|error",
     "rows":[…],"raw":"…","duration_ms":812,"error":null}
Events:
    {"event":"log","level":"info","session":..,"msg":..}
    {"event":"host_key","session":..,"host":..,"fingerprint":..}
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

STATUSES = ("ok", "unsupported", "timeout", "auth", "host_key", "parse_error", "refused", "error")
OPS = ("hello", "open", "run", "switch", "parse", "close", "quit")


@dataclass
class Response:
    id: Any
    status: str
    session: Optional[str] = None
    device: Optional[str] = None
    cmd: Optional[str] = None
    rows: list = field(default_factory=list)
    raw: str = ""
    duration_ms: int = 0
    error: Optional[str] = None
    extra: dict = field(default_factory=dict)

    def line(self) -> str:
        assert self.status in STATUSES, self.status
        body = asdict(self)
        extra = body.pop("extra")
        body.update(extra)
        return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


@dataclass
class Event:
    event: str
    session: Optional[str] = None
    extra: dict = field(default_factory=dict)

    def line(self) -> str:
        body = {"event": self.event, "session": self.session}
        body.update(self.extra)
        return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


class BadRequest(ValueError):
    pass


def parse_request(line: str) -> dict:
    """One line → a request dict, or BadRequest saying what is wrong."""
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        raise BadRequest(f"not JSON: {e.msg}") from None
    if not isinstance(req, dict):
        raise BadRequest("not an object")
    op = req.get("op")
    if op not in OPS:
        raise BadRequest(f"op {op!r} is not one of {', '.join(OPS)}")
    if "id" not in req:
        raise BadRequest("no id")
    if op in ("open", "run", "switch", "close") and not isinstance(req.get("session"), str):
        raise BadRequest(f"{op} needs a session")
    if op == "run" and not isinstance(req.get("cmd"), str):
        raise BadRequest("run needs a cmd")
    if op == "parse" and not (isinstance(req.get("raw"), str) and isinstance(req.get("parser"), str)):
        raise BadRequest("parse needs raw and parser")
    if op == "open":
        for key in ("host", "os"):
            if not isinstance(req.get(key), str):
                raise BadRequest(f"open needs {key}")
        auth = req.get("auth")
        if not isinstance(auth, dict) or not isinstance(auth.get("username"), str):
            raise BadRequest("open needs auth.username")
    return req


def redact(req: dict) -> dict:
    """A request with its secrets replaced, for a log line."""
    out = dict(req)
    if isinstance(out.get("auth"), dict):
        out["auth"] = {k: ("…" if k in ("password", "enable", "private_key", "passphrase") and v else v) for k, v in out["auth"].items()}
    return out
