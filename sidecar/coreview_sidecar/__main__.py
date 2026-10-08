"""
The JSON-lines loop: a request per line on stdin, a response per request
on stdout, events in between. Nothing is written anywhere else. Run as
`python -m coreview_sidecar`; Rust spawns it from the install directory.
"""
from __future__ import annotations

import json
import sys
import time
import traceback

from . import PROTOCOL_VERSION, __version__
from .allowlist import verdict
from .parse import ParseError, parse, set_templates_dir, templates_dir
from .protocol import BadRequest, Event, Response, parse_request, redact
from .session import Session, SessionError


class Sidecar:
    def __init__(self, out=None):
        self.out = out or sys.stdout
        self.sessions: dict[str, Session] = {}
        self.quit = False

    # ------------------------------------------------------------------ io

    def write(self, line: str) -> None:
        self.out.write(line + "\n")
        self.out.flush()

    def emit(self, event: str, session: str | None = None, **extra) -> None:
        self.write(Event(event, session, extra).line())

    # ------------------------------------------------------------ dispatch

    def handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            req = parse_request(line)
        except BadRequest as e:
            rid = None
            try:
                rid = json.loads(line).get("id")
            except Exception:  # noqa: BLE001
                pass
            self.write(Response(rid, "error", error=f"bad request: {e}").line())
            return
        try:
            resp = self.dispatch(req)
        except SessionError as e:
            resp = Response(req["id"], e.status, session=req.get("session"), cmd=req.get("cmd"), error=str(e))
        except Exception as e:  # noqa: BLE001 — every request gets exactly one answer
            resp = Response(req["id"], "error", session=req.get("session"), cmd=req.get("cmd"), error=f"{type(e).__name__}: {e}")
            self.emit("log", req.get("session"), level="error", msg=traceback.format_exc(limit=3))
        self.write(resp.line())

    def dispatch(self, req: dict) -> Response:
        op = req["op"]
        rid = req["id"]
        if op == "hello":
            if req.get("protocol") not in (None, PROTOCOL_VERSION):
                return Response(rid, "error", error=f"protocol {req.get('protocol')} is not {PROTOCOL_VERSION}")
            if req.get("templates_dir"):
                set_templates_dir(req["templates_dir"])
            import ntc_templates, scrapli, textfsm  # noqa: E401

            return Response(rid, "ok", extra={
                "sidecar": __version__, "protocol": PROTOCOL_VERSION, "python": sys.version.split()[0],
                "scrapli": scrapli.__version__, "ntc_templates": getattr(ntc_templates, "__version__", "?"), "textfsm": getattr(textfsm, "__version__", "?"),
                "templates_dir": templates_dir(),
            })
        if op == "quit":
            for s in list(self.sessions.values()):
                s.close()
            self.sessions.clear()
            self.quit = True
            return Response(rid, "ok")
        if op == "parse":
            started = time.monotonic()
            try:
                rows = parse(req["parser"], req["raw"], req.get("also") or [])
            except ParseError as e:
                return Response(rid, "parse_error", cmd=req.get("cmd"), raw=req["raw"], error=str(e), duration_ms=int((time.monotonic() - started) * 1000))
            return Response(rid, "ok", cmd=req.get("cmd"), rows=rows, raw=req["raw"], duration_ms=int((time.monotonic() - started) * 1000))
        sid = req["session"]
        if op == "open":
            if sid in self.sessions:
                return Response(rid, "error", session=sid, error="session already open")
            self.emit("log", sid, level="info", msg=f"opening {redact(req)['host']} as {req['os']}")
            s = Session(sid, req["host"], int(req.get("port") or 22), req["os"], req["auth"], req.get("session_spec") or {}, req.get("timeouts") or {}, lambda ev, **kw: self.emit(ev, sid, **kw), known_key=req.get("known_host_key"), transport=req.get("transport") or "ssh")
            info = s.open()
            self.sessions[sid] = s
            return Response(rid, "ok", session=sid, device=req["host"], extra=info)
        # The allowlist's answer before anything else — a write verb
        # is refused whether or not a session exists.
        if op == "run":
            v = verdict(req["cmd"])
            if v != "ok":
                self.emit("log", sid, level="error", msg=f"refused {req['cmd']!r}: {v}")
                return Response(rid, "refused", session=sid, cmd=req["cmd"], error=v)
        s = self.sessions.get(sid)
        if s is None:
            return Response(rid, "error", session=sid, error="no such session")
        if op == "close":
            s.close()
            del self.sessions[sid]
            return Response(rid, "ok", session=sid, device=s.host)
        if op == "switch":
            info = s.switch(req.get("context") or {})
            return Response(rid, "ok", session=sid, device=s.host, extra=info)
        if op == "run":
            cmd = req["cmd"]
            v = verdict(cmd)
            if v != "ok":
                self.emit("log", sid, level="error", msg=f"refused {cmd!r}: {v}")
                return Response(rid, "refused", session=sid, device=s.host, cmd=cmd, error=v)
            status, raw, ms = s.run(cmd, int(req.get("timeout_ms") or 30000))
            if status == "timeout":
                # The transport is closed; the session is gone with it.
                del self.sessions[sid]
                return Response(rid, status, session=sid, device=s.host, cmd=cmd, raw=raw, duration_ms=ms, error="timed out; the session is closed")
            if status != "ok":
                return Response(rid, status, session=sid, device=s.host, cmd=cmd, raw=raw, duration_ms=ms, error="rejected by device")
            parser = req.get("parser") or "none"
            try:
                rows = parse(parser, raw, req.get("also") or [])
            except ParseError as e:
                return Response(rid, "parse_error", session=sid, device=s.host, cmd=cmd, raw=raw, duration_ms=ms, error=str(e))
            return Response(rid, "ok", session=sid, device=s.host, cmd=cmd, rows=rows, raw=raw, duration_ms=ms)
        return Response(rid, "error", error=f"unhandled op {op}")

    # ---------------------------------------------------------------- loop

    def serve(self, inp=None) -> int:
        inp = inp or sys.stdin
        for line in inp:
            self.handle_line(line)
            if self.quit:
                break
        for s in list(self.sessions.values()):
            s.close()
        return 0


def main() -> int:
    if "--version" in sys.argv[1:]:
        print(f"coreview-sidecar {__version__} protocol {PROTOCOL_VERSION}")
        return 0
    return Sidecar().serve()


if __name__ == "__main__":
    sys.exit(main())
