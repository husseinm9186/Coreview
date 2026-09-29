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

set_templates_dir(NTC)


def also_from_index():
    """first template -> the templates the same index row joins after it."""
    out = {}
    with open(os.path.join(NTC, "index"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("Template,"):
                continue
            names = [t.strip().removesuffix(".textfsm") for t in line.split(",")[0].split(":")]
            out.setdefault(names[0], names[1:])
    return out


def fixture_pairs():
    """Every vendored pair — the same set crates/coreview-catalog/tests/ntc_conformance.rs runs."""
    also = also_from_index()
    pairs = []
    for platform in sorted(os.listdir(TESTS)):
        pdir = os.path.join(TESTS, platform)
        if not os.path.isdir(pdir):
            continue
        for command in sorted(os.listdir(pdir)):
            name = f"{platform}_{command}"
            for raw in sorted(glob.glob(os.path.join(pdir, command, "*.raw"))):
                yml = raw[:-4] + ".yml"
                if os.path.exists(yml):
                    pairs.append((name, also.get(name, []), raw, yml))
    return pairs


PAIRS = fixture_pairs()


def test_the_catalogs_name_templates_with_fixtures():
    assert len(PAIRS) >= 519, len(PAIRS)


@pytest.mark.parametrize("name,also,raw,yml", PAIRS, ids=[os.path.relpath(r, TESTS) for _, _, r, _ in PAIRS])
def test_fixture(name, also, raw, yml):
    with open(raw, encoding="utf-8") as f:
        text = f.read()
    with open(yml, encoding="utf-8") as f:
        expected = yaml.safe_load(f)["parsed_sample"]
    rows = parse(f"textfsm:{name}", text, [f"textfsm:{a}" for a in also])
    assert rows == expected
