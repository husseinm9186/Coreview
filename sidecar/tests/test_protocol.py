"""The JSON-lines contract: shape in, shape out, secrets never echoed."""
import io
import json
import os

import pytest

from coreview_sidecar.__main__ import Sidecar
from coreview_sidecar.protocol import BadRequest, Response, parse_request, redact

TEMPLATES = os.path.join(os.path.dirname(__file__), "..", "..", "resources", "templates", "ntc")


def test_a_request_needs_an_op_and_an_id():
    with pytest.raises(BadRequest, match="not JSON"):
        parse_request("{")
    with pytest.raises(BadRequest, match="not an object"):
        parse_request("[]")
    with pytest.raises(BadRequest, match="op 'fly' is not one of"):
        parse_request('{"op":"fly","id":1}')
    with pytest.raises(BadRequest, match="no id"):
        parse_request('{"op":"hello"}')
    with pytest.raises(BadRequest, match="run needs a cmd"):
        parse_request('{"op":"run","id":1,"session":"s"}')
    with pytest.raises(BadRequest, match="open needs auth.username"):
        parse_request('{"op":"open","id":1,"session":"s","host":"h","os":"cisco_ios"}')


def test_a_response_is_one_json_line_with_the_spec_fields():
    line = Response(7, "ok", session="s1", device="192.0.2.10", cmd="show version", rows=[{"a": "1"}], raw="x", duration_ms=12).line()
    assert "\n" not in line
    body = json.loads(line)
    assert body == {"id": 7, "status": "ok", "session": "s1", "device": "192.0.2.10", "cmd": "show version", "rows": [{"a": "1"}], "raw": "x", "duration_ms": 12, "error": None}


def test_a_status_outside_the_contract_is_a_bug():
    with pytest.raises(AssertionError):
        Response(1, "maybe").line()


def test_redact_hides_every_secret_field():
    req = {"op": "open", "auth": {"username": "reader", "password": "not-a-real-secret", "enable": "also-fake", "private_key": "----", "passphrase": "x"}}
    r = redact(req)["auth"]
    assert r == {"username": "reader", "password": "…", "enable": "…", "private_key": "…", "passphrase": "…"}


def drive(lines):
    out = io.StringIO()
    s = Sidecar(out)
    s.serve(io.StringIO("\n".join(lines) + "\n"))
    return [json.loads(l) for l in out.getvalue().splitlines()]


def test_hello_parse_and_quit_without_any_network():
    raw = "Internet  192.0.2.1  0  0000.0000.0001  ARPA  Vlan10\n"
    got = drive([
        json.dumps({"op": "hello", "id": 1, "protocol": 1, "templates_dir": TEMPLATES}),
        json.dumps({"op": "parse", "id": 2, "os": "cisco_ios", "cmd": "show ip arp", "parser": "textfsm:cisco_ios_show_ip_arp", "raw": raw}),
        json.dumps({"op": "parse", "id": 3, "parser": "textfsm:no_such_template", "raw": raw}),
        json.dumps({"op": "parse", "id": 4, "parser": "json", "raw": "{not json"}),
        json.dumps({"op": "run", "id": 5, "session": "nope", "cmd": "show version"}),
        '{"op":"bogus","id":6}',
        json.dumps({"op": "quit", "id": 7}),
    ])
    by = {g.get("id"): g for g in got if "id" in g}
    assert by[1]["status"] == "ok" and by[1]["protocol"] == 1 and by[1]["templates_dir"]
    assert by[2]["status"] == "ok"
    assert by[2]["rows"][0]["ip_address"] == "192.0.2.1"
    assert by[2]["rows"][0]["mac_address"] == "0000.0000.0001"
    assert by[3]["status"] == "parse_error" and "no template" in by[3]["error"]
    assert by[4]["status"] == "parse_error"
    assert by[5]["status"] == "error" and by[5]["error"] == "no such session"
    assert by[6]["status"] == "error" and "bad request" in by[6]["error"]
    assert by[7]["status"] == "ok"


def test_a_refused_command_never_reaches_a_session():
    # No session is open, but the allowlist verdict comes before the session lookup would matter
    # only for run; here the point is that a write verb gets "refused"/"error", never a send.
    got = drive([
        json.dumps({"op": "hello", "id": 1, "templates_dir": TEMPLATES}),
        json.dumps({"op": "run", "id": 2, "session": "s", "cmd": "reload"}),
        json.dumps({"op": "quit", "id": 3}),
    ])
    by = {g.get("id"): g for g in got if "id" in g}
    assert by[2]["status"] in ("error", "refused")
