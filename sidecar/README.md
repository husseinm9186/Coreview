# The collector sidecar (Phase 1 of D-060)

A temporary bridge. scrapli drives the SSH session and TextFSM reads the
answers with the templates vendored under `resources/templates/ntc`;
Rust owns the catalog, the plan, the tables, the graph and the screen.
Phase 2 builds the TextFSM engine in Rust, Phase 3 runs both in shadow,
Phase 4 deletes this directory.

## What it will never do

- write a file, anywhere — raw replies go back to Rust inline, and Rust
  writes them redacted under the run's diagnostic folder (D-055, LT-481)
- take a secret from argv, the environment or a file — only from stdin,
  and it never echoes one back
- send a command the read-only allowlist refuses (`allowlist.py`, the
  same rule as Rust and the reconciliation script, pinned by
  `resources/catalog/allowlist-cases.json`), even when asked
- send a session step outside the vocabulary in `session.py`
  (`SESSION_STEP`): paging, console mode, context switches, `enable`,
  `exit` — the only place a `config` word may appear, and only as one of
  those literals from the catalog's `session:` block
- open anything but SSH to the host Rust named

## Protocol

JSON lines over stdin/stdout; `protocol.py` is the contract and has an
example of every message. `hello` names the templates directory and
answers with versions; `open` starts a session (the catalog's `session:`
block travels as `session_spec`, and the response lists the VDOMs,
contexts or vsys found); `run` sends one command and answers rows, the
raw text, a status and a duration; `switch` changes context; `parse`
reads raw text with no device at all, which is how offline import and
replay work; `close` and `quit` do what they say.

## Running the tests

```
python3 -m venv .venv
.venv/bin/pip install --require-hashes -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m pytest
```

`test_parse_fixtures.py` runs every template the catalogs name over
ntc-templates' own `.raw`/`.yml` pairs under `resources/templates/tests`
— several hundred captures — and is the set the Phase-2 Rust engine must
pass in full.

## Packaging (Windows)

`build/windows.ps1` lays an embeddable CPython and the pinned
site-packages under `src-tauri/sidecar/`, which `tauri.conf.json` ships
as a resource — a folder, spawned by absolute path from the install
directory, never from `%TEMP%`, no self-extracting archive, no UPX.
Every PE inside is signed by the release workflow's `signCommand`.
`build/linux.sh` does the same with a venv for the Linux bundles.
