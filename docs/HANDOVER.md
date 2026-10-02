# Handover

Everything a new pair of hands needs to pick this up and carry on. Read
`CLAUDE.md` for the standing rules and `docs/ROADMAP.md` for what is owed;
this file is the map and the minefield.

---

## 1. What this is

**Coreview** — a local-first desktop app for network engineers. You draw a
topology, point it at real addresses, and watch the links while you work. It
also crawls a network over SSH and draws itself.

Nothing leaves the machine. No account, no telemetry, no cloud, no agent on the
device. It reads what is already there over protocols a network engineer
already allows, and it does not write configuration — a tool that can also
change things is a different tool with a different risk profile.

The operator is a working network engineer with real hardware on his desk.
He tests against it. Things that "compile" get found out within the hour.

**The bar he set:** better than Lucidchart and Visio at drawing, without giving
up the half neither of them has — a diagram pointed at real addresses that
watches them.

---

## 2. Read these first, in this order

| File | What it is |
| --- | --- |
| `CLAUDE.md` | Standing rules. Non-negotiable. |
| `docs/ROADMAP.md` | Every request, with stable IDs. The answer to "what's left". |
| `docs/DECISIONS.md` | 62 decisions (and counting) with what was rejected and why. Append-only. |
| `docs/OPEN-QUESTIONS.md` | What is not yours to decide. |
| This file | The shape of the code and the traps in it. |

If a task conflicts with a logged decision, **say so and cite the D-ID**. Do
not quietly do the new thing. Several requests in one message become several
roadmap items — never one merged item.

---

## 3. The shape of the code

~95,000 lines. TypeScript front, Rust back, Tauri 2 between.

```
src/
  lib/            ~130 modules of pure logic. This is where the thinking lives.
                  Every one is unit-tested and none of them touch React.
                  routeLinks, alignment, lineJumps, collapse, zones, layers,
                  tinting, clipboard, paper, topology, topologyDiff, diagram,
                  statusHistory, bulkEdit, csv, subnetGroups, tidyLayout,
                  findNodes, linkStyle, paletteDrop, probes, exports, samples…
  components/     React. Canvas, palette, inspector, panels, node and edge
                  renderers. Thin — they call into lib/.
  state/store.ts  Zustand. The document lives here: nodes, edges, probes,
                  canvas settings. Undo/redo is snapshot-based.
  theme.ts        Every colour the canvas paints with, for both grounds.
  styles.css      Every colour the chrome paints with. Three token blocks.
crates/
  coreview-discover  The classic crawler. SSH (russh), telnet, CDP, LLDP,
                     FortiOS, SNMP, ARP, MAC tables, OUI lookup. 600+ tests.
  coreview-probe     ICMP/TCP/DNS probing. Tauri-free on purpose.
  coreview-meraki    The Meraki Dashboard API, read-only (D-056).
  coreview-catalog   The discovery catalog: YAML in, plan and allowlist out.
  coreview-collect   The collector: sidecar client, readers, follow, REST.
  coreview-topology  P2: tables in, graph out, and the review's view of it.
  coreview-path      P3: where a packet goes, with firewall verdicts.
  coreview-formats   Import and export formats.
sidecar/          The Python bridge the collector drives (scrapli, TextFSM).
src-tauri/        Commands, SQLite, the credential vault, icon library scan.
scripts/          Stencil/shape importers, the catalog's tooling, and
                  revert-point.sh. Run by hand, not by the app.
e2e/              Playwright harnesses that drive the real app — the list in
                  CLAUDE.md is the one kept current.
```

**The pattern that matters:** anything with logic in it goes in `src/lib/` as a
pure function with tests, and the component calls it. `routeLinks.ts` decides
which side a link leaves from; `LiveEdge.tsx` just draws what it is told. When
you are about to put a decision inside a component, don't.

---

## 4. Running and verifying

```bash
npx tsc --noEmit
npx eslint src --ext .ts,.tsx
npx vitest run                                    # ~1,400 tests
cargo test --workspace                            # ~1,000 tests
cargo clippy --workspace --all-targets -- -D warnings

npm run dev                                       # then, in another terminal:
node e2e/interact.mjs                             # ~280 checks, the big one
node e2e/change.mjs                               # change report, stubbed backend
node e2e/library.mjs                              # icon library, stubbed backend
node e2e/discover.mjs                             # ping sweep, real captured rows
node e2e/join.mjs                                 # sweep + crawl -> one diagram
node e2e/scansettings.mjs                         # settings kept, secrets not
node e2e/showcommands.mjs                         # show commands, command sets, file names
node e2e/beforeafter.mjs                          # two backup runs compared, per command
node e2e/canvasfix.mjs                            # moving a link's end, space-drag panning
node e2e/glyphjumps.mjs                           # stacked glyph, HA checkbox, hops on curved links
node e2e/shapes.mjs                               # built-in class shapes, ports, rack units
node e2e/viewing.mjs                              # zoom to selection, saved views, presenting, minimap
node e2e/history.mjs                              # 200 undo steps, kept after reopening
node e2e/arrange.mjs                              # stacking, lasso, snapping (Phase 1.2)
node e2e/pages.mjs                                 # page navigator, layers, paste in place, templates
node e2e/racks.mjs                                 # rack elevations, cable schedule
node e2e/dock.mjs                                  # grouped tabs, job strip, pop out (LT-676)
node e2e/inspector.mjs                             # the device inspector's tabs and action row (LT-677)
node e2e/discovermode.mjs                          # Discover's four steps, Advanced, the old Collect tab (LT-678)
node e2e/crawling.mjs                              # Phase 2 crawl: live table, bindings, review
node e2e/validation.mjs                            # Phase 3: probes, history, path check, compare
node e2e/workflow.mjs                              # Phase 4: palette, filter, ink, comments, a11y
node e2e/importing.mjs                             # Phase 5: imports and exports
node e2e/reporting.mjs                             # Phase 6: PDF report and templates
node e2e/security.mjs                              # Phase 7: payloads, limits, keychain, use log
node e2e/endtoend.mjs                              # LT-268: the whole workflow in one session
node e2e/guide.mjs                                 # LT-271: the guided tour
node e2e/checks.mjs                                # pass/fail checks against a run
node e2e/groups.mjs                                # ordered collection groups
```

`cargo` may not be on `PATH`: `export PATH="$HOME/.cargo/bin:$PATH"`.

### Why the e2e harnesses exist

The Tauri build renders in WebKitGTK, and synthetic input through xdotool
cannot deliver modifier-clicks, Shift-drag, HTML5 drag-and-drop, or the pointer
sequences React Flow's resizer and connection handles need. Those cases sat
untested for that reason. The frontend is the same code in Chromium, so
Playwright drives it there.

They are the only thing that catches **a feature that compiles and does
nothing**, which on this project is the dominant failure mode. Several
features have shipped, passed type-checking and unit tests, and been silently
inert until an e2e check was written for them.

`change.mjs` and `library.mjs` stub `window.__TAURI_INTERNALS__` so the desktop
paths can be driven in a browser. Everything above the stub is the real app.

**The two Python scripts in `e2e/` are tools, not debris:** `install_icons.py`
names and installs a converted icon set, and `make_case20.py` builds the
TEST_PLAN case-20 project straight into the SQLite store. Both are run by hand
and documented where they are used.

---

## 5. What "done" means here

- **No stubs, no mocks, no "TODO: implement".** If something cannot work, say
  so plainly and stop. Do not fake it.
- **Never fix a failing test by weakening the test.** If the test is wrong,
  say why it is wrong and fix the assertion to be *stronger*, not looser.
- **Reproduce a bug before fixing it** (D-020): a test that fails without the
  fix comes first.
- **Distinguish "I compiled it" from "I ran it and watched it work."** Say
  which one you mean, every time.
- **Verify by measuring, not by looking.** Screenshots are for judging design;
  assertions are for judging behaviour. Several bugs here looked fine in a
  screenshot.
- Commit after each piece of work with a real message. Roadmap and decision
  changes go in the same commit as the code they describe.
- Before a push run `scripts/revert-point.sh` (LT-602): a bundle of every
  branch and a tar of the tree go under `~/coreview-backups/` (or
  `$COREVIEW_BACKUPS`), named by date and commit; restore with
  `git clone <name>.bundle`.

### The commit style

Prose, not bullet points. Say what was wrong, what it does now, and why the
obvious alternative was rejected. A reader six months out should learn
something from it. Look at `git log` — that is the register to match.

---

## 6. Traps that have actually bitten

This is the part worth reading twice. Every one of these cost real time.

### 6.1 Tests that pass for the wrong reason

The single most common failure here.

- **Two grouping checks passed because nothing could move at all.** A lock test
  earlier in the file locked a node and never unlocked it; "the gap did not
  change" is true both when a companion follows its group and when nothing
  moves. Fix: assert the thing *moved* first, using a third uninvolved node as
  a witness to distinguish a node drag from a canvas pan.
- **A check that skips itself is not a check.** `if (await x.count()) { …five
  assertions… }` reports success when the locator finds nothing. Assert the
  precondition, then act on it.
- **A test asserted the broken behaviour.** It encoded the bug as expected
  output. When a test fails, decide which one is wrong before changing either.
- **Verify a new test fails without the fix.** Temporarily break the code and
  watch it go red. Done here for link routing and it caught a no-op assertion.

### 6.2 React Flow

- **DOM order is not stable.** Selecting or dragging a node moves it in the
  document for z-order. `nth(0)` before and after an interaction are different
  elements. Address nodes by label, edges by `data-id`.
- **The centre of an edge's bounding box is usually empty space.** An L-shaped
  path passes nowhere near it. To click or hover "the edge", parse its `d`,
  take a real point on the line, and map it through the viewport transform.
- **It sets `pointer-events` on nodes inline.** No stylesheet can override it.
  If you need nodes inert, use the API or an overlay.
- **It does not forward a double-click on the pane.** A React handler above it
  never fires. Use a native listener in the capture phase.
- **A `sourceHandle` is looked up only among *source* handles**, even in loose
  connection mode. Only the target side searches both. That is why all four
  sides are declared as sources.
- **Correcting a node position from `onNodeDrag` does not hold** — the next
  drag event overwrites it. Rewrite the change as it passes through
  `onNodesChange`, and include the final change, which arrives with `dragging`
  already false.
- **`onlyRenderVisibleElements` makes dragging three times worse.** Measured.
  See D-010. Do not try it again.

### 6.2b WebKitGTK, where the app actually runs

- **A right-button press is claimed for a context menu, and the element gets
  nothing after it.** No `pointermove`, no `pointerup`, not even with the
  pointer captured. Chromium delivers the whole sequence, so a Playwright
  harness is *green* while the real app does nothing — which is exactly what
  LT-287 was. If a drag has to work with the right button: refuse the press
  (`contextmenu` **and** `mousedown`), listen on the **window** rather than the
  element, and hear the mouse pair as well as the pointer pair. Set positions
  from the absolute distance travelled so hearing a movement twice is harmless.
- **This class of bug cannot be caught in Chromium at all.** Verify it in the
  real app under Xvfb by screenshot comparison (6.7): a pan that works moves
  hundreds of thousands of pixels, one that does not moves a few hundred.

### 6.3 Rust and serde

- **An internally-tagged enum cannot represent a newtype variant holding a
  String.** It compiles and fails at runtime. Use adjacent tagging
  (`content = "value"`).
- **The document is stored as `serde_json::Value` and must stay that way**
  (D-002). A typed struct would silently drop every field the frontend adds
  afterwards.
- **A serde enum with named fields needs `rename_all_fields = "camelCase"`.**
  `rename_all` renames only the variants; `CollectionEvent` reached the page
  as `run_id` and the Discover panel ignored every event (LT-595). The browser
  harnesses stub camelCase, so they stayed green — a Rust test in
  `collection.rs` serialises every event and fails on a snake_case key.
- **`-D warnings` in CI.** An import used only by a `cfg`-gated test is an
  unused import on other platforms. Windows CI went red for a day over this.
- **A new command is three edits, and the tests say which you forgot**
  (D-033). Register it in `main.rs`; add it to `isolation/rules.js` with its
  argument names in camelCase (`isolationRules.test.ts` fails otherwise, and the
  running app refuses the call with "Coreview has no command called …"); and if
  it takes a struct, give the struct `deny_unknown_fields`, build its payload in
  `src/lib/ipcPayloads.ts`, and add a fixture both sides test
  (`UPDATE_IPC_FIXTURES=1 npx vitest run src/lib/ipcPayloads.test.ts`).

### 6.4 SVG

- **An eight-digit hex is not a colour in SVG 1.1.** Renderers fall back to
  black. Use `fill-opacity`. This drew sections as solid slabs over their
  contents.
- **A marker referenced but not defined draws nothing, silently.** Assert that
  an arrowhead is both referenced *and* present.
- **A marker in a shared `<defs>` cannot see the colour of the path using it.**
  Per-link markers are why a link can carry its own colour.

### 6.5 CSS

- **A class name can already mean something.** `.cv-guide` was the alignment
  guides' class, with `pointer-events: none`; a new panel given the same name
  drew perfectly and ignored every click (LT-271). Grep `styles.css` before
  naming one.

- **`var()` resolves where it is used.** Nodes inherited colour from `body`,
  which sits outside the element carrying the theme class, so every node stayed
  dark-theme coloured on a white ground. Colour and background belong on the
  themed root.
- **Invisible is not untouchable.** `opacity: 0` keeps the hit area. Hidden
  connection handles were swallowing clicks meant for neighbouring devices.
- **A variable that does not exist falls through to its fallback silently.**
  Three rules read `--cv-text-dim`, `--cv-warn` and `--cv-accent`, none of
  which have ever been defined here.

### 6.6 Playwright

- **One dev server, and no edits while a run is in flight.** Three zombie
  vites once watched the tree at the same time, pushing stale full-reloads
  into the page mid-run; and editing an app file seconds before a run lets
  HMR reload the page under the harness. Both produced deterministic-looking
  failures in blocks nobody had touched, and poisoned two bisects before the
  cause was found. `pgrep -f vite` before you trust a red run.
- Long runs occasionally suffer an environmental page reload. The recovery
  banner then appears — correctly — and shifts the canvas down 34px, breaking
  every screen measurement taken before it. The harness dismisses it before
  measuring; keep doing that in new blocks.

- The bottom panel overlaps the canvas. A node placed low is under it and a
  pointer-down aimed at it hits the panel.
- A context menu that runs off the bottom of the window has unreachable items.
  Fixed in the app, but it is the kind of thing to watch for.
- Where a node lands relative to the pointer depends on the zoom. Do not
  predict it — move, measure, correct, then release.
- **A fixed window coordinate is a bet on the layout.** `canvasfix.mjs`
  clicked (1400, 80) to put the selection down; that was the old two-row
  top bar's empty second row, and after LT-675's one-row bar it was the
  inspector's first field label — which focused the input and took Ctrl+Z,
  Space and `f` with it, three failures with no obvious link to the change.
  Click a measured bare spot on the pane (`bareSpot()` there) instead. And
  nothing may float over the pane's top-left band: the lassos, drops and
  pane clicks the harnesses make start there, which is why the canvas
  toolbar is docked above the pane rather than on it.
- **A device's inspector is tabbed (LT-677).** A field is under Status,
  Identity, Ports, Checks or Notes, and a locator for it finds nothing until
  that tab is pressed. The tab holds across selections, so one
  `inspectorTab("Identity")` early in a block is enough; `inspector.mjs`
  says which tab holds what.

### 6.7 Verifying the desktop app by hand under Xvfb

- **Launching the raw `target/debug/coreview` binary loads the stale bundled
  `dist/`, not your edits.** `devUrl` in `tauri.conf.json` is not consulted
  just because the build is a debug build — only `tauri dev`'s own
  orchestration (its `beforeDevCommand`, then a `cargo run` it launches
  itself) wires the running app to the Vite dev server on `:5173`. A plain
  `cargo build` + direct launch renders whatever `npm run build` last put in
  `dist/`, silently and without error — the app looks fine, just wrong,
  which is worse than a crash. If a feature you just wrote is not in a probe
  type dropdown that the source clearly has, check `dist/`'s mtime before
  suspecting the code. Always drive manual verification through
  `xvfb-run -a npm run tauri dev` (with `PATH="$HOME/.cargo/bin:$PATH"` — see
  §4), never the bare binary.
- The WebKitGTK window can take several seconds to map after the process
  starts (compiling probe/discover crates first); a screenshot taken too
  early is just the Xvfb root background, not a bug. Poll `xwininfo -root
  -tree` for a `"Coreview"` child window near your target size before
  screenshotting.
- **`import -window root` on the Xvfb display is black** even when the app has
  drawn. Take the window itself: `import -window $(xdotool search --name
  "^Coreview$" | tail -1) out.png`. Set `LOCALAPPDATA` to a scratch folder so the
  run gets its own database.
- **`pkill -f target/debug/coreview` kills the shell running it**, because the
  pattern is in that shell's own command line. Kill by `pgrep -x coreview`.

### 6.8 The macOS build says the app is "damaged". It is not.

The `.dmg` from CI (LT-106) is **unsigned and un-notarised** — there is no
Apple Developer certificate configured, the way there is for Windows. macOS
attaches a quarantine flag to anything downloaded from the internet, and for
an unsigned app Gatekeeper reports that as:

> "Coreview" is damaged and can't be opened. You should move it to the Bin.

That message is wrong in a specific and unhelpful way: nothing is damaged and
there is nothing to fix in the build. It is Gatekeeper refusing an app whose
developer it cannot verify. Clear the flag after dragging the app to
Applications:

```sh
xattr -dr com.apple.quarantine /Applications/Coreview.app
```

Right-click → Open (rather than double-clicking) works on some macOS versions
and not on others; the `xattr` line works on all of them, which is why it is
the one written here. The whole sequence — mount, copy, detach, clear the
flag, open — is written out in `README.md`, because the operator asked for it
twice and the second time he had lost it.

The real fix is an Apple Developer Program membership (~$99/year) plus
signing and notarisation in CI — the same shape as the existing
`.github/actions/sign-windows`. Worth doing before the app is handed to
anyone who did not build it; overkill while the operator is the only Mac
user.

**Nothing about the macOS bundle can be built or tested from this repo's
Linux development machine** — Tauri cannot cross-compile it and `.dmg`
creation needs `hdiutil`. Verification ends at "CI produced the artifact";
only a Mac can finish it.

---

## 7. The lab

Real hardware the operator tests against. **Credentials are his and are not in
this repository** — they live in the app's encrypted vault, and any that
appeared in conversation should be treated as compromised and rotated.

The addresses are the operator's and stay out of this file (D-027); the
roadmap items name what each box proved.

| Device | What it proved |
| --- | --- |
| Cisco C2960CX | CDP, LLDP, config backup, SNMP v2c and v3; the collector's IOS catalog (LT-558) |
| FortiSwitch 224E | FortiOS command set, chassis-id→ARP resolution; its own catalog and readers (LT-565) |
| FortiGate 60F 7.6.7 | `$` prompt, DHCP lease list, FortiLink, FortiAP LLDP; the collector over SSH and REST — policy, addresses, FQDN resolutions, managed switch and APs (LT-571, LT-578–LT-585, LT-596) |
| Ubiquiti USL8L | SNMP only; found via a FortiAP's LLDP |
| Palo Alto PA-220 | SNMP v2c identity; logs in over SSH (LT-600) — the box ends a second session with "Invalid user", still open |
| Aruba CX 6200F | Identity over SSH (LT-490); its own LLDP and MAC readings (LT-635) wait on his next crawl |
| Mellanox SN2010 ×2 | Named by the 6200's LLDP; OS not yet known (LT-649). Catalogs for all three it could run — Onyx, Cumulus NCLU, SONiC — built from documentation and waiting for it (LT-651, LT-652) |

**Parsers are written against captured output, never against documentation**
— with the exceptions CLAUDE.md records (D-026, D-051, D-058), each marked
in its own doc comment and `verified: docs` in the catalog until a capture
replaces its fixtures.
`crates/coreview-discover/examples/try_commands.rs` runs a list of commands
against a real device and reports which were understood;
`examples/raw_login.rs` dumps exactly what a device sends after login. Both
exist because guessing from docs produces a crawler that fails silently on
hardware nobody tested. `try_commands` takes `CV_PORT`, `CV_ENABLE`,
`CV_CONNECT` (seconds to wait for the SSH banner — a PA-220 took 15),
`CV_TIMEOUT` (seconds per command; a traceroute wants minutes) and
`CV_WATCH=1` (each chunk as it arrives, and what a timed-out command had
printed). `crates/coreview-path/examples/lab_run.rs` is the collector's
own run: `--user/--out` and hosts, `--follow <hops> [--subnet]`,
`--api-user` (key from `COREVIEW_LAB_API_KEY`, port from
`COREVIEW_LAB_API_PORT`), and `--replay <dir>` to reread an earlier run —
or the app's own `collection-<stamp>` diagnostic — through today's code
with no device and no password.

The biggest single win on this project came from `raw_login.rs`: a FortiGate
was completely unreachable because FortiOS ends its prompt in `$` for any
non-super_admin profile and the prompt finder only accepted `#` and `>`.

---

## 8. Where the work is

`docs/ROADMAP.md` is authoritative, and it was swept on 2026-09-12 so its
**Now** section is again a list of open work rather than a history. Do not
trust the summary below over that file; it is a signpost and it will rot.

- **The audit of 2026-09-25 (LT-423–LT-458)** shipped the same day, all but
  one: LT-453 (level of detail on the canvas) is built, off by default, and
  waits for a benchmark on a quiet machine — the run was stopped for memory,
  and D-031's protocol accepts nothing unmeasured. What it left behind, and
  where: `src-tauri/src/jobs.rs` (the job registry; a second crawl is
  refused, `coreview://job` carries progress), `timeline.rs` (changes across
  every kept crawl), `coreview-discover/src/dialect.rs` (one reading of the
  banner decides every command; the identity half of a visit is still in
  `crawl.rs`), `crates/coreview-formats` (the Visio, draw.io and Nmap
  readers, Tauri-free), `Drawer.tsx` and `JobsBar.tsx` on the page, and
  schema 3, under which a crawl is written device by device as it goes.
  Four guards were added beside `groundTokens.test.ts`:
  `asyncCommands.test.ts` (no I/O on the UI thread), `typeScale.test.ts`
  (font sizes are tokens), the dialect equivalence test, and the licence
  test now listing every crate. LT-124 and LT-125 are done.
- **26–28 September 2026, from the operator's own testing (LT-459–LT-506).**
  What landed, and where to look: **D-058** — dialects and path features may
  be built from vendor documentation, each saying `verified_against_hardware()
  == false` until a support capture replaces its fixtures; the families are
  one file each in `coreview-discover/src/` (`junos`, `arista`, `panos`,
  `asa`, `gaia`, `comware`, `huawei`, `routeros`, `vyatta`, `wlc`, `cumulus`,
  `sonic`, `arubacx`) and `dialect.rs` routes every command to them; the
  fake network (`tests/crawl_a_fake_network.rs`) has a Junos and a Cumulus
  and records every command each fake was asked. **D-059** — a saved login
  belongs to the project it was saved in, checked in Rust where each secret
  is opened (`vault_commands.rs`, `meraki.rs`), with `set_open_project` told
  by the store on every open, create and close. Folders on the project
  screen (schema 4, `db::project_folders`), owners on credentials (schema
  5). The support capture (`support.rs`) and the one diagnostic tick
  (LT-499). Path-Trace's measured half: `trace.rs` (device traceroute, ECMP
  hash), `policyroutes.rs`, `otv.rs`; the Tracert tab (`TracertPanel.tsx`).
  Twelve bugs from his screenshots and logs, each with a test that failed
  first — read their Done entries (LT-483/484/487/488/491/492/494/495/502)
  before touching the crawl review, the folder settings, the validation
  session events or the vault. **Still waiting on him:** LT-496 (a Nexus's
  ARP/MAC tables read empty; needs the capture) and LT-501 (a validation
  bug with no description yet).
- **Half done:** LT-139 the stacking parsers exist and have met no hardware ·
  LT-110 Visio import (the Lucidchart/geometric path has no `<Connect>` data
  at all).
- **Blocked on something outside this repository:** LT-138 needs a Windows
  install-upgrade-check cycle · LT-139 needs a real stack or VSX pair and
  `examples/probe_stack.rs` · LT-134 needs an `snmpwalk` of the FortiGate ·
  LT-136 needs the multi-chassis families to exist somewhere reachable.

- **29 September 2026, the discovery engine's first day (D-060, LT-507–LT-513).**
  The operator's specification is `docs/DISCOVERY-SPEC.md`; its
  architecture is a Python bridge now and a Rust collector as the end
  state, with the catalog as data. What exists: `resources/catalog/<os>.yaml`
  (twenty, built once by `scripts/build-catalog.mjs`, hand-maintained
  since — read one before touching the collector), `crates/coreview-catalog`
  (loader, gate evaluator, plan, allowlist; `load::problems()` is the
  contract every catalog is held to), `resources/templates` (ntc-templates
  vendored, with the fixtures for every template a catalog names),
  `sidecar/` (scrapli + TextFSM over JSON lines; `protocol.py` is the
  contract, `session.py` drives contexts and paging from the catalog's
  `session:` block), and `docs/DISCOVERY-RECONCILIATION.md`, the table
  every command was checked against. The read-only allowlist exists three
  times on purpose (Rust, JavaScript, Python) and one fixture pins them.
  **Mines:** the catalogs were generated and then became the source of
  truth — never rerun `build-catalog.mjs --force` over hand edits; ntc's
  index match is a prefix match, and `matchIndex` deliberately stops at a
  word boundary; a `config` word may appear only in a `session:` block,
  and the sidecar refuses any session step outside `SESSION_STEP`. Built
  the same day (LT-514–LT-517): `crates/coreview-collect` (the sidecar
  client, fingerprint, capabilities, `run::collect_device`, scrub, tables,
  the API collectors with certificate pinning), `src-tauri/collection.rs`
  and `collection_db.rs` (schema 6, the commands, offline import), and
  the Collect tab. Everything ran against `examples/fake_sidecar.rs` and
  the stubbed page then; the lab run (LT-558, `lab_run.rs`) collected all
  three lab boxes on 29–30 September, and the API collectors have their
  command (LT-518) — the FortiGate's policy is read over REST. The dev
  sidecar is a venv under `sidecar/.venv` (or `COREVIEW_SIDECAR_PYTHON`);
  the installer's copy is LT-519.
- **Later on 29 September 2026 (LT-519–LT-527).** The installer now carries
  the sidecar: `sidecar/build/windows.ps1` lays it, `sign.ps1` signs it,
  `tauri.sidecar.conf.json` ships it (Windows bundle only). The read-only
  guard lives in `Sidecar::run`, the one method every device command
  passes. `coreview-catalog::textfsm` is the Rust TextFSM engine on
  textfsm-rs, with `tests/ntc_conformance.rs` (519/519 vendored; set
  `COREVIEW_NTC_CHECKOUT` for ntc's whole suite, 1889/1895). Shadow mode is
  the `collectorShadow` project setting; `run::settle` is where both
  parsers meet. **Mines:** a table made only in a migration never exists on
  a fresh database — `migrate()` now calls the collection steps directly
  (LT-526), and any new table must be made there too; `target/` grew to
  27 GB and filled the disk once — stale test binaries of our own crates
  are safe to delete.
- **P2, 29 September 2026 (LT-527).** `crates/coreview-topology` builds the
  graph from a collection run; `collection_topology` stores it as a crawl
  run, so it is the newest run for every screen that reads one. **Mines:**
  a device's `details` is flattened into its JSON (routes are at the top of
  the device, not under `details`); ports are kept long-form in the graph
  and shortened only in the view; the Discover panel takes a built topology
  through `pendingCrawlResult` in the store, the way it reads walk files.
- **P3, 29 September 2026 (LT-531–LT-538, D-061).** `crates/coreview-path`
  walks a collection run's model; `collection_path` answers Path-Trace when
  the run it reads was built from a collection, and `collection_live` asks
  the path's devices through the sidecar. **Mines:** Path-Trace knows such
  a run only by its seed, `collection <run id>`, which LT-527 writes — change
  one and change the other (`collectionRunOf`); the page's types are held
  to `crates/coreview-path/fixtures/*.json`, rewritten with
  `UPDATE_PATH_FIXTURE=1 cargo test -p coreview-path` — rewrite them, then
  read the page tests, never the other way round; `Request.return_of` is
  `#[serde(skip)]` on purpose, so the page can never tell the builder a
  firewall already passed a flow; enum fields need `rename_all_fields` for
  camelCase, which `rename_all` alone does not do.
- **ASA, FTD and the API side, 29 September 2026 (LT-518, LT-540, LT-541,
  LT-552–LT-555).** `parser: reader:<name>` is Coreview's own reader in Rust
  (`coreview-collect/src/readers`); the sidecar is sent `none`. **Mines:**
  REST certificate pins live in the SSH host-key store as `tls:<host>` —
  "forget this key" in Settings is how a replaced FMC is trusted again; an
  FTD's rules come from its FMC and the path builder then ignores its
  `CSM_FW_ACL_` list — match on the `fmc_` command prefix, don't rename it;
  ntc's ASA `show nat` names the twice-NAT destination pair by position,
  which is backwards from Cisco's meaning (LT-552). A sweep of every
  template's fields against the normaliser found LT-552–LT-555 — rerun it
  when a catalog gains a template.
- **P4, 29 September 2026 (LT-542–LT-557).** Run diff and overlay edges,
  IPv6 / route-target leaking / L3VPN / VDOM contexts in the path builder,
  topology exports, SNMP fallback, host catalogs. **Mines:** the path
  builder's addresses are `IpAddr` and its prefixes `Prefix` (u128) — never
  compare across families; a link-local next hop is resolved on its link and
  is kept out of `by_ip`; rows read inside a VDOM or ASA context carry
  `_context` and their VRF is the context's name, so older runs keep VDOMs
  merged; the SNMP fallback marks the device `os = "snmp"` so the topology
  builder takes it despite the SSH failure; the allowlist is three copies
  (Rust, JS, Python) pinned by `allowlist-cases.json` — change all three and
  the fixture together (LT-556, LT-557 were both found that way).
- **30 September 2026 (LT-558–LT-649, D-062).** The lab run found and
  fixed some forty bugs, each with a failing test first; the collector
  became the default engine of "Discover devices" (D-062,
  `coreview-collect::follow`, the Discover panel), its run kept in the
  store so a tab change does not lose it (`src/lib/discoverRun.ts`);
  FortiOS backups read `show full-configuration` with no `enable`
  (`capture.rs`); Tracert streams a device's hops on `coreview://tracert`
  (`ssh.rs` `watch`/`take_partial`, `discovery.rs`); the FortiGate's policy
  is read over REST on the port saved with the API login (`api/`,
  `vault_commands.rs`); the sidecar waits for a slow SSH banner, closes a
  session a timeout killed, and refuses an unlisted VDOM (`session.py`);
  `lab_run --replay` rereads an app diagnostic with no device;
  `scripts/revert-point.sh` precedes a push. The sweep's reviews
  (LT-603) are items LT-605–LT-648 — read them before touching the
  topology or path builders.

- **Shipped 2026-09-30, late, after the mandate "make this app the best in
  the world" (LT-651–LT-670):** three catalogs built from documentation for
  whatever the lab's SN2010s turn out to run — `onyx.yaml` with 25 readers
  in `coreview-collect/src/readers/onyx.rs`, `cumulus.yaml` (NCLU) and
  `sonic.yaml`, with `readers/frr.rs` shared (FRR's routes, BGP and OSPF),
  `readers/text.rs` the fixed-width table helpers; the forwarding table as
  a `fib` table the path builder walks before the RIB (D-063 — `tables.rs`
  `fib_fixups`, `readers/cisco.rs` for IOS-XR's CEF and the ASA's data
  path, FortiOS's kernel routes in `readers/fortinet.rs`,
  `walk::candidates` and `Box_::forwarding()`); the builders' review bugs
  LT-654–LT-662 (Junos routes dropped, names with spaces, AP columns,
  down interfaces, adjacency per VRF, the VLAN table in the L2 walk); and
  `every_routing_os_feeds_what_the_path_builder_reads` in the catalog
  crate, which pins the six holes still open to their items. Then, on
  2026-10-01, seven more catalogs from ntc-templates' vendored sets and
  netmiko's session rules — Cisco Small Business, Cisco SD-WAN (Viptela),
  ArubaOS Mobility controllers, Extreme EXOS, Ruckus ICX, Ubiquiti
  EdgeOS, VyOS — with 46 fixture directories vendored so their template
  entries are `verified: lab`; the spec gained a section per OS, and the
  reconciliation script learned a digit in an OS name (`cisco_s300`).
  The FortiSwitch's LLDP detail, VLAN list and interface configuration
  were read from the lab's own 224E (`readers/fortinet.rs`, LT-665); Junos
  address books and filter-based forwarding from configuration XML
  (`readers/junos.rs`, a `policy_route.action_vrf` the walk follows,
  LT-669); and LT-671 found that no `parser: xml`/`json` command ever
  carried its `| display xml` / `| json` suffix — `plan::send_as` now
  appends it, which is the first thing to check when a Junos, NX-OS or
  EOS box answers text where rows were expected.

- **Shipped 2026-09-18, after the mission:** LT-285 the address register (the
  **Addresses** tab; `src/lib/ipam.ts` is the arithmetic, `e2e/ipam.mjs` drives
  it), LT-286 "Keep for this project" so a credential is typed once and the
  vault opens by itself afterwards, LT-287 panning with the right button and
  with Shift, which only ever failed in WebKitGTK — see 6.2b. Then LT-288/289
  made the register editable the way he asked for — subnets renamed, adopted and
  removed, addresses added with a kind (reserved / in use / excluded) — and
  LT-290 fixed the expanded address rows, which were laid out under the subnet
  table's headings. **The register's shape changed in the same day it shipped:**
  `ipam.reservations` became `ipam.entries` with a kind, through `migrate.ts`.
  Then LT-294 gave subnets **ranges** (a DHCP pool or an excluded span, which is
  what makes `free` mean anything), LT-295 made a device's own address editable
  from the register — it writes through to the diagram, one undo step — LT-296
  added "Fill from this project" to the discovery form, and LT-297's first slice
  gave each address record an assignment type, hostname, FQDN, MAC, owner and
  purpose, with a filter over all of them.
  **LT-297 then shipped Phase 1 as a tab of its own — "IPAM", beside
  Addresses** — with four views: Hierarchy (containers, rollups, routing
  tables, taking a subnet out of free space), Allocate (the wizard, with the
  duplicate-MAC check), Split & merge (planned first, refused while a range
  straddles a boundary), and History (a diff per change, capped at 500, in the
  project). `src/lib/ipamPlan.ts` is the planning arithmetic,
  `src/lib/ipamAudit.ts` the history, `e2e/ipamlab.mjs` drives the tab.
  **Q-017 is answered: no HTTP API, ever** (D-041) — the app calls out and
  nothing calls in. LT-298 and LT-299 hold what is left of the programme.
  **LT-300 then moved the whole register out of the bottom panel** onto a
  screen of its own, reached from **Addresses** in the toolbar, with one bar of
  five views (`RegisterScreen.tsx`). The bottom panel keeps what is about the
  diagram; the register is the other job the app does (D-044). The diagram
  stays *mounted* behind it — unmounting React Flow loses the viewport.
  **LT-303 put the user guide in the app** the same way: **Help** in the
  toolbar renders `docs/USER_GUIDE.md` itself, imported with Vite's `?raw`, so
  the documentation and the in-app help are one file (D-045). If you add a
  Markdown construct the guide did not use before, `helpDoc.test.ts` parses the
  real file and will tell you.
  **LT-306 turned the dark ground green**, tokens only — colour still lives in
  three blocks of `styles.css` and in `theme.ts`, and the status palette did not
  move (D-046).
  **LT-311: CI builds every installer again**, including the offline Windows
  one (`bundle-windows-offline`, `webviewInstallMode: offlineInstaller`, ~500 MB)
  that had been held back since 2026-09-12. LT-305's Windows-only narrowing
  lasted a day.
  **LT-308: Coreview is proprietary and free to use.** `LICENSE` at the root,
  the same words in About and the README, the author and the LinkedIn in every
  manifest, and `THIRD-PARTY-NOTICES.md` generated by
  `scripts/third-party-notices.mjs` — MIT and Apache-2.0 require the licence
  *text* to ship with the binary, so it reproduces all 364 of them and
  `bundle.resources` installs it beside the app. Regenerate when dependencies
  change. Q-009 is closed.
  **LT-313: no trademark is claimed on the name**, and the licence lets anyone
  pass the app on unchanged and free — that is the point of it. The ™ that
  LT-308 put on the installer's licence page asserted a mark nobody owns, on a
  name an established company already uses; `licensing.test.ts` fails if one
  comes back.
  **The dependency trees were audited (LT-312): no GPL, AGPL or SSPL.** Five
  MPL-2.0 crates are linked unmodified, which MPL expressly allows, and are
  named with their sources. The generator *fails* rather than warns if a
  blocking licence appears, and `licensing.test.ts` guards the manifests.
  **LT-309: the mark is `brand/coreview-mark.svg`**, drawn as geometry; the
  icons are generated from it, and the toolbar draws the same shape in
  `currentColor`.

- **Shipped 2026-09-19, the three he asked for after the release:** LT-318 put
  **Its own username and password** on every device — type an SSH or SNMP login
  on the device itself, Save puts it in the vault encrypted and writes only the
  id on the node, Clear deletes it. The vault passphrase flow is one component
  now (`VaultGate.tsx`); the *global* discovery pair already saved and restored
  (LT-286) and was not rebuilt. LT-319 moved Compare, Racks, From a file and
  From a drawing out of a ten-tab bottom panel onto a **Tools** screen, on the
  same rule the register left under (D-044, extended). LT-320 is the big one:
  **a real terminal**. `@xterm/xterm` in front, `ssh::Shell` in
  `coreview-discover` behind, `src-tauri/src/terminal.rs` holding the live
  sessions, an **SSH** tab in the panel with a tab per device, and **SSH to
  this device** on the right-click menu. A session belongs to the window and is
  never written down (D-047) — it survives a page reload because it lives in
  the Rust process, and closing the project closes every shell.
  **It has not met a device.** `e2e/ssh.mjs` drives the real protocol against a
  stubbed backend, and the Rust half compiles and has its pure parts tested;
  the first session against hardware is the operator's.

- **The 2026-09-16 mission (phases 2–8) is done except what waits on him:**
  LT-201/221 (Q-011, no router that peers), LT-205/218 (Q-008, HTTP),
  LT-223/229 (D-030 not accepted), LT-261 (Q-012, OpenSSL in every
  installer), LT-263 (Q-013, no TPM or Secure Enclave), LT-269 (Q-010, CI cost),
  and LT-281 (vite/vitest major upgrades).

**One thing the audit could not settle:** whether LibreOffice honours `--`
as an end-of-options mark (LT-458). It could not be shown to on this machine,
so `shapeconv` passes absolute paths instead and the flag is not used.

**Known bugs open: one, and it is not a code change.** LT-137: two real device
passwords were used as test fixtures and remain in git history. The fixtures
are fixed; rotating the passwords is the operator's call and is the thing that
actually makes them harmless. LT-282 and LT-277 left lab identifiers in history
the same way (Q-014); one rewrite could remove all three.

**Two fixed and awaiting his eyes:** LT-107 and LT-108.

---

## 9. Things worth knowing that are not written anywhere else

- **The operator wants no pale colours.** He said so directly. There are tests
  holding a contrast floor for every device tint on the ground it is for. Do
  not lower them.
- **An unwatched device is drawn by what it is, not by its health** (D-008).
  With no probes attached everything is "unknown", so colouring purely by
  health made every new diagram grey. Health takes the colour back the moment
  something is watching.
- **Two grounds, not an inversion** (D-007, D-016). Light is built against
  white; dark against near-black. A colour chosen for one is wrong on the other.
- **The export draws itself from the model** (D-001), not by serialising the
  canvas. It has fallen behind the canvas once already and had to be caught up
  — sections, line styles, end caps, ground. If you add something visible to
  the canvas, ask whether `src/lib/diagram.ts` needs it too.
- **`src/lib/paper.ts`'s `sheetsFor` is written and tested but only reports.**
  Multi-sheet export is in Icebox.
- **Performance is measured, not guessed.** 400 devices: opens in ~2s, drags at
  ~15fps, pans at ~8. 120 devices: 33 and 18. The cost is the DOM, about sixty
  elements per device. Line jumps cost nothing measurable.
- **The user is direct and technically fluent.** He will tell you when
  something is wrong and he will be right. He does not want hedging, and he
  does want to be told plainly when something cannot be done or when you have
  broken something.

**Vendor artwork lives outside the repository (D-028, LT-162).** Nothing under
`stencils/` but its README is committed or shipped, and a Rust test enforces
it. The operator's own Cisco set and the Tripp Lite `.vss` are kept in
`~/coreview-local/`. The `.vss` import test reads that file when
`COREVIEW_VSS_FIXTURE` points at it and skips otherwise (the PowerPoint stencil
deck works the same way, through `COREVIEW_PPTX_FIXTURE`):

```
COREVIEW_VSS_FIXTURE=~/coreview-local/fixtures/tripp-lite-racks.vss cargo test -p coreview icons::
```

