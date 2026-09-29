#!/usr/bin/env bash
# Refresh resources/templates from an ntc-templates checkout (LT-509).
#
#   scripts/vendor-ntc.sh /path/to/ntc-templates
#
# Copies every template and the index, the LICENSE, and the test fixtures
# for the platforms the catalogs name. Then rerun
# `node scripts/reconcile-ntc.mjs` and update resources/templates/NOTICE
# with the new version and commit.
set -euo pipefail
src="${1:?path to an ntc-templates checkout}"
here="$(cd "$(dirname "$0")/.." && pwd)"
dst="$here/resources/templates"
keep="cisco_ios cisco_xe cisco_nxos cisco_xr arista_eos juniper_junos fortinet paloalto_panos aruba_aoscx hp_procurve aruba_os cisco_asa cisco_ftd cisco_wlc_ssh huawei_vrp hp_comware mikrotik_routeros dell_os10 extreme_exos ruckus_fastiron ubiquiti_edgeswitch ubiquiti_edgerouter linux"

rm -rf "$dst/ntc" "$dst/tests"
mkdir -p "$dst/ntc" "$dst/tests"
cp "$src"/ntc_templates/templates/*.textfsm "$src"/ntc_templates/templates/index "$dst/ntc/"
cp "$src/LICENSE" "$dst/LICENSE"
for p in $keep; do
  [ -d "$src/tests/$p" ] && cp -r "$src/tests/$p" "$dst/tests/$p"
done
find "$dst/tests" -name '__init__.py' -delete
find "$dst/tests" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
node "$here/scripts/prune-ntc-tests.mjs"
echo "ntc-templates $(grep '^version' "$src/pyproject.toml") at $(git -C "$src" log -1 --format='%H %cd')"
echo "templates: $(ls "$dst/ntc" | wc -l), fixtures: $(find "$dst/tests" -name '*.raw' | wc -l)"
