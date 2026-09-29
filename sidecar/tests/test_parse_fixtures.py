"""
LT-509: every template a catalog names is run over ntc-templates' own
fixtures (resources/templates/tests/<platform>/<template>/*.raw) and must
give exactly the rows in the matching .yml. These are the same files the
Phase-2 Rust engine must pass.
"""
import glob
import os

import pytest
import yaml

from coreview_sidecar.parse import parse, set_templates_dir

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
NTC = os.path.join(ROOT, "resources", "templates", "ntc")
TESTS = os.path.join(ROOT, "resources", "templates", "tests")
CATALOGS = os.path.join(ROOT, "resources", "catalog")

set_templates_dir(NTC)


def templates_named_by_catalogs():
    """[first template, *also] per catalog command; the fixture dir is named after the first."""
    named = {}
    for path in glob.glob(os.path.join(CATALOGS, "*.yaml")):
        with open(path, encoding="utf-8") as f:
            cat = yaml.safe_load(f)
        for cmd in cat.get("commands", []) + cat.get("live_path", []):
            first = next((p for p in [cmd.get("parser", ""), cmd.get("shadow") or ""] if p.startswith("textfsm:")), None)
            if first:
                named.setdefault(first[len("textfsm:"):], [a[len("textfsm:"):] for a in cmd.get("also", [])])
        for probe in cat.get("caps_probe", []):
            p = probe.get("parser") or ""
            if p.startswith("textfsm:"):
                named.setdefault(p[len("textfsm:"):], [])
    return sorted(named.items())


def fixture_pairs():
    platforms = sorted(os.listdir(TESTS), key=len, reverse=True)
    pairs = []
    for name, also in templates_named_by_catalogs():
        platform = next((p for p in platforms if name.startswith(p + "_")), None)
        if platform is None:
            continue
        d = os.path.join(TESTS, platform, name[len(platform) + 1:])
        for raw in sorted(glob.glob(os.path.join(d, "*.raw"))):
            yml = raw[:-4] + ".yml"
            if os.path.exists(yml):
                pairs.append((name, also, raw, yml))
    return pairs


PAIRS = fixture_pairs()


def test_the_catalogs_name_templates_with_fixtures():
    assert len(PAIRS) >= 200, len(PAIRS)


@pytest.mark.parametrize("name,also,raw,yml", PAIRS, ids=[os.path.relpath(r, TESTS) for _, _, r, _ in PAIRS])
def test_fixture(name, also, raw, yml):
    with open(raw, encoding="utf-8") as f:
        text = f.read()
    with open(yml, encoding="utf-8") as f:
        expected = yaml.safe_load(f)["parsed_sample"]
    rows = parse(f"textfsm:{name}", text, [f"textfsm:{a}" for a in also])
    assert rows == expected
