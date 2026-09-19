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
| `docs/DECISIONS.md` | 21 decisions with what was rejected and why. Append-only. |
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
  lib/            28 modules of pure logic. This is where the thinking lives.
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
  coreview-discover  Crawling. SSH (russh), telnet, CDP, LLDP, FortiOS, SNMP,
                     ARP, MAC tables, OUI lookup. 300+ tests.
  coreview-probe     ICMP/TCP/DNS probing. Tauri-free on purpose.
src-tauri/        Commands, SQLite, the credential vault, icon library scan.
scripts/          Stencil/shape importers. Run by hand, not by the app.
e2e/              Playwright harnesses that drive the real app.
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
npx vitest run                                    # 369 tests
cargo test --workspace                            # 377 tests
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
the one written here.

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

| Device | Address | What it proved |
| --- | --- | --- |
| Cisco C2960CX | 192.168.77.7 | CDP, LLDP, config backup, SNMP v2c and v3 |
| FortiSwitch 224E | 192.168.77.203 | FortiOS command set, chassis-id→ARP resolution |
| FortiGate 60F 7.6.7 | 192.168.77.1 | `$` prompt, DHCP lease list, FortiLink, FortiAP LLDP |
| Ubiquiti USL8L | 192.168.77.112 | SNMP only; found via a FortiAP's LLDP |
| Palo Alto PA-220 | 192.168.77.206 | SNMP v2c identity |

**Parsers are written against captured output, never against documentation.**
`crates/coreview-discover/examples/try_commands.rs` runs a list of commands
against a real device and reports which were understood;
`examples/raw_login.rs` dumps exactly what a device sends after login. Both
exist because guessing from docs produces a crawler that fails silently on
hardware nobody tested.

The biggest single win on this project came from `raw_login.rs`: a FortiGate
was completely unreachable because FortiOS ends its prompt in `$` for any
non-super_admin profile and the prompt finder only accepted `#` and `>`.

---

## 8. Where the work is

`docs/ROADMAP.md` is authoritative, and it was swept on 2026-09-12 so its
**Now** section is again a list of open work rather than a history. Do not
trust the summary below over that file; it is a signpost and it will rot.

- **Not started:** LT-125 name a swept host from what the crawler already
  knows · LT-124 the identity sources the sweep still does not use (HTTP/TLS
  certificate names, DHCP fingerprinting, the gateway's ARP table).
- **Half done:** LT-139 the stacking parsers exist and have met no hardware ·
  LT-110 Visio import (the Lucidchart/geometric path has no `<Connect>` data
  at all).
- **Blocked on something outside this repository:** LT-138 needs a Windows
  install-upgrade-check cycle · LT-139 needs a real stack or VSX pair and
  `examples/probe_stack.rs` · LT-134 needs an `snmpwalk` of the FortiGate ·
  LT-136 needs the multi-chassis families to exist somewhere reachable.

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

- **The 2026-09-16 mission (phases 2–8) is done except what waits on him:**
  LT-201/221 (Q-011, no router that peers), LT-205/218 (Q-008, HTTP),
  LT-223/229 (D-030 not accepted), LT-261 (Q-012, OpenSSL in every
  installer), LT-263 (Q-013, no TPM or Secure Enclave), LT-269 (Q-010, CI cost),
  and LT-281 (vite/vitest major upgrades).

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

