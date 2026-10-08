"""past the banner, a channel that is never granted and a shell
request that is never answered are waited for only as long as the banner
is, not an hour and not forever."""

import threading

from paramiko.channel import Channel
from paramiko.ssh_exception import SSHException
import pytest

from coreview_sidecar import session as s
from coreview_sidecar import session as s_mod


class _NeverAnswers:
    """The least a Channel needs from its transport here."""

    def get_exception(self):
        return None


def test_a_shell_request_that_is_never_answered_is_bounded(monkeypatch):
    monkeypatch.setattr(s._PatientTransport, "banner_wait", 0.3)
    ch = Channel(1)
    ch.transport = _NeverAnswers()
    ch.event = threading.Event()  # never set: the device says nothing
    with pytest.raises(SSHException) as e:
        ch._wait_for_event()
    assert "did not answer the shell request" in str(e.value)


def test_an_answered_request_passes_straight_through(monkeypatch):
    monkeypatch.setattr(s._PatientTransport, "banner_wait", 0.3)
    ch = Channel(1)
    ch.transport = _NeverAnswers()
    ch.event = threading.Event()
    ch.event_ready = True
    ch.event.set()
    ch._wait_for_event()  # no raise


def test_the_channel_is_opened_with_the_banner_bound(monkeypatch):
    seen = {}

    def fake_open_session(self, window_size=None, max_packet_size=None, timeout=None):
        seen["timeout"] = timeout
        return "channel"

    monkeypatch.setattr(s._ParamikoTransport, "open_session", fake_open_session)
    monkeypatch.setattr(s._PatientTransport, "banner_wait", 42.0)
    t = s._PatientTransport.__new__(s._PatientTransport)
    assert t.open_session() == "channel"
    assert seen["timeout"] == 42.0


def test_a_telnet_session_is_built_on_the_telnet_transport_with_no_host_key_check():
    """Rust asks for telnet after SSH did not answer; the session is
    built on scrapli's telnet transport and the SSH host-key hook is not
    attached, since telnet has no key."""
    AUTH = {"username": "reader", "password": "not-a-real-password"}
    s = s_mod.Session("t", "127.0.0.1", 23, "cisco_ios", AUTH, {}, {}, lambda *a, **k: None, transport="telnet")
    assert type(s.conn.transport).__name__ == "TelnetTransport"
    assert not hasattr(s.conn.transport, "_verify_key") or s.conn.transport._verify_key != s._verify_key
    ssh = s_mod.Session("t2", "127.0.0.1", 22, "cisco_ios", AUTH, {}, {}, lambda *a, **k: None)
    assert type(ssh.conn.transport).__name__ != "TelnetTransport"
    with pytest.raises(s_mod.SessionError):
        s_mod.Session("t3", "127.0.0.1", 22, "cisco_ios", AUTH, {}, {}, lambda *a, **k: None, transport="carrier-pigeon")
