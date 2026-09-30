"""The session wrapper, without a network (LT-560, LT-561)."""

from coreview_sidecar.session import Session

AUTH = {"username": "reader", "password": "not-a-real-password"}
TIMEOUTS = {"connect_ms": 1000, "auth_ms": 1000}


def test_a_fortios_session_can_be_built():
    # LT-560: scrapli's fortinet_fortios platform takes no auth_secondary.
    s = Session("t", "192.0.2.1", 22, "fortios", AUTH, {}, TIMEOUTS, lambda *a, **k: None)
    assert s.conn is not None


def test_every_named_platform_can_be_built():
    from coreview_sidecar.session import PLATFORMS

    for os_name in PLATFORMS:
        Session("t", "192.0.2.1", 22, os_name, AUTH, {}, TIMEOUTS, lambda *a, **k: None)


def test_the_fingerprint_session_turns_the_pager_off_first():
    # LT-561: a Catalyst's `show version` stopped at --More-- and the switch closed the connection.
    s = Session("t", "192.0.2.1", 22, "generic", AUTH, {}, TIMEOUTS, lambda *a, **k: None)
    sent = []

    class R:
        result = ""

    s.conn.open = lambda: None
    s.conn.get_prompt = lambda: "SW1#"
    s.conn.send_command = lambda cmd, **kw: (sent.append(cmd), R())[1]
    s.open()
    assert sent and sent[0] == "terminal length 0", sent


def test_a_refusal_the_catalog_names_is_not_stored_as_answered():
    # LT-568: FortiOS 7.6 answers `diagnose ip address list` with "Unknown action 0",
    # which scrapli's FortiOS driver does not list; the catalog's list was never passed on.
    spec = {"failed_when_contains": ["Unknown action", "command parse error"]}
    s = Session("t", "192.0.2.1", 22, "fortios", AUTH, spec, TIMEOUTS, lambda *a, **k: None)

    class R:
        def __init__(self, result, markers):
            self.result = result
            self.failed = any(m in result for m in markers)

    def send(cmd, **kw):
        # What scrapli does: the markers passed, or the driver's own when none are.
        markers = kw.get("failed_when_contains")
        return R("Unknown action 0\n", s.conn.failed_when_contains if markers is None else markers)

    s.conn.send_command = send
    status, _, _ = s.run("diagnose ip address list", 5000)
    assert status == "unsupported"
