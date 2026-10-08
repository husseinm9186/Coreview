"""The Python allowlist agrees with the fixture Rust and JavaScript also run."""
import json
import os

import pytest

from coreview_sidecar.allowlist import verdict

HERE = os.path.dirname(__file__)
CASES = os.path.join(HERE, "..", "..", "resources", "catalog", "allowlist-cases.json")

with open(CASES, encoding="utf-8") as f:
    cases = json.load(f)


@pytest.mark.parametrize("case", cases, ids=[c["command"][:40] or "(empty)" for c in cases])
def test_shared_case(case):
    assert verdict(case["command"]) == case["verdict"]


def test_at_least_twenty_cases():
    assert len(cases) >= 20


def test_not_a_string():
    assert verdict(42) == "not a string"
    assert verdict(None) == "not a string"
