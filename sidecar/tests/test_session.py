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
