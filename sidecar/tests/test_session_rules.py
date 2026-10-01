"""The session's rules, without a network (LT-627–LT-632)."""

import pytest
from scrapli.exceptions import ScrapliTimeout

from coreview_sidecar.session import Session, SessionError

AUTH = {"username": "reader", "password": "not-a-real-password"}
TIMEOUTS = {"connect_ms": 1000, "auth_ms": 1000}


class Reply:
    def __init__(self, result="", failed=False):
        self.result = result
        self.failed = failed


class FakeConn:
    """Enough of a scrapli connection for the rules: records what is sent,
    answers from a script, raises what the script says."""

    def __init__(self, script=None, prompt="SW1#"):
        self.sent = []
        self.script = script or {}
        self.prompt = prompt
        self.closed = False
        self.interactive = []
        self.failed_when_contains = []

    def open(self):
        pass

    def close(self):
        self.closed = True

    def get_prompt(self):
        return self.prompt

    def send_command(self, cmd, **kw):
        self.sent.append(cmd)
        answer = self.script.get(cmd, "")
        if isinstance(answer, Exception):
            raise answer
        return Reply(answer)

    def send_interactive(self, steps, **kw):
        self.interactive.append(steps)
        return Reply("")


def session(spec=None, os_name="generic", conn=None):
    s = Session("t", "192.0.2.1", 22, os_name, AUTH, spec or {}, TIMEOUTS, lambda *a, **k: None)
    s.conn = conn or FakeConn()
    return s


def test_a_timed_out_command_closes_the_session_and_says_so():
    # LT-627: scrapli closes the transport on a timeout; the sidecar must not
    # go on as if the session were alive.
    s = session(conn=FakeConn({"show tech": ScrapliTimeout("x")}))
    status, _, _ = s.run("show tech", 100)
    assert status == "timeout"
    assert s.conn.closed
    with pytest.raises(SessionError) as e:
        s.run("show version", 100)
    assert e.value.status == "error" and "timed out" in str(e.value)
    with pytest.raises(SessionError):
        s.switch({"name": "x"})


def test_an_open_that_fails_after_the_handshake_closes_the_connection():
    # LT-628: a failure in the context check leaves no VTY line behind.
    spec = {"contexts": {"kind": "vdom", "detect": {"cmd": "get system status", "match": "^Virtual domain configuration: multiple"}, "enter": ["config vdom", "edit {vdom}"], "leave": ["end"]}}
    s = session(spec, os_name="fortios", conn=FakeConn({"get system status": ScrapliTimeout("slow")}))
    with pytest.raises(SessionError):
        s.open()
    assert s.conn.closed


def test_an_escalate_step_outside_the_vocabulary_is_refused():
    # LT-629: the one catalog literal that reached the device unchecked.
    spec = {"privilege_levels": {"privilege_exec": {"pattern": "#\\s*$", "escalate": "configure terminal"}}, "default_privilege": "privilege_exec"}
    conn = FakeConn(prompt="SW1>")
    s = session(spec, conn=conn)
    with pytest.raises(SessionError) as e:
        s.open()
    assert e.value.status == "refused"
    assert conn.interactive == [], "nothing interactive was sent"
    assert "configure terminal" not in " ".join(conn.sent)


def test_paging_is_restored_after_leaving_the_context():
    # LT-630: `config system console` is refused inside a VDOM.
    spec = {
        "contexts": {"kind": "vdom", "detect": {"cmd": "get system status", "match": "^Virtual domain configuration: multiple"}, "list": {"cmd": "diagnose sys vd list", "match": "^name=(\\S+)/"}, "enter_global": ["config global"], "enter": ["config vdom", "edit {vdom}"], "leave": ["end"]},
        "paging": {"check": {"cmd": "get system console | grep ^output", "match": "output\\s*:\\s*(\\w+)", "want": "standard", "in_global": True}, "off": ["config system console", "set output standard", "end"], "restore": ["config system console", "set output {original}", "end"]},
    }
    conn = FakeConn({"get system status": "Virtual domain configuration: multiple", "diagnose sys vd list": "name=root/root\nname=dmz/dmz\n", "get system console | grep ^output": "output : more"}, prompt="FGT (global) #")
    s = session(spec, os_name="fortios", conn=conn)
    s.open()
    s.switch({"name": "dmz"})
    conn.sent.clear()
    s.close()
    assert conn.sent[0] == "end", conn.sent
    assert conn.sent[1:4] == ["config global", "config system console", "set output more"], conn.sent


def test_a_context_the_device_did_not_list_is_refused():
    # LT-631: `config vdom` / `edit <new>` / `end` would make one.
    spec = {"contexts": {"kind": "vdom", "detect": {"cmd": "get system status", "match": "^Virtual domain configuration: multiple"}, "list": {"cmd": "diagnose sys vd list", "match": "^name=(\\S+)/"}, "enter": ["config vdom", "edit {vdom}"], "leave": ["end"]}}
    conn = FakeConn({"get system status": "Virtual domain configuration: multiple", "diagnose sys vd list": "Unknown action 0"}, prompt="FGT #")
    s = session(spec, os_name="fortios", conn=conn)
    s.open()
    with pytest.raises(SessionError) as e:
        s.switch({"name": "made-up"})
    assert e.value.status == "unsupported"
    assert "edit made-up" not in conn.sent


def test_a_private_key_given_as_text_is_refused_without_being_quoted():
    # LT-632: scrapli takes the key as a file path and would name the "path" in its error.
    auth = {"username": "reader", "private_key": "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-not-a-real-key\n-----END OPENSSH PRIVATE KEY-----"}
    with pytest.raises(SessionError) as e:
        Session("t", "192.0.2.1", 22, "generic", auth, {}, TIMEOUTS, lambda *a, **k: None)
    assert "fixture-not-a-real-key" not in str(e.value)
    assert e.value.status == "auth"
