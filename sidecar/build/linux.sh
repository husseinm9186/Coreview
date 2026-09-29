#!/usr/bin/env bash
# Lay the sidecar under src-tauri/sidecar/ for the Linux bundles (LT-513).
#
#   sidecar/build/linux.sh [python3.12]
#
# A relocatable venv is not a thing, so this uses `python -m venv --copies`
# and the pinned, hashed requirements; the bundle carries the interpreter
# it was built with. AppImage/.deb builds run this before `tauri build`.
set -euo pipefail
py="${1:-python3}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/src-tauri/sidecar"
rm -rf "$out"
"$py" -m venv --copies "$out"
"$out/bin/pip" install --quiet --require-hashes -r "$root/sidecar/requirements.txt"
"$out/bin/pip" uninstall -y -q pip setuptools wheel >/dev/null 2>&1 || true
cp -r "$root/sidecar/coreview_sidecar" "$out/coreview_sidecar"
find "$out" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
echo "sidecar laid under $out ($("$out/bin/python" --version))"
