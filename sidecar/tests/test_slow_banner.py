"""LT-601: a device that takes longer than paramiko's 15 s to send its SSH
banner — the lab's PA-220 took 6.6–15.3 s — is still reached."""

import socket
import threading
import time

import pytest

from coreview_sidecar.session import Session, SessionError

AUTH = {"username": "reader", "password": "not-a-real-password"}


def _slow_banner_server(delay: float):
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]

    def serve():
        conn, _ = srv.accept()
        time.sleep(delay)
        conn.sendall(b"SSH-2.0-OpenSSH_8.0\r\n")
        # Then nothing: past the banner is all this test asks about.
        time.sleep(5)
        conn.close()
        srv.close()

    threading.Thread(target=serve, daemon=True).start()
    return port


def test_a_banner_after_sixteen_seconds_is_waited_for():
    port = _slow_banner_server(16)
    s = Session("t", "127.0.0.1", port, "generic", AUTH, {}, {"connect_ms": 5000, "auth_ms": 20000}, lambda *a, **k: None)
    with pytest.raises(SessionError) as e:
        s.open()
    # It gets past the banner; what stops it is the key exchange that never comes.
    assert "banner" not in str(e.value).lower(), str(e.value)
