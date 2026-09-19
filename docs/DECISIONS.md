# Decisions

Append-only. A past entry is never edited; it is superseded by a new one that
references its ID.

Each entry: date, ID, the decision, what was rejected, and why.

---

### D-001 — The export draws itself from the model — 2026-08-28
**Decision:** the SVG export is rendered from nodes, edges and statuses, not by
serialising the live canvas.
**Rejected:** serialising `.react-flow__viewport`.
**Why:** React Flow lays nodes out as absolutely positioned HTML `<div>`s. Wrap
that in an `<svg>` and you get a valid file that no renderer will draw — and it
fails silently: the edges and the title block appear and every device is
missing. It costs a second implementation of the node's appearance and buys an
export that works, does not depend on what is scrolled into view, and is a pure
function that can be tested without a browser.

### D-002 — Rust stores the diagram as opaque JSON — 2026-08-28
**Decision:** `ProjectPackage.document` is a `serde_json::Value`. The storage
layer never parses the diagram.
**Rejected:** a typed Rust struct mirroring the document.
**Why:** every field the interface adds after that struct is written would be
dropped on the next save, and the person would find out when their diagram
reopened without its views, its leaders or its colours. Proved by test on
2026-08-30: a document round-trips byte for byte including a field the storage
layer has never heard of.

### D-003 — No vendor artwork in the repository or the binary — 2026-08-28
**Decision:** Coreview draws its own glyphs. Third-party icon sets are fetched
or converted into a folder the operator points the app at.
**Rejected:** bundling a vendor icon set.
**Why:** licensing and trademark. It is also why the icon library is a folder
path rather than an asset directory, and why `scripts/fetch-modern-shapes.mjs`
writes licences next to what it downloads.

### D-004 — Telnet is never tried after a password is refused — 2026-08-29
**Decision:** fall back to telnet on a timeout or a refused connection, never
on a rejected password.
**Rejected:** falling back on any SSH failure.
**Why:** a rejected password means the account exists and the credentials are
wrong. Sending them again in clear text is worse than failing.

### D-005 — A port-channel is not inferred from port numbering — 2026-08-29
**Decision:** links are not collapsed because their ports are consecutive.
**Rejected:** treating consecutive ports between the same pair as a bundle.
**Why:** two consecutive cables between a pair are as likely as an
aggregation. The app would be asserting something it cannot observe, which is
the one thing it is not supposed to do. Doing it properly means asking the
device — see LT-009.

### D-006 — Credentials are never in an export unless asked for — 2026-08-29
**Decision:** a project package carries no credentials; there is a separate,
labelled export that includes the vault.
**Why:** a project package is the thing people send each other.

### D-007 — Two grounds, not an inversion — 2026-08-30
**Decision:** the light ground has its own palette, chosen against white.
**Rejected:** deriving light colours by inverting or lightening the dark ones.
**Why:** amber at `#e8a33d` is legible on `#0a0e13` and disappears on white. A
first attempt dimmed the dark palette and every diagram looked faded.
**Superseded in part by D-016** for the neutral-grey desk.

### D-008 — An unwatched device is drawn by what it is — 2026-08-30
**Decision:** colour by device type when the status is `unknown`; health takes
the colour back as soon as a probe is attached.
**Rejected:** always colouring by health.
**Why:** with no probes every device is "unknown", so a diagram nobody has
pointed at anything yet came out entirely grey. The status line never borrows
the device's colour, or a blue switch would read as though blue meant
something.

### D-009 — Only one of a crossing pair hops — 2026-08-30
**Decision:** the horizontal run hops the vertical; where both lie at the same
angle the edge id breaks the tie.
**Rejected:** both hopping; deciding by render order.
**Why:** two arcs through each other is worse than none, and a decision that
depends on which edge rendered first makes the hop flicker between them.

### D-010 — `onlyRenderVisibleElements` is not used — 2026-08-30
**Decision:** React Flow renders every node.
**Rejected:** rendering only what is on screen.
**Why:** measured — it halves the DOM and improves opening and panning, and
makes dragging three times worse, because React Flow recalculates what is
visible on every frame of a drag. Recorded so it is not tried again.

### D-011 — A view is a property of an object — 2026-08-30
**Decision:** an object carries a list of views; a view is not a container.
**Rejected:** views owning their contents.
**Why:** nothing has to move between views, an object can be on more than one,
and an object that has never been assigned is on all of them — which is what
keeps a diagram drawn before views existed opening with everything visible.
Deleting a view does not delete what was on it.

### D-012 — A section's contents are geometric — 2026-08-30
**Decision:** a section holds whatever stands inside it, recomputed, never
stored.
**Rejected:** a membership list.
**Why:** "everything in this half of the picture is the DMZ" is not a list
anybody maintains. Membership goes by a device's middle, so one half over the
border belongs to the side most of it is on.

### D-013 — Alignment guides replace grid snapping — 2026-08-30
**Decision:** no ten-pixel grid snap; devices line up with their neighbours.
**Rejected:** keeping both.
**Why:** two devices can both sit on the grid and still be four pixels out from
each other, which is what a diagram looks untidy for — and the grid fought the
guides for the last few pixels of every drag.
**Amended 2026-09-16** (an amendment, not a supersession — guides stay the
primary alignment mechanism). In the operator's words: "adds grid snap back as
an opt-in fallback and makes the default context-aware". So:
- a **Snap to grid** toggle, per project, persisted, in the canvas toolbar
  (always visible) and in Preferences, flipped with Ctrl/Cmd+Shift+G;
- when a guide and the grid both apply, **the guide wins**;
- holding Alt (Option on macOS) during a drag inverts snapping for that drag;
- default by view: freeform/logical **off**; rack elevation **on**, and the
  vertical U placement cannot be turned off because U alignment is correctness,
  not preference; port / patch-panel and any later structured-grid view **on**.
Built as LT-175.

### D-014 — Space-panning is done with an overlay, not React Flow — 2026-08-30
**Decision:** while space is held, a transparent sheet covers the canvas, takes
the drag, and moves the viewport directly.
**Rejected:** `panOnDrag` including the left button; disabling nodes with CSS
`pointer-events`.
**Why:** a drag that begins over a device is captured by the device before the
pane sees it, and a device is exactly where the pointer usually is. React Flow
sets `pointer-events` on a node inline, where no stylesheet reaches.

### D-015 — A leader carries no health — 2026-08-30
**Decision:** a line whose `kind` is `leader` reports no status, is not
counted, has nothing travelling along it, and does not hop.
**Rejected:** an ordinary link with its health rule turned off.
**Why:** it is an annotation, not a cable. Reporting a health for it would put
a made-up green line in the counts and a made-up outage in the timeline.

### D-016 — The canvas gets a neutral desk and a white page — 2026-08-30
**Decision:** the viewport is a neutral grey desk; the drawing surface is a
white page floating on it. Tokens are hue-neutral.
**Rejected:** painting the viewport white (the current `#f4f7fa`).
**Why (the operator's):** "Visio and Lucidchart do NOT paint the viewport
white... that contrast is what makes white look white." Supersedes the light
ground's `--bg` from D-007; the rest of D-007 stands.
**Status:** accepted, not yet implemented — LT-001.

### D-017 — Stencil conversion moves from Inkscape to LibreOffice — 2026-08-30
**Decision:** EMF→SVG goes through `libreoffice --headless --convert-to svg`,
batched, with a bounding-box crop afterwards.
**Rejected:** Inkscape, which is what `scripts/import-shapes.mjs` uses today.
**Why (the operator's):** LibreOffice emits each icon on a full A4 page with
the artwork in the corner, so the viewBox has to be cropped to the real content
— "without this every icon renders as a tiny speck in a huge empty canvas".
Failing loudly when `soffice` is missing is part of the decision.
**Status:** accepted, not yet implemented — LT-002.

### D-018 — Remote Lucid assets are skipped, not faked — 2026-08-30
**Decision:** the 27 `.lcsl` shapes whose artwork lives on Lucid's servers are
written to `unresolved.json` with their names and urls and reported as a count.
**Rejected:** substituting a placeholder icon.
**Why (the operator's):** "Do not fabricate a placeholder that looks like a
real icon." A placeholder that looks real is worse than an absence.
**Status:** accepted, not yet implemented — LT-006.

### D-019 — Vendor stencils are committed to the repository — 2026-08-30
**Supersedes D-003** in part, on the operator's instruction: "you can put the
vendor stencils in the repo, everything goes into the [repo] except passwords
that we set locally after installing the device".
**Decision:** converted stencils — the Cisco set, the Lucid set, the fetched
Tabler and Simple Icons shapes — are committed. `stencils/` is not
git-ignored. Q-002 is closed by this.
**Rejected:** git-ignoring `stencils/` and treating converted artwork as build
output, which is what D-003 implied and what I had assumed.
**What still stands from D-003:** the *application* ships no third-party
artwork. Nothing under `stencils/` is bundled into the binary or drawn unless
the operator points the icon library at it, and Coreview's own 26 glyphs remain
self-drawn. The reason for that half of D-003 was never repository tidiness; it
was that the app should not carry someone else's trademarks in its installer.
**Worth saying once, not repeatedly:** Tabler is MIT and Simple Icons is CC0,
so both are fine to redistribute. The Cisco deck's artwork is Cisco's, under
whatever terms it was published; committing it to a repository you control is
your call and this records that you made it. If the repository ever becomes
public that is worth another look.
**Consequence:** D-006 is unaffected and unchanged — secrets are still never
committed and never exported unless explicitly asked for. "Everything except
passwords" is exactly the line D-006 already draws.

### D-020 — A bug is reproduced before it is fixed — 2026-08-30
**Decision:** every reported bug gets a roadmap item and a test that fails
without the fix, before the fix is written. Nothing is marked Done on the
strength of having changed the thing that looked wrong.
**Rejected:** fixing what looks like the cause and moving on.
**Why (the operator's):** "I don't want any bugs." The only version of that
which means anything is a bar on how a fix is confirmed, because the failures
that survive are the ones where the fix looked obviously right — hidden
handles that still took the pointer, a document that saved but dropped a
field, an eight-digit hex that renders black. Each of those compiled.

### D-021 — The page is drawn in the viewport, not added to the document — 2026-08-30
**Decision:** the page is a div rendered through React Flow's `ViewportPortal`
in flow coordinates, with `z-index: -1`.
**Rejected:** a `page` node type in `doc.nodes`, which is how it was asked for.
**Why:** a node would have to be kept out of the monitored-objects table, out
of exports, out of the save payload, out of select-all, out of the crawl merge
and out of every count — six places to remember and one to forget, and the
failure mode is a phantom object in someone's inventory. Nothing here is in
`doc.nodes`, so there is nothing to filter and no boundary to get wrong. It
scales and pans with the diagram exactly as a node would.
**Consequence:** `Fit view` had to learn about the page, because React Flow's
`fitView` only knows about nodes and was putting the page edge off-screen.

### D-022 — The converted stencils ship inside the installer — 2026-08-31
**Decision:** `stencils/` is bundled into the application as a Tauri resource
and the palette offers those shapes built-in, with no folder to point at.
**Supersedes:** the rider on D-019. D-019 put the converted stencils in the
repository but kept them out of the binary; the operator read that back and
overruled it in his own words: "Change this statement you can bake into the
installer please."
**Rejected:** keeping the load-a-folder step for the shapes we already
converted ourselves. It made the first-run palette look empty and put a
manual step in front of the thing the pipeline was built to provide.
**Cost accepted:** ~2 MB of installer, and the third-party-artwork line moves
from "not in the binary" to "in the binary, for this operator's own use" —
his call to make, and made explicitly.

### D-023 — Scope the operator ruled out — 2026-08-31
**Decision:** these are not built, now or in future: LT-006 (Lucidchart .lcsl
import), LT-011's public-CA half (SmartScreen-clearing signing), down-device
alerting, RTT-trend / SNMP metrics on the hover card, availability / SLA
summaries, scheduled re-crawl, and auto-layout.
**Why (the operator's):** "they are not wanted and we will not do them now or
in the future." The enhancement backlog memory was pruned to match; LT-006 and
LT-011 keep their IDs under a Declined section rather than being deleted.
**Still wanted from the same conversation:** LT-069, LT-028, LT-027, the
config-backup diff viewer, and the LT-063/025/033 housekeeping.
**Partially superseded 2026-09-16 by D-029 and D-030.** Auto-layout and RTT
trend sparklines are reversed (D-029). Scheduled sessions and OS alerts are
*not* reversed: D-030 proposes the constraints under which they could be built,
and this entry's decline of them stands until D-030 is accepted. Scheduled
re-crawl, down-device alerting beyond D-030's scope, and availability / SLA
summaries remain declined.

### D-024 — Do not bundle a Visio converter into the Windows installer — 2026-09-04
**Decision:** Windows `.vss`/`.vssx` import does not carry its own copy of
`vss2xhtml`/`vsd2xhtml`. The route stays what it already was: those tools
converted on a machine that has libvisio (this repo's own conversion runs
happen on Linux), with the result committed as ordinary SVG stencils
(`stencils/`, `src-tauri/fixtures/`) the way `tripp-lite-racks.vss` was.
**Rejected:** LT-080's first answer — shipping the MSYS2 `mingw64` build of
libvisio and its DLL closure (~40 MB: `libicudt78.dll` alone is 33 MB) as a
Windows-only bundled resource, resolved at startup with a `PATH` fallback.
It built and passed CI on a real `windows-latest` runner, so the approach
worked; it was reverted anyway.
**Why (the operator's):** "made the installer up to 38MB I don't like that
lets revert it and remove whatever app or tool to covert the files i'm happy
with what we have" — followed by: he will hand over a stencil file directly
and expects it converted and made to work the way `tripp-lite-racks.vss`
was, not point his own installed app at a folder of `.vss` files.
**Consequence:** LT-080 as originally asked — "point the app at My Shapes
and let it read `.vss` directly on Windows" — will not be built this way.
If it is asked for again, a ~40 MB DLL bundle is the known, already-tried,
already-rejected answer; look for a materially smaller one before proposing
the same trade again.

### D-025 — A sweep asks the host, not just the resolver — 2026-09-12
**Decision:** the ping sweep actively interrogates every address that answers
— LLMNR, NetBIOS and mDNS for a name, the local neighbour table for a MAC,
and a TCP connect scan of eighteen common ports — and both halves are on by
default, switchable in the panel.
**Rejected:** leaving the sweep at ICMP plus reverse DNS, and adding the rest
behind a switch that is off until asked for. That is what LT-109 shipped, and
measured on the operator's own subnet it named one host in sixteen — the
thing he compared unfavourably against Advanced IP Scanner.
**Why (the operator's):** "ping sweep doens't retune names and useful info to
discover the network ... I want coreview to be better and only tool that does
it all."
**Costs accepted, both real:**
- **It is noisier.** A port scan is the loudest thing this app does and some
  networks watch for it; LLMNR goes to a multicast group every host on the
  segment sees. Hence the two switches, and hence a short port list rather
  than an exhaustive one.
- **A name from LLMNR or mDNS is the host's own claim**, not the network's.
  Any machine on a multicast group can answer for any other, so only a reply
  whose source is the address in question is believed — and the interface
  says which protocol gave each name rather than presenting them all as
  equivalent to a PTR record.
**Not in scope, and filed rather than folded in:** the credentialed sources
(SNMP sysName, WMI/WinRM/SSH, CDP/LLDP) are LT-125, because the crawler
already implements all three and the work is joining a sweep to a crawl, not
new protocol code.

### D-026 — Stacking parsers may be built from vendor documentation — 2026-09-12
**Decision:** the stack and virtual-chassis parsers (LT-139) are written
against vendor guides rather than against captured device output, and every
one of them is marked unverified until it has met real hardware.
**Overrides:** the standing rule in `CLAUDE.md` — "Parsers are written against
captured output from real hardware, not against documentation" — which exists
because a documentation-built parser fails silently on kit nobody tested.
**Why (the operator's):** "for teh stacking build it based on the guides and
make sure its ready to be tested for all of tehm". He has Cisco, Aruba, Dell,
Juniper and Fortinet families in scope and hardware for almost none of them to
hand; the alternative to building from the guides is building nothing.
**Cost accepted:** each parser is a hypothesis until tested. So each carries
the command it expects and the page it was built from in its own doc comment,
the test fixtures say plainly that they are documentation-shaped rather than
captured, and there is a way to point the app at a real device and compare.
**What does not change:** everything already written against real output stays
that way, and anything new outside stacking still follows the standing rule.
A parser that has met hardware gets its comment updated to say so — that is
how the two are told apart later.

### D-027 — Customer data never enters the repository or the app — 2026-09-13
**Decision:** nothing from a real customer's network — names, addresses,
hostnames, interface names, command lists written for their estate, procedures,
diagrams, change records — is ever committed, and nothing of it is written into
the application as a default, placeholder, example, preset, template, note or
test fixture.
**Why (the operator's):** "no customer info ever put in gethub or writen to the
app no matter what. this app is going to be used for public and gifted to
engineers to help them self out so we what ever we do here and test here must
remin local and nothing gets to the app as note/example, pass template never".
**Extends D-006,** which kept credentials out; this keeps everything else about
a real network out too. LT-137 is the precedent for why it has to be a written
rule rather than good intentions: a real device password once reached the
history as a "realistic" test fixture.
**How to apply:**
- A planning document the operator shares stays where he put it. Features are
  described from it in generic terms only.
- Built-in presets (command sets, checks, filename patterns) are generic vendor
  facts or absent — never lifted from a real project.
- Tests and harnesses use obviously invented names and documentation-range
  addresses (RFC 5737), or the operator's own lab captured under D-026's rules.
- Live testing against his lab is fine; what it produces stays on the machine.
- Before every commit, the staged diff is checked for anything that came from a
  customer document.

### D-028 — Coreview draws its own shapes; vendor is data, not artwork — 2026-09-16
**Supersedes D-019 and D-022**, and restores the line D-003 first drew — now
for the repository as well as the installer. Set by the operator when the
mission to reach Lucidchart/Visio parity was given, because the app is given
away publicly (D-027).
**Decision:**
- Coreview ships original outline shapes per device *class* — router, L3 and
  L2 switch, firewall, wireless controller, access point, load balancer, WAF,
  server, VM host, storage and so on — owned by the project and licensed with
  the app. No tracing of vendor artwork.
- Vendor and model are plain-text metadata on a shape instance. A router with
  vendor "Juniper" and model "MX960" draws the generic router outline and a
  text label.
- No vendor's official icons, logos or stencil packs — Cisco, Juniper, Arista,
  Palo Alto, Fortinet, F5 or any other — are bundled in the installer or
  committed to the repository, and none is downloaded at install time. The
  Cisco set already in `stencils/` and bundled by D-022 is a **pre-release
  blocker** (LT-162): removed before v1.0.
- User-sourced stencils stay possible through the documented manifest and SVG
  importer (LT-169). The user is responsible for their licensing; Coreview does
  not ship, fetch or update vendor packs; an export of a project containing
  imported stencils warns that third-party artwork may be included; a
  **vendor-safe export** replaces imported stencils with the built-in generic
  shape (LT-170).
- `docs/BRAND_AND_LICENSING.md` explains the split and `CONTRIBUTING.md` points
  at it (LT-172), so no contributor adds vendor logos "to be helpful".
**Rejected:** bundling the vendors' published stencil packs, as was done for
Cisco; and an import-only library with no built-in shapes.
**Why (the operator's rationale, recorded so it is not re-litigated every time
someone asks why Coreview has no Cisco icons like Lucidchart):** Lucidchart,
Visio and draw.io can carry vendor icons because they either license them or
run as a hosted service with a takedown process. A local-first, offline,
publicly distributed desktop app has neither. Self-drawn shapes plus vendor as
metadata give engineers the same two-click workflow — the model NetBox and
Nautobot use — without trademark or copyright exposure.
**Cost accepted:** the built-in palette looks less like a vendor's brochure,
and the existing Cisco-based palette section must be replaced before it is
removed so the first-run palette is not left empty.

### D-029 — Auto-layout and RTT sparklines are built after all — 2026-09-16
**Partially supersedes D-023.**
**Decision:** build auto-layout — hierarchical, radial, force-directed and
orthogonal — behind an explicit button, going through undo (LT-177); and RTT
sparklines in the inspector and probe history, drawn from the `probe_samples`
the app already stores (LT-224).
**Why (the operator's):** auto-layout is "pure local computation triggered by an
explicit user action, no network, no timers" and "core Lucidchart/Visio
parity"; sparklines "visualize probe_samples data the app already collects. No
new network activity, no timers, no telemetry."
**Still true from D-023:** discovery never moves anything on its own — a layout
runs only when the operator presses the button, and one undo puts every device
back.

### D-030 — Scheduled validation sessions and local OS alerts — 2026-09-16 — **Proposed, not accepted**
**Status:** proposed. D-023's decline of scheduling and alerting stays in force
until the operator accepts this entry. LT-223 and LT-229 are blocked on it.
**Proposed constraints (the operator's, all hard):**
- *Scheduled sessions.* A session is explicitly armed by the operator. Its
  start/stop window is visible in the UI at all times. It runs only while the
  app is open — focused or in the tray — never as a background service. It
  never fires silently: "If the operator cannot see it is running, it is not
  running."
- *Alerts.* Local OS toast notifications only. Off by default, opted into per
  session. No email, no webhooks, no persistent notification centre. Proposing
  any of those violates the mission's invariants.
**Rejected in advance:** a daemon, a service, a login item, or any notification
channel that leaves the machine.

### D-031 — Culling measured again under the operator's protocol, and rejected — 2026-09-16
**Reaffirms D-010.** D-010 is not edited; this records the second measurement it
asked for, run exactly to LT-188's protocol.
**What was built and measured.** Adaptive culling with drag safety: nothing
culled below 500 devices; above it, a window twice the viewport; recomputed only
when the viewport or document settled and never during a drag (a harness proved
the freeze: zero recomputes while React Flow auto-panned under a held drag, one
after release). Culling was done inside Coreview's own device and link
components, not with React Flow's `hidden`, so the minimap, selection and link
geometry kept every device.
**Measured** at 5,000 devices on production builds of the same source, culling
on against off, two runs each (`e2e/bench-canvas.mjs`, mean frame):

| Scenario | On | Off | Protocol needs |
| --- | --- | --- | --- |
| Idle | 20.6 / 21.2 ms | 20.8 / 112.5 ms¹ | ≥ 20% better |
| Pan | 303 / 320 ms | 314 / 318 ms | ≥ 20% better |
| Zoom | 1,390 / 1,629 ms, one frame of 209–223 s | 119 / 121 ms | ≥ 20% better |
| Drag | 574 / 574 ms | 643 / 654 ms | ≤ 10% worse |

¹ A settling spike after opening; the other run and the culling runs sit at the
frame floor.
**Decision:** culling is not used. The code was removed rather than left
switched off.
**Why:** idle, pan and zoom each had to improve by at least 20% and none did.
Idle already sits at the ~16.7 ms frame floor, so no renderer could show 20%
there; pan did not move, so its cost is not in the devices being drawn; zoom
regressed to a multi-minute freeze. The likely cause of the freeze — thousands
of devices entering the window at once, each asking React Flow to re-measure its
handles — was not verified, because fixing it could not rescue idle or pan.
**Not triggered:** the protocol's second clause — reject and open a
canvas/WebGL decision if drag regresses more than 10% — did not apply. Drag
improved by about 11%. No renderer decision is opened; if a very large diagram
still needs one, that is a new question.
**What the runs did show:** panning costs ~310 ms a frame at 5,000 devices with or
without culling. That is the next thing to profile (LT-189), not culling.

### D-032 — File formats are read against files their producers saved — 2026-09-16
**Extends the parsing rule in CLAUDE.md** ("parsers are written against captured
output from real hardware") from devices to files.
**Decision:** every file reader added in Phase 5 was written against files saved
by the program that makes them, not against a specification alone — net-snmp
walks and Nmap reports captured on the lab, Excel and LibreOffice workbooks,
Visio and draw.io drawings published by those projects — and each reader's doc
comment says what it was checked against and what it learned. Where no real file
could be had, the reader says so in its doc comment and in its roadmap entry:
the NetBox reader (built from NetBox's serializers), Nmap's MAC and OS elements
(need a privileged scan), and bent Visio connectors (only straight ones were
available; bends are checked by round trip). Public sample files used this way
stay out of the repository; tests carry invented, minimal equivalents.
**Dependencies this added:** `yaml` (npm, ISC, no dependencies) for NetBox YAML
and the project folder's readable copy; `pdf-writer` and `flate2` as direct Rust
dependencies, both already resolved through `svg2pdf` and `zip` at the same
versions, so no new code is downloaded.
**Why:** the lab captures found things no specification mentions — a DTD a
default XML reader refuses, a forwarding-table index net-snmp prints as dots,
master-inherited connector geometry, draw.io lines attached to nothing — and
each would have been a silent wrong import.

### D-033 — How the page reaches Rust, and what the keychain holds — 2026-09-16
**Decision:** three layers stand between the page and a command, each checked by
tests that read the other side's source so they cannot drift:
1. **The isolation frame** (Tauri's isolation pattern, LT-258) allows only the
   registered commands, by their own argument names, and four plugin calls. A
   refused message is rerouted to `ipc_refused` rather than dropped, so the page's
   call fails with a reason instead of hanging.
2. **Explicit payload builders** (LT-259) send only the fields a Rust struct
   declares; shared JSON fixtures are checked from both sides.
3. **`deny_unknown_fields`** on every structured input, so a field that slips
   past both is an error.
**The keychain holds the vault key, not the passphrase** (LT-262), although the
item asked for the passphrase: the key opens exactly what the passphrase opens,
so nothing is lost, and a passphrase reused anywhere else is never written into
a store other programs on the account can ask for. A kept key is accepted only
if it opens the vault's verifier.
**A rate limit counts starts per minute, not concurrency** (LT-260): the existing
one-job-per-kind cancellation already handles overlap; the limit is for a page
that loops.
**Why:** the webview renders content that came from devices and files — names,
banners, imported drawings. The backend holds credentials and can reach the
network. Nothing the page sends should be trusted merely because the page sent
it.

### D-034 — A project remembers a credential's id; the vault keeps the secret — 2026-09-18
**Decision:** "retain the password per project" (LT-286) is built as: the
secret goes into the encrypted vault, the project document records the
credential's **id**, and the vault opens by itself on that machine through the
OS keychain (LT-262). "Keep for this project" does all three from inside the
crawl or backup form, creating the vault if there is none.
**Rejected:** a password, or anything derived from one, in the project
document — even encrypted with a key kept beside it.
**Why:** a project file is the thing that travels. It is exported as a package,
put in a folder in Git, and sent to a colleague; D-006 has said since the
beginning that secrets do not go in it, and LT-137 is what it costs when one
does. An id is meaningless to anyone without that machine's vault, so the
project can be shared exactly as before.
**The one thing it changes by default:** keeping a credential offers, ticked,
to let the vault open by itself on that computer. Without it the passphrase is
typed once per session, which is not what was asked for. It is stated in the
form, it is a checkbox, and Settings turns it off again. Anyone who can use
that account on that computer can then use the saved credentials — which is the
same bargain a browser's password store makes, made in the open.

### D-035 — The address register derives what is known and stores only what is declared — 2026-09-18
**Decision:** LT-285's IPAM computes subnets, usage and free addresses from the
devices in the project every time it is drawn. Only what no device can tell you
— subnets someone decided on, and addresses held back — is stored, in the
project document.
**Rejected:** an address table kept in the database and reconciled against
discovery.
**Why:** a register that is stored is a register that disagrees with the
network, and reconciling the two is the work the spreadsheet already failed at.
Deriving it means an address that moves in the diagram has already moved in the
register, and there is nothing to reconcile. It also keeps the feature honest
about what it knows: each subnet says whether it came from a device's own
connected route, from the addresses on the diagram, or from someone typing it.
**IPv4 only:** "how many are free" has no useful answer for a v6 prefix. A v6
address is listed against its device and named as not counted, never dropped.

### D-036 — An address record has a kind, and exclusions are subtracted from both sides — 2026-09-18
**Decision:** every address the register holds itself is *reserved*, *in use* or
*excluded* (LT-289). Free is `usable − used − excluded`; the next free address
skips all three; an address both excluded and in use counts as in use.
**Rejected:** a single "held" flag, which is what shipped in LT-285.
**Why:** a register whose free count cannot be trusted is a spreadsheet with
worse ergonomics. The three kinds are the smallest set that keeps the number
honest — "held for later", "already taken by something you cannot see", and
"never hand this out" are three different answers to *can I use this address*,
and collapsing them loses the one that causes outages.
**What it does not do yet:** DHCP ranges. A pool handed out by a server still
reads as free space here, which is the remaining way the count can mislead.
Raised as Q-016 rather than guessed at.

### D-037 — Naming a derived subnet adopts it; removing it returns it — 2026-09-18
**Decision:** a subnet Coreview worked out for itself becomes the register's own
the moment it is named (LT-288). Removing it deletes the declaration, not the
subnet: it goes back to being derived, with its addresses.
**Rejected:** a register that holds only hand-typed subnets, with the derived
ones read-only; and a "hide this subnet" flag.
**Why:** the alternative asks a person to retype a prefix the app already knows,
to name it. And a Remove that made a subnet with live addresses on it disappear
would be a lie about the network — the addresses are still there, on devices in
the project. A declared subnet therefore keeps showing what confirms it:
"declared · also connected route".

### D-038 — A project's credentials are its own, and they can be replaced or wiped from where they are used — 2026-09-18
**Decision:** the credential a project keeps beats the machine-wide scan
setting, for SSH and for SNMP alike (LT-292); and the three things a person
wants to do to a kept credential — replace the password behind it, stop using it
here, delete it everywhere — are offered next to the credential, not only in
Settings (LT-293).
**Rejected:** keeping the machine-wide `scanCredentialId` and `scanSnmpRows` as
the authority. They are one scan's shape for whoever opens the app; opening a
second project and finding the first one's login in the form is wrong, and on a
tool an engineer points at several customers' networks it is worse than wrong.
**Why the three are separate, and worded to stay separate:** "Forget for this
project" and "Delete from the vault" are one click apart and mean very different
things — one is "not here", the other is "gone, for everything". The delete
confirms; the forget does not need to.
**A note for anyone adding another credential chooser:** each one used to keep
its own copy of the vault's state, read when it mounted. Two on the same form
disagreed the moment either changed anything, and the SNMP one spent its life
believing there was no vault. `vaultRevision` in the store is the fix; watch it.

### D-039 — A range is one decision; an address record is many fields — 2026-09-18
**Decision:** a DHCP pool or an excluded span is a **range** on the subnet
(LT-294), not two hundred individual records; `free` is
`usable − used − excluded − pooled`, and the next free address steps over both
kinds of range. An address the register owns carries a kind *and* an assignment
type — what it may be used for, and what is actually on it (LT-297).
**Rejected:** marking a pool with LT-289's `excluded` kind one address at a
time. It is correct and nobody would ever do it, which makes it a way for the
free count to be wrong.
**Why the two counts are separate:** a pooled address is not free to hand out by
hand and is not used by anything you can name — calling it either would be a
lie, and "used" is the lie that matters, because it is the one that makes a
subnet look full when it is not.

### D-040 — The register edits the diagram, and says that it is doing so — 2026-09-18
**Decision:** editing a device's address, name, interface, MAC or hostname from
the address register writes through to the device on the diagram — one undo
step, the same edit the inspector makes (LT-295). The form says which device it
is about to change, and that a crawl will correct what it reads again.
**Rejected:** keeping device rows read-only in the register and sending people
to the inspector; and copying the value into the register so the two could
differ.
**Why:** the register is where he is when he notices the address is wrong. Two
places that hold the same fact will disagree — D-035 exists because of exactly
that — so there is one fact, on the device, edited from wherever it is seen.

### D-041 — Coreview does not listen on a port — 2026-09-18
**Decision:** no HTTP API, no RBAC, no SSO, no health-check endpoint. The app
calls out — SSH, SNMP, ICMP, DNS — and nothing calls in. Asked as Q-017 when
the IPAM specification arrived with `/api/v1` in it; answered by the operator
the same day: "forget about Q-017 thats was thought not something i wanted."
**Why it was worth asking rather than assuming:** every other line of that
specification was worth taking, and this one would have put a listening socket
on the machine of every engineer the app is given to — with a token to store
and revoke, rate limiting, and a localhost binding that has to be right on
three operating systems. D-033 hardened the one boundary this app has, which is
Tauri IPC; a second boundary would have undone that work.
**If scripting is ever wanted**, the answer is a local command rather than a
server: no port, no token, nothing to authenticate. Not built, not asked for.

### D-042 — Containers are worked out from the CIDR, not from what claims what — 2026-09-18
**Decision:** a container's parent is the most specific other container that
contains it in the same routing table, computed on every draw. The stored
`parentId` is overwritten by what the addresses say.
**Rejected:** trusting a stored parent link.
**Why:** a parent link and a CIDR can disagree — after an edit, an import, or a
container being widened — and when they do, the CIDR is the fact and the link
is a stale opinion. The same rule the addresses already follow (D-035): derive
what can be derived, and store only what nothing can tell you.
**The same reasoning puts a subnet under a container:** the most specific one
that holds it, not the one whose id it carries. `containerId` is kept for what
a subnet was *allocated out of*, which is history rather than structure.

### D-043 — Every change to the register is planned, then recorded — 2026-09-18
**Decision:** splitting and merging are shown as a plan before they happen, and
refused while anything about them is ambiguous — a range crossing a new
boundary stops a split outright. Every change to the register writes a line of
history with a field-by-field diff, kept in the project, newest first, capped at
500 (LT-297).
**Rejected:** doing the split and letting undo be the safety net; and a log
outside the project file.
**Why the plan:** undo is a good safety net for a mistake you noticed. A DHCP
pool silently cut in half is a mistake nobody notices for a month, and by then
the undo history is three sessions gone.
**Why in the project:** the history of an address is worth as much as the
address, and it travels with an export to whoever is asked to review it. Capped
because it travels with an export.
**What it is not:** an audit trail. There are no logins, so it says what changed
and when, never who — and the tab says so rather than implying otherwise.

### D-044 — The address register is a screen, not a panel — 2026-09-18
**Decision:** the register lives on its own screen, reached from the toolbar,
with the address table as its first view (LT-300). The bottom panel keeps the
things that are *about* the diagram — the object list, events, discovery,
backups, racks, path checks.
**Rejected:** two tabs in the bottom panel, which is what shipped first and
what prompted "whats the difference between address and ipam".
**Why:** the bottom panel answers "what is happening to my diagram right now".
The register answers "what does this estate's addressing look like", which is
the second job this application does and not a question about the drawing. The
split also had a practical cost: a panel sized for watching a scan run was
clipping the split review and the container tree.
**The test of whether this was right** is that nobody has to be told which of
two places to look. One screen, one bar of views, one answer.

### D-045 — The guide in the app is the guide in the repository — 2026-09-18
**Decision:** the Help screen renders `docs/USER_GUIDE.md`, imported at build
time. One file, read two ways (LT-303).
**Rejected:** a second copy of the guide written for the app.
**Why:** two copies of the same explanation diverge, and the one that diverges
is always the one nobody is looking at. Editing the guide now edits the help,
and there is nothing to keep in step.
**The cost, accepted:** the guide has to stay written in the Markdown subset the
help parser reads — headings, lists, quotes, fenced code, tables, and the inline
marks notes already use. That is all it uses today, and `helpDoc.test.ts` parses
the real file on every run, so a construct the screen cannot draw fails a test
rather than rendering as a blank section.

### D-046 — The ground is green; the status colours are not — 2026-09-18
**Decision:** the dark ground moved from blue-grey to green at the same
lightness (LT-306). The accent stays blue, and healthy, warning, down, unknown,
disabled and maintenance are untouched.
**Rejected:** rotating the accent towards green with everything else.
**Why:** the status colours carry meaning, and an accent drifting towards green
would sit beside "healthy" — the one pair on this interface that must never be
confused. Blue on a green ground is also simply easier to pick out than green on
green. The ground is decoration; the status palette is information, and only one
of those follows a preference.
**High contrast turns the dot texture off.** Texture costs contrast, which is
the entire purpose of that ground.

