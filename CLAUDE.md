# Coreview

A local-first desktop app for network engineers: draw a topology, point it at
real addresses, and watch the links while you work. Tauri 2 + React + TypeScript
+ Vite on the front, Rust behind. Everything stays on the machine — no account,
no telemetry, nothing phoned home. Nothing leaves the machine unless the
operator asked for that particular thing: the one integration with a vendor's
cloud, Meraki's Dashboard API, is read-only, started by hand, and keyed on his
own credentials (D-056).

## Standing rules

**Read these first, every session, before doing anything else:**
`docs/ROADMAP.md`, `docs/DECISIONS.md`, `docs/OPEN-QUESTIONS.md`. New here?
`docs/HANDOVER.md` is the map and the minefield — read it once, in full. Then summarise
the **Now** and **Blocked** sections back in three lines or fewer.

- **A new task goes into `docs/ROADMAP.md` before the work starts.** Several
  things in one message become several items. Never merge them.
- **Never renumber an ID. Never delete an item.** It moves to Done or Icebox
  with a reason.
- **If a task conflicts with a logged decision, say so and cite the D-ID**
  rather than silently doing the new thing.
- **When a task is finished, move it to Done with the date**, and say what
  actually shipped if it differs from the acceptance criteria.
- **Something mentioned in passing goes in Icebox**, not in the bin.
- **Never mark something Done without having run it.** "It compiles" is not
  "it works"; say which one you mean.
- **A bug is reproduced before it is fixed** (D-020): a reported bug gets its
  own roadmap item and a test that fails without the fix, then the fix. The
  standing bar is LT-029 and the open list lives there.
- **Commit roadmap and decision changes in the same commit as the code they
  describe.**
- At the end of a session, or whenever asked to **checkpoint**, update all three
  docs and show the diff.
- "Where are we" and "what's left" are answered from `docs/ROADMAP.md`, not
  from whatever is still in context.

## How the work is done here

- No stubs, no mocks, no "TODO: implement". If something cannot work, say so
  plainly and stop.
- Converted vendor stencils are committed under `stencils/` (D-019). Secrets
  never are (D-006). The application itself still ships no third-party artwork.
- A failing test is not fixed by weakening the test.
- Prefer editing an existing file to rewriting it.
- `crates/coreview-probe` is Tauri-free on purpose.
- Parsers are written against captured output from real hardware, not against
  documentation. `crates/coreview-discover/examples/try_commands.rs` and
  `raw_login.rs` are for capturing it, and `interactive_shell.rs` drives the
  terminal's own `ssh::Shell` against a device the way a person would — it is
  what earned LT-320–325 the right to say they have met hardware.
  **One exception, and it is recorded:**
  the stacking parsers were built from vendor guides at the operator's
  instruction (D-026), and the VRF and VXLAN/EVPN parsers the same way
  (D-051) — `examples/probe_overlay.rs` is what earns those. Each says so in its own doc comment and reports
  `verified_against_hardware() == false` until it has met a device;
  `examples/probe_stack.rs` is how that gets earned. **D-058 widened the
  exception** to the vendor dialects of 2026-09-26 (Junos, Arista, PAN-OS,
  ASA, Gaia, Comware, Huawei, RouterOS, EdgeOS/VyOS, wireless controllers,
  Cumulus, SONiC) and the measured-path features: built from documentation,
  each unverified until the operator's **support capture** — the "Keep a
  diagnostic of this run" tick on a crawl (LT-481, LT-499) — replaces its
  fixtures. A fixture reconstructed from documentation says so in its test.
- **A test fixture is never a plausible credential.** Obviously fake strings
  only — a real device password was once used as a sample secret and ended up
  in the repository's history (LT-137).
- **No customer data, ever, in the repo or the app** (D-027). This tool is
  given away to engineers. A customer's names, addresses, hostnames,
  interfaces, command lists, procedures or diagrams never reach a commit, and
  never become a default, placeholder, preset, template, example or fixture.
  A planning document the operator shares stays on his machine; features are
  described from it in generic terms. Check the staged diff for it before
  every commit.

## Licence

Coreview is **free to use and free to pass on**, and is not open source —
`LICENSE` at the root, by Mohammed Almoola. Anyone may give the installer to
anyone, unchanged and never for a fee; selling, modifying, rebranding and
derivative works are reserved. **No trademark is claimed on the name** (LT-313):
never write `Coreview™`. The source is public so that anyone pointing it at a
network can check what it does. Three things follow, and none is optional:

- **Dependency notices still ship, in full.** MIT and Apache-2.0 require the
  licence *text* to travel with the binary, not a list of names.
  `THIRD-PARTY-NOTICES.md` is generated by
  `node scripts/third-party-notices.mjs` and installed beside the application
  by `bundle.resources`. Run the generator when dependencies change; it refuses
  to write the file if a GPL/AGPL/SSPL component ever appears, and
  `licensing.test.ts` fails the build if the notices or the manifests drift.
- **No manifest may declare a different licence.** All three Cargo manifests and
  `package.json` say `LicenseRef-Almoola-Free-Proprietary`; `coreview-probe` once
  said MIT, which is how that goes wrong.

## Layout

```
src/                 React front end
  components/        Canvas, palette, inspector, panels; RegisterScreen is the
                     address register, which is a screen rather than a panel
  lib/               Pure logic, all unit-tested — routing, layout, diffing,
                     tinting, clipboard, paper, stencil-adjacent helpers
  state/store.ts     Zustand store; the document lives here
  i18n/              Translatable text: the English catalogue and t() (LT-272)
  theme.ts           Every colour the canvas paints with, per ground
  styles.css         Every colour the chrome paints with, as CSS variables
crates/
  coreview-discover  Crawling: SSH, telnet, CDP, LLDP, FortiOS, SNMP, ARP,
                     stacking and virtual chassis, the default route; and
                     `ssh::Shell`, the interactive session behind the
                     terminal (LT-320), and `sessionlog` (LT-324)
  coreview-probe     ICMP/TCP/DNS probing and the ping sweep's identification
                     (names over LLMNR/NetBIOS/mDNS, MAC, OUI, ports); no Tauri
  coreview-meraki    The Meraki Dashboard API, read-only and GET-only, to one
                     named host family (LT-404, D-056, D-057). Meraki has no
                     CLI, so this is the only way to see such an estate from
                     the inside.
  coreview-catalog   The discovery catalog (D-060, LT-512): loads
                     `resources/catalog/<os>.yaml`, evaluates gates, builds
                     the collection plan, holds the read-only allowlist. No
                     Tauri, no network.
  coreview-collect   The collector (LT-514): fingerprint, capabilities, the
                     run through the sidecar (`sidecar.rs` is the JSON-lines
                     client), secret scrubbing, rows into the discovery
                     tables, and the API collectors (FortiOS REST, PAN-OS
                     XML API, AOS-CX REST) with the certificate pinned per
                     device. `examples/fake_sidecar.rs` is what its tests
                     drive, so `cargo test` needs no Python. `readers/` holds
                     Coreview's own readers for output no template reads
                     (`parser: reader:<name>`, LT-540) — built from vendor
                     documentation under D-058 and saying so.
  coreview-topology  P2's builder (LT-527): a collection run's tables in, one
                     graph out — identity by serial/MAC, links with confidence
                     and evidence, bundles, stacks, MAC placement, layer 3,
                     overlays — and `crawl_view`, the crawl-result shape the
                     review screen and diagram already draw.
  coreview-path      P3's builder (LT-531–LT-535, D-061): a run's tables and
                     graph in, the path out — policy routes, LPM per VRF,
                     ECMP, recursion, FHRP/ARP/MAC to device, switches
                     between routers, firewall NAT and policy per vendor,
                     the way back, what-if, verify against a traceroute.
                     `fixtures/` is its real output, which the page's tests
                     read. Live checks are `coreview-collect/src/live.rs`.
resources/
  catalog/           One YAML per OS — fingerprint, `session:` block (from
                     scrapli and netmiko, see its NOTICE), capability probes,
                     gated commands with parser, tables, weight and
                     `verified: lab|docs|unverified`. `schema.json` is its
                     shape; `allowlist-cases.json` pins the allowlist's three
                     implementations to one fixture.
  templates/         ntc-templates vendored whole (Apache-2.0, LICENSE and
                     NOTICE beside it) with the test fixtures for every
                     template a catalog names — the sidecar's parse tests
                     and the Phase-2 Rust engine's conformance set (LT-509).
sidecar/             The Phase-1 bridge (LT-513): scrapli + TextFSM over JSON
                     lines on stdio. Never writes a file, never takes a
                     secret except on stdin, refuses what the allowlist
                     refuses. Phase 4 deletes it. `README.md` there.
src-tauri/           Commands, SQLite, credential vault, icon library scan;
                     `collection.rs` + `collection_db.rs` are the catalog-driven
                     collection's commands and schema 6 (LT-514–LT-517);
                     `terminal.rs` holds the live SSH sessions, which belong
                     to the window and are never written down (D-047), and
                     launches an external client without the password (D-048)
  fixtures/ipc/      One payload per structured command input, written from
                     src/lib/ipcPayloads.ts and read by the Rust contract test
isolation/           The sandboxed frame every IPC message passes (LT-258);
                     its command table is checked against src-tauri
scripts/             Stencil and shape import, run by hand; and the catalog's
                     tooling — `reconcile-ntc.mjs` (spec ↔ ntc index, LT-508),
                     `extract-sessions.py` (scrapli drivers → sessions.json),
                     `build-catalog.mjs` (the one-time bootstrap of the YAML),
                     `vendor-ntc.sh` + `prune-ntc-tests.mjs`, `allowlist.mjs`
e2e/                 Playwright harnesses driving the real app
docs/                ROADMAP, DECISIONS, OPEN-QUESTIONS, and the rest
```

## Checks

```
npx tsc --noEmit
npx eslint src --ext .ts,.tsx
npx vitest run
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd sidecar && python -m venv .venv && .venv/bin/pip install --require-hashes -r requirements.txt -r requirements-dev.txt && .venv/bin/python -m pytest
                       # the sidecar: allowlist, protocol, and every ntc fixture the catalogs name (LT-509, LT-513)
npm run dev            # then, in another terminal:
node e2e/interact.mjs     # ~280 interaction checks
node e2e/change.mjs       # the change report, against a stubbed backend
node e2e/library.mjs      # the icon library, against a stubbed backend
node e2e/discover.mjs     # the ping sweep panel, with real captured rows
node e2e/join.mjs         # sweep and crawl building one diagram (LT-126)
node e2e/scansettings.mjs # a scan is remembered; no secret is (LT-135)
node e2e/showcommands.mjs # show commands, command sets, file names (LT-149–151)
node e2e/beforeafter.mjs  # two backup runs compared per device and command (LT-152)
node e2e/canvasfix.mjs    # moving a link's end; space-drag panning (LT-157, LT-158)
node e2e/glyphjumps.mjs   # stacked glyph, HA checkbox, hops on curves (LT-159–161)
node e2e/shapes.mjs       # built-in class shapes, ports and rack units (LT-163–171)
node e2e/viewing.mjs      # zoom to selection, saved views, presenting, minimap health (LT-191–193)
node e2e/history.mjs      # 200 undo steps that survive reopening (LT-185)
node e2e/arrange.mjs      # stacking order, lasso, snapping and the rest of Phase 1.2
node e2e/pages.mjs         # the page navigator, layers, paste in place, templates
node e2e/racks.mjs         # rack elevations front and rear, the cable schedule
node e2e/crawling.mjs      # seeds, limits, live table, bindings, findings, review (Phase 2)
node e2e/validation.mjs    # new probe kinds, templates, history, path check, compare (Phase 3)
node e2e/workflow.mjs      # palette, filter, focus, ink, comments, keyboard, contrast (Phase 4)
node e2e/importing.mjs     # every import and export format (Phase 5)
node e2e/reporting.mjs     # the PDF report and its templates (Phase 6)
node e2e/security.mjs      # strict IPC payloads, rate limits, keychain, credential use log (Phase 7)
node e2e/endtoend.mjs      # import → crawl → review → validate → export → report, one session (LT-268)
node e2e/guide.mjs         # the guided sample and its tour (LT-271)
node e2e/ipam.mjs          # the address register: subnets, ranges, records, editing (LT-285–297)
node e2e/ipamlab.mjs      # the register's screen: hierarchy, allocation, split/merge, history (LT-297, LT-300)
node e2e/credentials.mjs  # a device's own login: saved encrypted, never in the document (LT-318)
node e2e/ssh.mjs          # shells in the panel: tabs, colour, font, log, keepalive (LT-320–325)
node e2e/pathtrace.mjs    # where a packet would go; the application page it draws (LT-346, LT-348)
node e2e/whereis.mjs      # where a thing is, from what the crawl found (LT-338)
node e2e/checks.mjs       # pass/fail checks against a run's captures (LT-153)
node e2e/groups.mjs       # ordered collection groups, pauses and stops (LT-154)
node e2e/meraki.mjs       # the Meraki tab: customers, networks, backup, health check (LT-404–406)
node e2e/drawer.mjs       # the details drawer: device and finding, pinned, keyboard (LT-444)
node e2e/folders.mjs      # folders and sub-folders on the project screen (LT-485)
node e2e/foldersettings.mjs # a project's backup and export folders, chosen where they can be kept (LT-487)
node e2e/tracert.mjs      # the Tracert tab: from here or a device, hops named, a page from them (LT-505)
node e2e/collection.mjs   # the Collect tab: plan preview, command log, shadow report, topology and its hand-over to review (LT-517, LT-521, LT-527)
node e2e/collectedpath.mjs # Path-Trace over a collection run: the Rust builder's path, verdicts, way back, verify, live, exports (LT-531–LT-536)
```

Canvas performance is measured, not asserted (LT-190), against a **production**
build — the dev server's React checks swamp the numbers:

```
npx vite build --outDir /tmp/cv-dist && npx vite preview --outDir /tmp/cv-dist --port 4174
CV_URL=http://localhost:4174/ SIZES=1000,5000 node e2e/bench-canvas.mjs
```

The e2e harnesses drive a real browser because WebKitGTK plus xdotool cannot
deliver modifier-clicks, HTML5 drags or the pointer sequences React Flow needs.
They are the only thing that catches a feature that compiles and does nothing.

## Strings

Text a person reads is moving into `src/i18n/en.ts` and is shown with
`t('key', { name })` (LT-272). English is the complete catalogue; another
language supplies what it can and falls back to English. Plurals are an object of
`Intl.PluralRules` forms (`one`, `other`, …), never `count === 1 ? … : …`. New
components use `t()`; `src/i18n/index.test.ts` fails on a key used but missing.

## Colour

The chrome is dark, always — the ground toggle moves only the canvas (LT-046,
superseding LT-034's light chrome): white page on a warm light-brown desk, or
the dark desk. Canvas colours are in `src/theme.ts` per ground; chrome colours
are CSS variables in `src/styles.css`, where colour lives in `:root`,
`.is-light` (canvas tokens only), the high-contrast pair `.is-contrast` and
`.is-contrast.is-light` (LT-242), and `@media print`.
Canvas elements read the ground tokens (`--ink`, `--page`, `--desk`,
`--canvas-accent`); chrome elements read the chrome ones. Do not point one at
the other's set — only one of them flips. **`src/lib/groundTokens.test.ts`
enforces this** by parsing the stylesheet: a chrome rule reading a ground token
fails the build. It was a written rule for months and drifted anyway — `.cv-app`
itself was inheriting `--ink` to the whole interface, which is what LT-315
was.

**`:root` declares `color-scheme: dark`, and that line is load-bearing**
(LT-328). Some controls are drawn by the engine, not by us — the scrollbars, a
number field's spinners, and the reveal eye inside a password field, which
WebView2 draws as `::-ms-reveal`. A page that declares no scheme is assumed to
be light and all of them come out dark on this app's dark chrome, which no rule
of ours can reach. `src/lib/nativeControls.test.ts` holds it, and `@media print`
sets `light` because paper is light whatever the screen is doing.
