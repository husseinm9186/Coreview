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
