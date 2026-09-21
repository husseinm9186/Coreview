# Roadmap

The single source of truth for what has been asked for. IDs are stable and are
never reused; items move between sections but are never deleted.

Acceptance criteria are written in the words they were asked in. Where what
shipped differs from what was asked, the Done entry says so.

---

## Now

*In progress or picked up next. LT-029 is a standing bar rather than a piece
of work and does not count against that.*

*Swept 2026-09-12: thirty-seven finished items moved to Done, where they
belonged. What is left below is genuinely open — work blocked on hardware, on
the operator's own eyes, or not yet started. The "never more than three" rule
this section was written with has not held for a long time and is not what is
keeping it honest; the sweep is.*

**Build order set by the operator, 2026-09-13** — "do it after we finish
with the current task", "do it after", "do it after": first the current work,
then **LT-125**, then **LT-124**, then **LT-134's second half** (IF-MIB,
LLDP-MIB, BRIDGE-MIB). One at a time, in that order. **Not** LT-110's
Lucidchart path — "don't do it we don't want this"; see LT-110 in Done.

**Mission set 2026-09-16 — parity with Lucidchart and Visio, and beyond.**
Eight phases, checked in after each. Phase 1 is below; phases 2–8 are under
**Next**. The operator's rulings on the conflicts it raised are D-028 (shapes),
D-029 and D-030 (D-023 split), the D-013 amendment (grid snap), and LT-188's
measurement protocol (D-010). Order: 1.1 and 1.3 first, "since they unblock the
largest downstream UX work", then in order. Invariants for every item: no cloud,
no accounts, no telemetry, no network call the operator did not start, every new
Tauri command named, schema-validated and documented, fully offline.

**IPAM programme set 2026-09-18 — "a production-quality IPAM platform
inspired by Infoblox Grid Manager".**
**It is direction, not a contract — his words: "the infoblox platform spec is
just an idea of what you should do use it carefully."** Read it as what a good
IPAM does, and take the parts that fit a local-first desktop tool. The four
conflicts below are exactly where taking it literally would damage the app, and
nothing in it justifies building a server into something given away to
engineers.
 A full specification: ten sections, three
phases, a normalised model of containers, networks, address records, VRFs,
VLANs, sites, tenants, devices, interfaces, DNS records, DHCP scopes and leases,
tags, custom fields, audit logs; hierarchy, list and detail screens; an
allocation wizard; split and merge; a discovery and reconciliation queue;
reporting; and a REST API with RBAC. Held as **LT-297 (Phase 1)**, **LT-298
(Phase 2)** and **LT-299 (Phase 3)** below. LT-294, LT-295 and LT-296 are folded
into Phase 1 and Phase 3 where they belong, and are kept as their own items
because he asked for them in their own words.

**Four things in it conflict with what this app is, and each needs his ruling
rather than my assumption:**
1. **The REST API, RBAC, SSO, CSRF, rate limiting and a health-check endpoint
   (§7, §8).** Coreview has no server. It is a desktop application whose only
   boundary is Tauri IPC, hardened under **D-033**; the standing invariant on
   every mission item is "no cloud, no accounts, no telemetry, no network call
   the operator did not start, fully offline". Serving `/api/v1` means opening a
   listening socket on an engineer's machine — the opposite of that, and a real
   attack surface on a tool given away to strangers. **Recorded as Q-017.**
2. **Roles and tenants (§1.7, §8).** There is no login, so `actor_id` is always
   the same person and a "viewer" who can become a "super_admin" by editing a
   local database is not a permission, it is a label. The audit log is worth
   having; the roles are theatre until there is an identity to attach them to.
3. **The seed data (§9).** It names his own lab's subnet, its gateway, a held
   address on it and a "Home Lab" site — the real values, not examples. **D-027**
   forbids a customer's or the operator's own network becoming a default,
   preset, example or fixture in a tool that is given away. The demo data will
   be built with documentation ranges (RFC 5737) and invented names. The feature
   is exactly as asked; the values are not his.
4. **"Preserve my current subnet inventory and expand it through migrations".**
   Coreview's register is *derived* (**D-035**): what is known comes from the
   devices in the project and is recomputed on every draw, so it cannot drift.
   A row per address is a different model. Both can coexist — a stored record
   layered over a derived view — and that is what Phase 1 builds, but it changes
   D-035 and is recorded as such.

### LT-346 — Trace Path: where a packet would actually go — 2026-09-20
**Source:** asked 2026-09-20 — "Implement a new Path Intelligence feature …
select a source and destination and visualize the actual routing/forwarding
path on the existing React Flow topology — not just the physical topology",
with explicit instructions not to restructure anything, to reuse the existing
discovery, topology, session and persistence infrastructure, and — twice — not
to invent data.
**Nothing was restructured and nothing new was collected.** No Rust, no new
Tauri command, no schema change: `CrawledDevice.routes` (LT-200) already
carries prefix, protocol, **next hops as a list**, interface, distance and
metric, and crawl runs already persist and read back. The engine is pure
TypeScript over data already held, and tracing sends nothing.
**Shipped:** `src/lib/pathTrace.ts` — longest-prefix match (mask first, then
administrative distance, then metric, in that order because routers do not
treat them as interchangeable), recursive next-hop resolution, ECMP as
branches, loop detection, and a **Trace path** tab beside Path check with the
hop table, a **Why this path?** panel in sentences, the path highlighted on the
existing React Flow topology through `canvasHighlight`, and failure simulation.
**The recursive case from the brief works and is tested:** `10.40.50.0/24` via
BGP next hop `10.255.2.1`, resolved through OSPF to `192.168.12.2`, resolved
through a connected route to `Gi0/0`.
**Failure simulation takes an alternate the device already holds.** Removing a
device makes the trace fall to the next-best route *in that device's own
table*, labelled as such — "the preferred route's next hop is on a device this
simulation removed; it is already in EDGE's table". It does not model
reconvergence, because that would be inventing routing. Nothing is sent and no
device is touched: it is a filter over the copy already held.
**What it refuses, and why that is the feature (D-050):**
- **A named VRF** reports insufficient. Routes are collected from the global
  table only; answering a VRF question from it would be confidently wrong.
- **VXLAN and EVPN** report insufficient. Nothing in the crawler collects
  VTEPs, VNIs or EVPN route types, so overlay and underlay were not built at
  all rather than faked — **LT-347** is the discovery work that would earn it.
- **A device whose routing table was never collected** stops the trace and says
  so by name, rather than guessing the next hop from the diagram's cables.
- A device never crawled, and a destination that is not an IPv4 address, are
  each refused with the reason.
**29 unit tests** over exactly the areas asked for — longest-prefix match,
recursive resolution, VRF isolation, ECMP, unreachable, missing data, failure
simulation — and `e2e/pathtrace.mjs` drives the panel end to end with 17
checks, including that a named VRF draws no path at all.
**One bug found by the harness and fixed:** ticking a device in the failure
simulation removed it from the path, so its own checkbox unmounted and could
never be unticked. The candidate list now only grows.

### LT-378 — **bug** The banner was answered with the wrong byte, and the app could not say so — 2026-09-21
**Source:** LT-375 shipped, LT-377's new state proved the login was fine —
**"Logged in, waiting for a prompt"** — and the device still never reached a
prompt. Then: "i think we just need to send return seq to the device because
thats what its telling us press enter to continue".
**He was right, and it was one byte.** `continuation_reply` answered a banner
with `\n`. **A line feed is not what the Enter key sends.** A terminal
transmits `\r`, and a device reading raw keystrokes from a banner waits for the
byte the key actually produces. So the app pressed something that was not
Enter and the banner went on waiting, exactly as before the fix.
**Two other things were wrong in the same place, both found while proving
it.**
- **The matcher compared the wrong text.** A banner arrives as instructions
  for *drawing* a banner — `ESC [ 2 K` to clear the line, carriage returns to
  overwrite, colour codes around the words. Matching the raw line compares a
  phrase against the painting instructions for that phrase. `visible_text`
  now strips them, so what is matched is what a person would read.
- **The failure could not be diagnosed from outside.** "Gave up after 60
  seconds" threw away the one fact that explains it: what the device had said.
  `CommandTimeout` now carries the tail of it.
**That diagnostic is deliberately limited to the login read.** `command` is
`None` there and the buffer is a banner. A command's buffer can hold a
running-config, and an error message is the wrong place for one — it ends up in
logs and screenshots (D-006). A command timeout still says nothing about
content.
**The lesson worth keeping:** two rounds were spent guessing at what the device
printed because the app never said. The diagnostic should have come first.
**Then widened to the other vendors, at his asking** — "maybe we need to
research if there are other vendors requiring something else". `CONTINUATIONS`
is now an explicit table of `(phrase, reply, anchored-at-end)`, so a platform
is one line and one test:
- **Pagers**, answered with a space: Cisco `--More--`, ASA `<--- More --->`,
  Comware and Huawei `---- More ----`, Junos `---(more)---` and
  `---(more 47%)---`, AOS-CX and Brocade `-- MORE --, next page: Space`,
  Extreme `Press <SPACE> to continue or <Q> to quit`.
- **Banners**, answered with a carriage return: `Press any key to continue`,
  `Press enter to continue`, `Press RETURN to continue`, and a reloaded Cisco
  console's `Press RETURN to get started`.
- **Two proven exceptions that take a line feed**: the FortiGate FIPS accept
  line and FortiOS's own pager. Both have been answered that way on real
  devices through `run()`, which sends `\n`, so the table matches what works
  rather than what is tidy — and that they differ is exactly why each entry
  carries its own reply.
**Provenance is recorded beside the table.** The Aruba banner is from
hardware; the two FortiOS lines were proven earlier; **the rest are from
vendor documentation and have not met a device**, the same standing D-026
gives the stacking parsers.
**Why a wrong entry is cheap in one direction only:** one that never matches
leaves behaviour exactly as it was, while one that matches wrongly sends a
keystroke into somebody's session. Hence literals, never patterns — and a test
asserting `Continue? (y/n)`, `Proceed with reload? [confirm]` and
`Save? [yes/no]` are still refused.

### LT-377 — "Authenticating" covered two phases that fail for different reasons — 2026-09-21
**Source:** debugging LT-375. An Aruba 2930M sat on **Authenticating** for a
full minute and then failed, and the state gave no way to tell whether the
login had failed or had plainly succeeded and the device was holding a banner
open. Both look identical, and they need entirely different answers.
**`SshProgress` went straight from `Authenticating` to `Ready`**, and `Ready`
is only sent once a prompt has been read. So everything between the password
being accepted and the device drawing a prompt — the banner, the keypress
wait, a slow shell — was reported as authentication.
**Fixed:** a state of its own. `OpeningShell` is sent the moment authentication
returns, before the prompt is read, and the table shows **"Logged in, waiting
for a prompt"**. A device stuck there has credentials that work and something
else wrong; a device stuck on **Authenticating** does not.
**Small, and it pays for itself the first time somebody debugs a login.** The
cost of the ambiguity was a full round trip of guessing on a device that had
already let us in.

### LT-376 — **bug** The arranged diagram packs devices too tightly to read — 2026-09-21
**Source:** two screenshots of a first discovery after LT-371, 2026-09-21:
"devices on each other and some links don't show because the devices are so
close to each other".
**The spacing was measured against the wrong thing.** `hierarchicalLayout`
spaces by `n.width + columnGap`, and the node it is given is the **glyph box**,
176 x 96. A discovered node does not render as a box: under it sit three lines
of text — the hostname, the address, and what the device is — and names like a
full FortiSwitch serial are wider than the glyph and taller than the box. So
the boxes never overlapped and the labels always did, and a link running behind
a neighbour's label is a link nobody can see.
**Fixed by spacing for what is drawn rather than for the glyph**: a discovered
arrangement asks for gaps that clear three lines of label, and the rows are
spaced the same way. The button-driven **Arrange top to bottom** keeps the
tighter defaults, because a diagram somebody has been working on has labels
they have already dealt with.
**Not fixed by zooming out.** Zoom changes what the screen shows and not what
the diagram is; a drawing that is wrong at 100% is wrong when it is printed.

### LT-375 — **bug** A switch that says "Press any key to continue" is never reached — 2026-09-21
**Source:** an Aruba 2930M-48G-PoE+ on WC.16.10.0009, 2026-09-21. The crawl sat
on `Authenticating` and eventually timed out; PuTTY connected to the same
switch without trouble, SecureCRT did not.
**Authentication was never the problem.** The device authenticates, prints its
banner — the HPE copyright and restricted-rights legend — and then waits on:

    Press any key to continue

Only after a keypress does it draw a CLI prompt. `read_raw_until_prompt` waits
for a prompt that, until something presses a key, will never be drawn, so the
session hangs and the failure is reported against the login.
**Why PuTTY worked and two other clients did not**: a person at a terminal
presses a key without noticing they have done anything. A program has to be
told.
**The shape of the fix already existed.** The same loop already answers
`--More--` by sending a space and carrying on; a banner waiting on a keypress
is the same situation one step earlier, and is answered the same way.
**`is_paging` was not widened to cover it**, deliberately. Paging means "there
is more of this output"; a banner means "I have not started yet". They are
answered with the same keystroke but they are different conditions, and a
capture that confused them would strip the wrong thing (`strip_paging` removes
paging markers from output — a banner is not a marker and must survive intact
so that anyone reading a saved session sees what the device said).
**Fixed:** `wants_keypress` recognises the wait, the read loop answers it with
a newline and keeps reading, and the banner stays in the transcript.

### LT-374 — **bug** A seed outside the subnet limit was dropped, so the crawl reached nothing — 2026-09-21
**Source:** a scan that reached nothing, and a dry run that diagnosed itself
perfectly: `10.254.254.247 — outside the subnet limit, not dialled`, with the
limit set to `10.10.115.0/24`. Then: "my seed device is different from the Stay
inside these subnets not sure if that matters but it needs to work".
**It mattered, and the app was wrong rather than the operator.**
`discovery.rs:445` passed the subnet filter into `resolve_seeds`, so a seed
outside the limit was removed before the crawler ever saw it. The crawler
itself never did this — `crawl_from` pushes every seed at hop 0 unconditionally
— so the rule existed only in the layer above.
**Fixed, with the reasoning recorded as D-053.** A seed is an address somebody
typed and pressed scan on; the subnet limit is a containment rule for where a
crawl *spreads*. Conflating them meant the run reached nothing and looked
broken. `should_crawl` still checks every neighbour, so a crawl seeded outside
the limit contacts exactly the one device named and spreads nowhere.
**The dry run now says the true thing** rather than its opposite: "outside the
subnet limit — dialled anyway, because you named it; its neighbours are not
followed". A seed pasted by mistake is still visible before anything is sent.
**Worth noting what the dry run got right.** It predicted the outcome exactly,
which is what it is for — the fault was in the behaviour it was faithfully
describing.

### LT-373 — The crawl offered at most eight hops — 2026-09-21
**Source:** "the hops should be more than 8 so it works on real enterprise
networks", with a screenshot of the scan settings.
**He was right, and the limit was only in the dropdown.** `discovery.rs:349`
has always clamped the value to `0..=32`, and the crawler honours whatever it
is given. The picker offered `1, 2, 3, 4, 6, 8` and nothing above — so a
network deeper than eight hops could not be crawled to its edge no matter what
the engine could do.
**Eight is genuinely short for an estate.** A campus core down through
distribution, an access switch, a WAN hop, a branch router and its access layer
is readily a dozen; the default of four stays, because most people start small
and a deep crawl is a deliberate choice.
**Shipped:** `1, 2, 3, 4, 6, 8, 12, 16, 24, 32`.

### LT-372 — A device that speaks only `hmac-sha1-96` cannot be reached — open, blocked upstream
**Source:** reported 2026-09-21 with the app's own message, which is worth
keeping because it diagnosed itself exactly:

    No common Mac algorithm - ours: ["hmac-sha2-512-etm@openssh.com",
    "hmac-sha2-256-etm@openssh.com", "hmac-sha2-512", "hmac-sha2-256",
    "hmac-sha1-etm@openssh.com", "hmac-sha1"], theirs: ["hmac-sha1-96"]

**Not a gap in our list.** `network_device_algorithms` already extends russh's
defaults with SHA-1 for exactly this reason (LT-054), and that trade is written
down where it is made. The missing algorithm is not one we declined to offer:
**russh 0.63.1 does not implement `hmac-sha1-96` at all.** Its `ALL_MAC_ALGORITHMS`
holds six entries and that is not among them.
**Nor can it be added from here, and this was checked rather than assumed.**
`mac::MACS`, the map from a name to an implementation, is `pub(crate)`; and
`pub struct Name(&'static str)` keeps its field private, so a name russh does
not already know cannot even be constructed outside the crate. There is no
registration hook. Adding it needs a change to russh — which is small, because
`CryptoMacAlgorithm<Hmac<Sha1>, U20>` is already generic over the output length
and `hmac-sha1-96` is the same construction at `U12`.
**What the operator can do today**, in the order worth trying:
1. **Offer a second MAC on the device.** Most kit locked to `hmac-sha1-96` can
   be told to accept more — on IOS, `ip ssh server algorithm mac hmac-sha1
   hmac-sha2-256`. This is the real fix where the device allows it, and it
   improves the device rather than weakening the app.
2. **SNMP.** A crawl already falls back to it, and it gives identity, LLDP
   neighbours and the forwarding table without SSH at all.
3. **Telnet**, which the crawler supports, where the device is on a management
   network that justifies it.
**What this item is for:** an upstream patch to russh adding the algorithm, or
a vendored fork if one is ever warranted. Either is a deliberate decision about
a dependency and neither should be taken quietly, so it waits here rather than
being half-done.
**Worth saying plainly:** `hmac-sha1-96` is a truncated SHA-1 MAC and weak. The
same argument recorded at LT-054 applies — the honest options are to support it
or to not manage the device — but it is a weaker algorithm than anything
currently offered, and the operator should prefer option 1 where the device
permits it.

### LT-371 — A discovered diagram arrives arranged, without moving anything already drawn — 2026-09-21
**Source:** the same screenshot as LT-370 — a grid of boxes with links crossing
the whole canvas — and "help me with a way to organize the diagrams
automatically right after we discover the network".
**This conflicts with D-023 and D-029 as written**, and those are the
operator's own decisions of 2026-09-12: *"discovery never moves anything on its
own — a layout runs only when the operator presses the button"*. Said so rather
than reversed quietly.
**What the decision protects is a drawing somebody made.** The fear is a
re-crawl rearranging an hour's work. A device the crawl is adding **for the
first time** was never placed by anyone, and `buildTopology` currently drops it
at `origin + index * COL` — a grid by hop distance, which is the screenshot.
**Agreed with him, 2026-09-21:** arrange **only the nodes being added**, at the
moment they are added; never touch a node that already exists. D-023 stands
untouched — nothing anyone placed is moved — and a first crawl of a network
arrives shaped like a network instead of a grid. On a re-crawl the handful of
new devices are placed clear of the existing drawing rather than stacked on the
origin.
**Reuses `hierarchicalLayout`**, which is already what the **Arrange top to
bottom** button runs, rather than a second layout engine.
**He also asked** that an explicit re-arrange work on a selection as well as
the page. `autoLayout` already does exactly that for radial, force-directed and
orthogonal (LT-177); only the hierarchical `flowLayout` was page-only, so it is
made to match rather than designed anew.
**Acceptance:** new nodes are arranged by tier; an existing node is never
moved; a re-crawl's additions land clear of what is already there; and
`flowLayout` honours a selection of two or more.
**Shipped, and one thing had to change shape on the way.** The first attempt
handed the whole job to `hierarchicalLayout` and a test caught it: that layout
tiers by *what a device is*, so a chain of three switches flattened into one
row of peers and the hop distance — the one thing the crawl actually
measured — was thrown away. **The test was right and was not weakened.**
What ships takes **the x only**: rows stay the distance from the seed, and what
is taken from the layout is the ordering within a row, which is where the
crossing reduction lives. Nodes already on the page are never read for position
and never written; new ones land below the lowest of them.
`flowLayout` now matches `autoLayout`: the selection when two or more devices
are selected, otherwise the page.

### LT-370 — Everything a crawl did not log into is drawn as "Unknown" — 2026-09-21
**Source:** a screenshot of a real discovered diagram, 2026-09-21: twenty-odd
devices, every one of them labelled **Unknown**, in a grid with links crossing
the whole canvas. Two separate faults; this is the first.
**`classify()` only ever sees three things** — the platform string, the
advertised capabilities and the version banner (`classify.rs:26`). A device the
crawl logged into has all three. **A device it merely saw has none of them**:
a MAC on a switch port, an ARP entry, a DHCP lease or a swept host arrives with
a vendor name from the OUI registry and nothing else, and
`snmp_topology.rs:400` duly sets `class: None`.
**So the estate divides into the handful that answered SSH and the great
majority that did not**, and the majority is drawn as anonymous boxes. On the
operator's own network that is most of the picture.
**There is no OUI classifier**, although `fortios.rs:887` says "the OUI
classifier keeps its turn" — it was described in a comment and never written.
**What an OUI can and cannot say, because this is where the honesty is.** It
names the *maker*, not the *kind*. Apple makes no access switches, so an Apple
OUI on an access port is an endpoint and saying so is safe. Hewlett Packard
makes printers *and* switches, so "Hewlett Packard" alone says nothing and must
keep saying nothing. A VMware or Proxmox OUI is a virtual machine, which is a
server. The rule is therefore: **map only where the maker implies the kind, and
return `None` everywhere else** (D-050).
**Acceptance:** a vendor classifier used only as a last resort, after platform,
capabilities and the FortiGate's own words; unambiguous makers mapped;
ambiguous ones explicitly left unknown, with a test that names them.
**Shipped.** `class_from_vendor` is the last resort, used where the crawl
learned nothing better: on every MAC a switch reported (`snmp_topology.rs`) and
on a FortiGate endpoint whose own `hardware_type` said nothing — which is the
turn `endpoint_class`'s doc comment promised and nothing had ever taken.
**Mapped:** hypervisors to servers (VMware, Proxmox, Xen, QEMU); camera makers;
printer makers; desk-phone makers; and the wide middle of personal and IoT
kit — Apple, Samsung, Google, Amazon, Ring, Nest, Espressif, Raspberry Pi and
the rest — to endpoints.
**Refused, by name and with a test:** Hewlett Packard, Cisco, Canon, Epson,
Ubiquiti, Netgear, Fortinet, Juniper, Dell and Intel. Each builds more than one
kind of thing, so each stays Unknown. Guessing "printer" from Hewlett Packard
puts a printer glyph on somebody's core switch.
**Measured on the operator's own network**, not only on fixtures: MACs that
came back `None` for every row now classify where the maker is unambiguous —
Intel, Nest Labs, Ring and Texas Instruments among them. The rows still showing
nothing are **randomised privacy MACs**, which have no OUI to look up and are
genuinely unknowable from a MAC alone.

### LT-369 — **bug** Every access point is drawn as a wireless controller — 2026-09-21
**Source:** found while writing the reproduction for LT-360, 2026-09-21.
**`roles.ts:69` puts a controller and an access point in the same role:**

    if (d.class === 'wireless-controller' || d.class === 'access-point') {
      out.set(key(d.hostname), { role: 'wireless', … });

and `ROLE_TYPE.wireless` is `'wireless-controller'`. `topology.ts:680` prefers
an inferred role over the device's own class — `e.role ? ROLE_TYPE[...] :
CLASS_GLYPH[e.klass]` — so an access point the crawl correctly identified as an
access point is **drawn with the controller glyph**. `CLASS_GLYPH` has the
right answer and never gets asked.
**Why it matters more than a wrong picture.** A controller and an access point
are different devices in different places doing different jobs, and a diagram
that shows three controllers where there is one controller and three APs is
wrong about the shape of the network. On the operator's own estate every
FortiAP draws as a controller.
**The role itself is not wrong** — an access point *is* wireless, and grouping
by role for layout is right. The fault is that one role maps to one glyph, so
the glyph loses what the class already knew.
**Fixed:** `ROLE_TYPE` is for layout; the glyph now comes from the class
whenever the class is more specific than the role. An access point draws as an
access point and keeps the wireless role.
**Checked:** a unit test per class, and the LT-360 reproduction that found it.

### LT-368 — The enterprise lab, and what each technology was for — 2026-09-20
**Source:** "make the lab enterprise level", "did you do mpls / segment routing
/ ipv6 / dmvpn", and "hundreds of routes to benchmark coreview".
`Coreview Path Lab` now carries, all verified running rather than merely
configured:
- **MPLS with LDP** — two LDP peers in `Oper` and **259 label forwarding
  entries** on one router.
- **MPBGP VPNv4** — a VRF on one PE filled by the other over the core.
- **IPv6 with OSPFv3** — which is what found LT-365.
- **DMVPN** — an mGRE hub with two spokes registered dynamically over NHRP,
  carrying **EIGRP** over the tunnel.
- **IS-IS level-2** with wide metrics.
- **Segment routing**, on two CSR1000v running IOS-XE 16.12.05.
- **311 static routes** redistributed into OSPF, which is what found LT-367.

**Why each one is there is worth stating, because it is not obvious.**
Coreview has **no MPLS, LDP, NHRP or segment-routing parser** — none of those
protocols is read directly, and building them proves nothing on its own. What
they are for is the **route codes** they put in a routing table, which *is*
parsed: `D` from EIGRP over the DMVPN tunnel, `i L2` from IS-IS, `O E2` from
redistribution, `B` from VPNv4, `LC` from an IPv6 loopback. LT-365 was a
missing code; every new protocol is another chance to find the next one.
**Each was checked against the parser, not assumed.** `i L2` reads as `isis`
with metric `[115/20]`; `D` reads as `eigrp` with `Tunnel0` correctly kept as
the interface; the classful `O E2` block reads in full since LT-367.
**IOS-XE is no longer an unverified claim.** `VrfDialect::Cisco` said its
IOS-XE half "has still not been seen". A CSR1000v on 16.12.05 has now answered
`show vrf` (two VRFs, both parsed with their RDs and interfaces),
`show ip route vrf *` (which works) and `show ip route vrf all` (which it
refuses, exactly as IOS does). The source says so now.
**One tooling trap, recorded because it nearly caused real damage.**
`examples/try_commands.rs` prints at most 400 lines and appends `... N more`.
Capturing a 528-line configuration through it produced a file that was
truncated mid-table with no `end` — which was almost written back into the lab
as a device's saved configuration. Long captures now go through a console
reader instead. The example is a developer tool and the cap is reasonable for
reading; it is simply not a capture mechanism.

### LT-367 — **bug** Most of a real routing table is silently dropped — 2026-09-20
**Source:** a deliberate scale test, 2026-09-20 — "hundreds of routes to
benchmark coreview". 250 static routes were redistributed into OSPF so a router
would hold a table the size of a real one. It held **267 routes**.
**`parse_routes` read 17 of them.**
**IOS writes a classful block without repeating the mask.** Where several
subnets of one classful network share a mask, the mask goes on a header line
and every row underneath carries a bare address:

          172.20.0.0/24 is subnetted, 250 subnets
    O E2     172.20.0.0 [110/20] via 172.16.13.2, 00:00:52, Ethernet0/2
                        [110/20] via 172.16.12.2, 00:00:52, Ethernet0/1

`routes.rs:235` requires a `/` in the prefix — `split_once('/')` and `continue`
on failure — and the `subnetted,` header is skipped at `:218` **without
remembering the mask it carries**. So every row in such a block is dropped, and
the larger and more realistic the table, the more is lost.
**This is not an exotic shape.** It is what IOS prints for any classful network
with more than one same-masked subnet, which is most enterprise tables. The
fixtures in this repository are all small and all "variably subnetted", where
each row does carry its own mask — which is exactly why 815 tests never saw it.
**What it costs.** Everything downstream reads this: the path engine traces
through routes it was given, so a destination inside a dropped block reports
`insufficient` — a confident "I cannot tell you" about a route the device
plainly holds. That is worse than the honest gap D-050 is written to protect.
**Acceptance:** the mask from a `is subnetted` header applies to the bare rows
beneath it; a `variably subnetted` block still takes each row's own mask; a
fixture of the real shape above, failing before the fix; and the lab's own
267-route table parses to 267.
**Fixed, and measured on the router that found it.** The test failed first,
returning two prefixes where five were written. The parser now remembers the
mask a `is subnetted` header carries and gives it to the bare rows beneath,
and clears it on a `variably subnetted` header so nothing leaks between blocks.
**The same crawl of the same router went from 17 routes to 280** — and the
other three routers in the lab from the same handful to 278, 279 and 281.
**The SSH layer was never at fault**, which was worth checking before blaming
it: the full table always arrived, and the parser discarded seven eighths of it.

### LT-365 — **bug** An IPv6 route to the router's own address is filed as `other` — 2026-09-20
**Source:** the lab, on an IOS 15.7 router carrying OSPFv3 over an MPLS core.
Every loopback row in `show ipv6 route` came back with protocol `other`:

    LC  2001:DB8:255::41/128 [0/0]
         via Loopback0, receive

**`protocol_of` knows `C` and `L` but not `LC`**, the code IPv6 uses for a
*local connected* address — the device's own address on its own interface — so
the row fell through to the word the parser reaches for when it recognised
nothing. `RL`, the redistributed form, was missing for the same reason. Both
now read as `local`, which is what `L` already meant in IPv4.
**Found only because the lab had IPv6 at all.** The one captured IPv6 table in
the repository came from a switch with a single static route and no loopbacks,
so no fixture had ever contained an `LC` row.

### LT-366 — A lab that exists to argue with the parsers — 2026-09-20
**Source:** "build more labs and configure more large labs to get valide trace
path", and "make one giga lab". Three labs on the operator's EVE-NG, all kept:
- **`Coreview VXLAN EVPN`** — a Nexus 9000v spine and two leaves with an OSPF
  underlay, iBGP EVPN with the spine as route reflector, an L2 VNI and an L3
  VNI carrying a VRF, and two hosts generating real type-2 routes.
- **`Coreview Path Lab`** — five IOL routers as an MPLS core: OSPF and LDP
  everywhere, MPBGP VPNv4 between the two PEs, a VRF whose table is filled by
  the far PE, IPv6 with OSPFv3 alongside, and **two equal-cost paths** from one
  end to the other so ECMP is exercised rather than assumed.
- **`Coreview IOL Validation`** — the smaller IOS VRF lab that found LT-361,
  LT-362 and LT-363.

**Every device config is stored in the lab file itself**, through EVE-NG's
config API, so each lab reloads as it was. The Nexus refused
`copy running-config startup-config` — a known quirk of that image — so the
configs were read over SSH and written into the lab instead, which works
regardless.
**What the labs proved.** The route parser reads both equal-cost next hops from
a real ECMP row; the IPv6 parser reads a 13-route OSPFv3 table including IPv6
ECMP over link-local next hops; the per-VRF parser reads an MPLS L3VPN table
whose routes arrived by BGP; and `probe_overlay` reads a live VXLAN fabric —
two VNIs with the L3 one carrying its VRF, the NVE peer, and nine EVPN type-2
routes.
**What they cannot prove, and why it is written here rather than implied.**
Coreview has **no MPLS, LDP or segment-routing parser at all**, so building
those validates nothing directly — they are in the lab because an MPLS L3VPN
produces the realistic BGP-filled VRF tables that the parsers *do* read.
**Unfinished, honestly:** the Aruba CX node boots but its console stayed silent,
so no AOS-CX parser has met hardware and LT-136 stays blocked; and the ASAv
enforces an enable-password dialog that defeated the console driver, so its
route format is still uncaptured. Both are in the lab and both are worth
another attempt; neither is claimed as done.

### LT-364 — **bug** NX-OS reports no uptime, because it brackets its plurals — 2026-09-20
**Source:** crawling the lab fabric. All three Nexus printed `uptime Nones`
while `show version` on each plainly said otherwise:

    Kernel uptime is 0 day(s), 0 hour(s), 23 minute(s), 42 second(s)

**`parse_uptime` reduced a unit with `trim_end_matches('s')`**, so `day(s)`
became `day(` and matched nothing — every unit failed, and the whole line was
discarded as unreadable. The bracket has to come off before the `s` does.
**This is the third platform family in a row whose uptime was silently
dropped**, after LT-358 (anything reached over SNMP) and LT-359 (all of
FortiOS). Each had a different cause — a discarded field, an unasked command,
and now a plural spelling — and each was invisible to the test suite because
every fixture used the one shape that worked.
**Fixed and confirmed on the devices that found it:** the same crawl now reads
about 24 minutes for all three, matching what they printed.

### LT-361 — **bug** The one-command-per-VRF-set command is rejected by IOS — 2026-09-20
**Source:** the EVE-NG lab, 2026-09-20, on IOL `i86bi_LinuxL3-AdvEnterpriseK9-M2`
running IOS 15.7(3), configured with two VRFs.

    PE1#show ip route vrf all
    % IP routing table vrf all does not exist
    PE1#show ip route vrf *
    <the global table, then Routing Table: CORP, then Routing Table: GUEST>

**`all_command()` returns `show ip route vrf all` for `VrfDialect::Cisco`**
(`vrftables.rs:84`), and `dialect_for` puts IOS, IOS-XE **and** NX-OS in that
one variant (`vrftables.rs:122`). The command was verified against a real
Nexus, where it is right. On IOS it is simply refused, so LT-351's whole
point — one command instead of one per VRF — never happens on the platform
most people point this at.
**It degrades rather than breaks**, which is why no test caught it: the error
text yields no tables, `answered` stays false, and the crawl falls back to a
command per VRF. The cost is a wasted round trip and a claim in the docs that
is not true of IOS.
**Deliberately not fixed until NX-OS had answered**, rather than guessed at.
It answered the same evening, on a Nexus 9000v 9.3.3 in the lab:

    SPINE1# show ip route vrf *
    No IP Route Table for VRF "*"

So neither spelling works on both, and there is no single command that serves
them. `VrfDialect` gained an `NxOs` variant: `dialect_for` reads `nx-os` or
`nexus` in the banner, `all_command` gives `vrf all` to NX-OS and `vrf *` to
IOS, and everything else about the two — the list command, the per-VRF
command — stays shared, because those are genuinely the same.
**Both halves are now verified on hardware**, which is why `Cisco` may claim it
too: IOS 15.7 answered every command in the lab, and a Nexus answered every
command twice — once as a real leaf on 2026-09-20 and once here. IOS-XE 16.x
is still unseen and the source says so.

### LT-362 — **bug** A real IOS per-VRF route table is not recognised at all — 2026-09-20
**Source:** the same capture. `parse_vrf_tables` read **0 tables** from 53
lines of real `show ip route vrf *` output holding a global table and two VRFs.
**`table_header` (`vrftables.rs:405`) expects the literal word `VRF`:**

    .or_else(|| t.strip_prefix("Routing Table: VRF"))

IOS prints `Routing Table: CORP` — the name, with no `VRF` before it. The
prefix never matches, so every VRF table in the output is invisible. This was
written from documentation (D-051) and the documented shape was wrong, the same
way three of four NX-OS parsers were wrong when a Nexus first answered.
**Acceptance:** a fixture of the real IOS shape, failing before the fix; the
NX-OS `IP Route Table for VRF "x"` form still read; and the global table that
precedes the first header still attributed to the global table rather than to
the first VRF.

### LT-363 — **bug** A device prompt is read as a VRF — 2026-09-20
**Source:** the same session. `parse_vrf_list` on real `show vrf` output
returned three VRFs: `CORP`, `GUEST`, and **`PE1#`**.
**Any line with a first token becomes a VRF**, so a prompt left on the end of a
capture becomes a phantom VRF, and the crawl would then run
`show ip route vrf PE1#` against the device. `examples/parse_capture.rs` exists
precisely because people paste captures, and a pasted capture always carries
its prompts.
**Acceptance:** a VRF row must look like one — a trailing `#` or `>` on a
single token is a prompt, not a VRF name. Fixture from the real output,
failing first.

### LT-360 — One access point is drawn twice — it was not, and the reproduction found a real bug — 2026-09-21
**Source:** the lab crawl on 2026-09-20. Two access points each appear twice in
one crawl, under the same name, at two different addresses — and the address
the switch advertises answers nothing at all.
**The evidence, gathered rather than reasoned.**
- The Catalyst's LLDP says the AP is at one address, with a chassis id ending
  `…b7a2`, on Gi0/8.
- The FortiGate that manages the same AP, by the same name, reports it at a
  different address.
- Only the FortiGate's address answers: ICMP replies and ARP resolves to a MAC
  ending `…b7a0`. The LLDP-advertised address leaves ARP `FAILED` — nothing is
  there. The AP moved, by DHCP, and is still advertising its old management
  address over LLDP.
- The two MACs differ in the last octet: the AP's wired port and the interface
  it advertises are not the same interface, so **a join on MAC cannot work.**
**Neither reading is wrong, which is why this needs a decision.** LLDP really
does say that address; the FortiGate really does say the other; Coreview
reports both faithfully. The fault is that nothing reconciles them, so an
engineer sees two access points where the rack holds one, and one of the two
can never be reached.
**What joins them is the hostname**, which matches exactly, together with the
device class and the vendor. That is weaker evidence than LT-126's existing
joins (a MAC, or an address a sweep already drew), and merging two records on a
name alone is the kind of guess D-050 exists to refuse. The alternative is to
keep both and *say* that one address answered nothing — which is honest, and
which the crawl already knows, but which still draws two glyphs.
**Deliberately not fixed on the spot.** Merging devices changes what the
diagram claims about somebody's network, so it is the operator's call, not a
judgement to slip into a bug-fix commit. The two candidates are: join on
hostname within one crawl when the classes agree; or keep them apart and mark
the unreachable one on the diagram and in the review.
**Reproduced first, and the reproduction disagreed with the report.** Built as
a `buildTopology` test with the exact shape — a switch whose LLDP names an
access point at an address it has moved off, and the controller reporting the
same access point where it actually is — the diagram draws **one** node, at
the address that answered. It was never drawing two.
**`identity` already folds on the short name** (LT-126, LT-132), precisely so
that CDP's `SW1.example.com`, LLDP's `SW1` and a prompt's `sw1` are one device,
and `note()` prefers a reached sighting over a neighbour's report of it. What
showed two was `examples/crawl_network`, which prints reached devices and each
device's neighbours as **two separate lists** — by design, and I read a console
layout as a defect.
**Closed as not a defect, with the behaviour pinned** so a future change to
`identity` cannot quietly bring a duplicate back.
**The reproduction did find a real bug**, which is the argument for writing one
even when the answer looks obvious: every access point was being drawn with the
wireless-controller glyph. That is **LT-369**.
**Still true, and worth saying:** the switch really is advertising an address
the access point has moved off, and ARP for it fails. Coreview reports what
LLDP said, which is correct; the stale advertisement is the network's to fix.

### LT-359 — A FortiOS device says how long it has been up — 2026-09-20
**Source:** the lab crawl on 2026-09-20. Every FortiOS device reached over SSH
— a FortiGate-60F, a FortiSwitch-224E and three FortiAPs — printed
`uptime Nones`, while the one Catalyst in the same run reported 62 days.
**This is not the same fault as LT-358, and the difference matters.**
`crawl.rs:1193` gives FortiOS `DeviceDetails::default()` **on purpose** — "a
platform whose output has been captured and parsed — FortiOS is not one yet,
and gets nothing rather than a misreading". That is D-050 applied to a
collection gap, the same call taken for FortiOS VDOM route tables at D-051, and
it stays. Nothing here claims routes, VLANs, ports or spanning tree for FortiOS.
**Uptime is the one field the device states plainly**, and both platforms in
the lab answered the same documented command:

    Uptime: 8 days,  22 hours,  55 minutes      (FortiGate-60F, 7.6.7)
    Uptime: 22 days,  18 hours,  56 minutes     (FortiSwitch-224E, 7.6.1)

It is `get system performance status`, not `get system status` — which is why
the crawl never saw it; `get system status` carries the version and serial and
no uptime at all.
**Two small things, and no more than that.** `uptime::parse_uptime` reads only
the IOS shape, `HOST uptime is 8 weeks, 2 days`, so it must also read the
`Uptime:` form; and the FortiOS branch must ask the question. Everything else
about FortiOS details stays exactly as it is.
**Acceptance:** `parse_uptime` reads both shapes, including the doubled spaces
FortiOS prints; a test fails before the fix; and the lab crawl shows a real
uptime for the FortiGate and the FortiSwitch afterwards.
**Shipped, and checked on the two devices that found it.** The same crawl now
reads the FortiGate at about 9 days and the FortiSwitch at about 22.8 days,
both matching what the devices printed minutes earlier. The three FortiAPs
still say nothing, which is right: they are reported by the FortiGate rather
than logged into, so no one asked them anything.

### LT-358 — **bug** A device reached over SNMP reports no uptime, though SNMP gave one — 2026-09-20
**Source:** found on real hardware, 2026-09-20, crawling a Catalyst 2960CX over
SNMP v3 from the lab subnet. The crawl printed `uptime Nones` while
`examples/snmp_probe` against the same switch a minute earlier read
`uptime : Some(537977440) ticks` — about 62 days.
**`crawl.rs:1024` builds the SNMP-reached device with
`details: DeviceDetails::default()`**, although `identity.uptime_ticks` is in
scope on the same expression and is already used there for the serial and the
description. `details.uptime_seconds` is only ever filled at `crawl.rs:1512`,
from `show version` text — the SSH path. So the number is collected and thrown
away, which is the same fault as LT-357's discarded `seed`.
**Acceptance:** a unit test on `device_from_snmp` — a `SnmpIdentity` carrying
`uptime_ticks` produces a device whose `details.uptime_seconds` is the ticks in
hundredths converted to seconds, and one carrying `None` still produces `None`
rather than a zero. It must fail before the fix.
**One caveat to write down in the code:** SNMP `sysUpTime` is the agent's
uptime in hundredths of a second and wraps at about 497 days, so it is not
always the box's uptime. That makes it worth reporting, not worth pretending
it is the same figure `show version` gives.
**Reproduced, fixed, and checked against the switch that found it.** The unit
test failed first — `None` where the device had said 537,977,440 ticks. After
the fix the same crawl of the same 2960CX read `uptime Some(5379972)s`, about
62 days. Two tests: the conversion, and that a device which answers no
`sysUpTime` still reports `None` rather than a zero.
**This is the first thing the lab found.** It was invisible to every test in
the repository because no fixture carried an SNMP uptime, and invisible in
normal use because the SSH path fills the field from `show version` — it only
shows on a device reached by SNMP alone.

### LT-355 — **bug** Clicking a device re-fits the page, which reads as zooming out — 2026-09-20
**Source:** "when I click a device it zooms out", 2026-09-20, with a screenshot
showing the diagram as a speck in the corner of the sheet and the inspector
open on the device just clicked.
**Reproduced by reading, not yet by a test.** `Canvas.tsx:899-905` is the
LT-348 effect that fits the page when something asks for it:

    const fitRequest = useStore((s) => s.fitRequest);
    useEffect(() => {
      if (fitRequest === 0) return;
      const timer = setTimeout(() => fitEverything(), 60);
      return () => clearTimeout(timer);
    }, [fitRequest, fitEverything]);

`fitEverything` is a `useCallback` over `[pg.canvas.sheet, pg.canvas.sheetRect,
pg.nodes, rf]`. Clicking a node makes React Flow send a `select` change, which
`onNodesChange` (`store.ts:2039`) turns into a **new nodes array**. So `pg.nodes`
changes identity, `fitEverything` changes identity, and the effect runs again —
but the only guard is `fitRequest === 0`, which stops being true the moment
anything has ever asked for a fit. Nothing re-checks *whether the request is a
new one*.
**Why it looks like it started recently:** `requestFit()` has exactly one caller,
`PathTracePanel.tsx:235`, the LT-348 "make an application page" button. Before
that button is pressed in a session the effect is inert and clicking is fine;
after it, every click on a device re-fits the whole sheet 60 ms later. That
matches the report arriving alongside the path-trace work.
**Acceptance:** an e2e check in `e2e/canvasfix.mjs` that requests a fit, pans or
zooms somewhere deliberate, clicks a device, and asserts the viewport is where
it was left. It must fail before the fix. The fix is to drive the effect from
the request alone — the fit function read through a ref, or the last-served
request number remembered — not to remove the fit.
**Reproduced, then fixed.** The check failed first, exactly as described: the
viewport read `268,130` after a deliberate pan and `178,70` after a click on a
device, the fitted position. `fitEverything` now lives in a ref and the effect
depends on `fitRequest` alone. Four checks cover it: a click moves nothing
before a fit is ever requested, a click moves nothing after one is, the
selection does not dirty the document, and a *move* still does — so the fix
cannot have gone too far. `canvasfix` is 42 checks green.

### LT-356 — **bug** Selecting a device marks the project unsaved — 2026-09-20
**Source:** found while reading LT-355; not reported.
**`store.ts:2039` sets `dirty: true` for every node change**, and a selection is
a node change. Clicking a device with nothing else done makes the document
dirty, so the title shows unsaved work, autosave writes a document that is
byte-for-byte what was already stored, and closing can prompt about changes
nobody made.
**Acceptance:** a check that clicking a device does not set `dirty`, and that
moving one still does. Selection is view state, not document state.
**Reproduced, then fixed.** `onNodesChange` now dirties the document only when
some change is not a `select`. Both halves are checked in `e2e/canvasfix.mjs`.

### LT-357 — The trace panel's run picker says too little — 2026-09-20
**Source:** "what is routing from and where did that come from?", 2026-09-20 —
the control was not self-explanatory to the person who asked for the feature.
**Three things, none of them a crash.**
- **The label collides with the field beside it.** "Routing from" sits to the
  left of "Source"; both read as where the packet starts. It actually chooses
  *which saved crawl to read routing tables out of*.
- **The options end in a bare number** — `{takenAt} — {devices}` at
  `PathTracePanel.tsx:261` — with nothing saying it counts devices, and it
  counts devices *reached*, not devices that returned a routing table. A run can
  read "— 6" while two of them hold a table. The panel prints the honest pair
  lower down, so the dropdown is the only misleading surface.
- **`seed` is fetched and discarded.** `ipc.listCrawlRuns` returns
  `{ id, takenAt, seed, devices }`; the panel's state type keeps three of the
  four. With two runs 42 seconds apart the date cannot say which part of the
  network each covered, and the thing that would is already in hand.
**Acceptance:** the label names the crawl, the option says what the number
counts, and the seed appears. No engine change.
**Shipped, all three.** The label is **"Routing data from"**, which no longer
reads as a second way of saying "Source". Each option now reads
`<when> — <n> devices from <seed>`, so the number says what it counts and the
seed says which part of the network that run covered — the field was already
being fetched and thrown away. The plural is an `Intl.PluralRules` form rather
than a ternary, per the i18n rule. No change to the engine, and `pathtrace`
stays 29 checks green.

### LT-354 — A second sweep, before anything goes public — 2026-09-20
**Source:** "no data from the show comands pushed to the public must be wiped
… no ip no pass no names nothing related to what I supplied you it was ment for
validation only so we build something works only". LT-353 swept the tree; this one re-ran the sweep against the three
commits that have not been pushed, because a push is the moment any of it
becomes public and nothing had left the machine yet.
**Three things were found and all three are fixed.**
- **The provenance line named the source's industry.** `docs/DECISIONS.md` and
  this file both named the sector the captures came from. The sector is itself
  customer information; both now say only "a production network".
- **The LT-129 entry named the operator's ISP and two cities** its backbone
  runs through — written from a live traceroute on his own machine, and missed
  by LT-353 because that sweep fixed the *code* fixture and not the prose
  describing it. Now "the gateway, then the ISP's edge and backbone".
- **One MAC in the Catalyst MAC-table fixture still had its device part** — a
  second one, a VMware NIC, in the same verbatim fixture LT-353 had already
  fixed a row of. Zeroed to its OUI like every other row.
**What was verified clean, as commands rather than as a claim.** No capture
file was ever added in any commit on any branch. The three unpushed commits add
3,045 lines and **no** IPv4 literal outside RFC 1918, RFC 5737, loopback,
link-local, CGNAT or multicast; the only fully-qualified names they add are
`example.net`. Every credential-shaped string in the tree is a manifest name,
an obviously-fake fixture, or prose about credentials. Every device serial is
zeroed or literal `TEST`. Every e-mail is an upstream package author's in the
generated notices. The VRF names in the new parsers are `CORP`, `GUEST` and
`default` — the textbook ones, not anybody's. The three dangling objects in the
store are the app's own source and an icon, and a push transfers only reachable
objects in any case.
**Two things are left deliberately, and both are the operator's own, not a
customer's:** the code-signing certificate subject in `docs/SIGNING.md` and in
this file, which ships inside every signed installer by design; and "Texas" and
"San Antonio" as the example hierarchy in `src/lib/ipam.ts` and its tests,
which are a folder naming illustration rather than anything observed. Say the
word and the second becomes two invented region names.

### LT-353 — Version 2.4.9, and a sweep of every file for anything that is not ours — 2026-09-20
**Source:** "clean up everything by going to each code line, each md line, each
script and validate it, make sure no customer or secrets, no customer info and
no public ip, no bugs and everything validated … also make this version 2.4.9".
**A backup first.** `git bundle create --all` into `~/coreview-backups/`,
verified as a complete history before a single file was touched.
**Four things were found and all four are fixed.**
- **`traceroute.rs` held a live capture of the operator's own internet path** —
  real public addresses and real ISP hostnames, which name his provider and his
  city. Replaced with documentation addresses and `example.net` names of the
  same shapes, because the shapes are what the tests are about: a hostname with
  its address in brackets, a mid-hop router change on an ECMP path, and the
  same case again with `-n`. All 14 traceroute tests still pass.
- **A hostname from a customer's network** survived in the ping-sweep fixtures
  and in the roadmap entry that quotes them.
- **One MAC in the Catalyst MAC-table fixture still had its device part**,
  where every other row in the same fixture was already zeroed to its OUI.
- **A chassis serial in a CDP fixture**, zeroed for the same reason.
**What the sweep covered, as commands rather than as a claim:** every tracked
file, for public addresses (allowing RFC 1918, RFC 5737 documentation ranges,
loopback, link-local, CGNAT and the benchmarking range); for real domains; for
credentials, keys and community strings; for the operator's lab and the
customer's names; for MACs with a device part; and for TODO/FIXME/`todo!()`.
**Everything left is meant to be there:** upstream package-author addresses in
the generated notices, the IEEE OUI registry's own vendor names, obviously-fake
test secrets (`s3cr3t-community`, `PLAINTEXT-DEVICE-SSH-4a91`), and the two
GitHub secret *names* the signing job reads.
**Version 2.4.9** in `package.json`, `package-lock.json`, `tauri.conf.json`,
all three `Cargo.toml`s and `Cargo.lock`, and in the example filename in
`docs/SIGNING.md`. No version is hardcoded in the app; it comes from the
manifest. The roadmap's record of a past `0.2.0` build is history and stays.
**Validated:** `tsc`, `eslint`, 1,254 front-end tests, 807 Rust tests across
the workspace, and `clippy -D warnings` — all clean. The e2e harnesses need a
running dev server and were not run.

### LT-352 — Arista, Junos and FortiOS, built from the documentation — 2026-09-20
**Source:** "build these per the latest documentations and knowlage bases and
articals", 2026-09-20, naming Arista EOS, Junos, FortiOS multi-VDOM, IOS-XE
`show vrf` and a real stack.
**Built under D-051, and every one of them says so.** `verified_against_hardware()`
stays **false** for Arista, Junos and FortiOS, and the fixtures say
"documentation-shaped, not captured" in as many words. NX-OS is the reason to
expect these to be wrong somewhere: three of its four parsers were, and that
was the platform the guides describe best.
**Junos needed a routing-table parser of its own** — it shares nothing with
either of the other two. The prefix and its paths are on separate lines,
`[Protocol/preference]` is the code and the distance together, `metric N` is
where the metric is, `> to X via Y` is a next hop and a second `to` under one
prefix is ECMP, and `Direct` is what it calls a connected route. `AS path: …`
and `validation-state: …` sit among the paths and carry numbers, and reading
either as a hop is the obvious way to get this wrong; both are skipped by
name. Picked by shape (`destinations,` and `routes (`), not by asking the
caller what the platform is.
**FortiOS needed almost nothing, which is worth saying.** Its table is the IOS
shape under a different header (`Routing table for VRF=0`), so the parser that
already existed reads it once that line is skipped. What it *did* need is a
VDOM listing, because a VDOM is configuration rather than a table — `== [ CORP ]`
or `edit "CORP"`, both read.
**FortiOS VDOM tables are deliberately left uncollected.** A VDOM is *entered*
(`config vdom`, `edit CORP`, the command, `end`), so no single line reads one
from outside it. `reads_tables_by_name()` says so and the crawl skips them:
the path engine then reports "no table held for that VRF" rather than an empty
one. A VDOM full of routes reported as empty would be the worse kind of wrong
(D-050).
**Arista needed three small things and one real parser.** `show vrf` heads its
first column `Vrf` with no Name column at all — the third heading in a row
that rule read as zero VRFs. Its `show ip route vrf` is IOS-shaped and needed
nothing. `show vxlan vni` and `show vxlan vtep` fell out of the existing
parsers. `show bgp evpn` did not: Arista names the route type in words
(`mac-ip`, `ip-prefix`, `imet`) where NX-OS brackets it, so `parse_evpn_arista`
reads that and skips `imet` for the same reason `[3]` is skipped — it places
no address anywhere.
**Junos EVPN, and the trap in it.** The NLRI is one colon-separated string,
and the VTEP a route came from is `from <address>` on the attribute line —
**not** the `to X via Y` under it, which is the underlay hop. Reading that as
the VTEP draws the tunnel to the wrong end, and there is a test that says so.
Junos also prints this device's own VTEP (`SVTEP-IP`) above the remote ones,
so reading every address on the page lists the device as its own peer; the
peer parser starts at `RVTEP-IP`.
**One more thing the Arista table taught the VRF parser:** `ipv4,ipv6` and
`v4:routing` start with a letter and contain a digit, which was enough to be
read as interface names. No interface has a comma or a colon in it.
**IOS-XE was already covered** — its `show vrf` is the Name/RD/Protocols/
Interfaces table the existing fixture is built from — and is still unverified
for the same reason as the rest.
**The stack parsers (LT-139) are unchanged.** They were already built from the
guides under D-026 and cannot be earned from more documentation; they need
`probe_stack` against a real stack.

### LT-351 — One command for every VRF table — 2026-09-20
**Source:** the operator ran `show ip route vrf all` on a Nexus leaf and
brought back the output, which is what asked for.
**Six round trips became one.** A Nexus with six VRFs was being asked
`show ip route vrf <name>` once per VRF; `show ip route vrf all` answers them
all, and `parse_vrf_tables` splits it on the `IP Route Table for VRF "<name>"`
header the device prints between them. The per-VRF path is kept as the
fallback for a platform that has no such command or refuses this one.
**An empty VRF comes back empty rather than missing, and that is the point.**
Three of the six VRFs in that capture hold no routes at all and the device
still prints their headers. "That VRF has no route to this address" and
"nobody collected that VRF" are different answers and the path engine gives
different ones (D-050), so the distinction survives into `vrfRoutes`.
**Also read from that capture:** a management-VRF static route with no
interface (`*via <gateway>, [1/0], 3w1d, static`) parses correctly, and
`show nve peers` at `terminal width 511` confirms the `Router-Mac` column
that 80-column wrapping had hidden — `n/a` where a peer has advertised none.
IOS-XE's `Routing Table: VRF <name>` and Arista's `VRF: <name>` are recognised
by the same splitter and neither has been seen on hardware.

### LT-350 — The Nexus routing table, and an overlay route the device names — 2026-09-20
**Source:** "Give me the commands you want to run and on what devices and i will
run it and bring you the output", 2026-09-20, and the captures he then ran
against a live VXLAN/EVPN fabric — a Nexus leaf and a Nexus spine.
**Why this is its own item and not part of LT-347:** LT-347 built VRF listings
and overlay commands. This is the *routing table*, which LT-200 already
collects for every device and which read **zero routes** on a Nexus. That is
the global table too, not only a VRF's, so it is a gap in what every crawl of a
Nexus has collected since LT-200.
**The four defects the captures found, each with a test that fails without the
fix:**
- **`parse_routes` read nothing at all from NX-OS.** The IOS table puts a code
  in the first column and the whole route on one line; NX-OS puts the prefix on
  its own line and indents the paths under it. `parse_nxos_routes` reads it,
  picked by shape (`ubest/mbest:`) rather than by asking the caller what the
  platform is — the same way the FortiSwitch MAC table is told apart (LT-332).
  46 of 46 prefixes in one captured table, 136 of 136 in another, ECMP pairs
  kept as pairs.
- **`show vrf` read zero VRFs on a Nexus.** The heading rule was "Name, plus RD
  or Interfaces"; NX-OS prints `VRF-Name VRF-ID State Reason` and has neither
  of those columns. Six VRFs read as none, and every VRF question the path
  engine could have answered was refused for want of a table.
- **An L3 VNI lost the VRF it carries.** `L3 [CORP]` — the bracket holds a VRF
  name where an L2 segment holds a VLAN. `Segment.vrf` keeps it, which is what
  joins a tenant route's `segid` back to a table with a name.
- **A MAC-only EVPN host claimed to live at 0.0.0.0.** NX-OS writes
  `…:[0]:[0.0.0.0]/216` for a type 2 it knows the MAC of and not the address.
  Repeating the placeholder back looks like an answer; it is now `None`.
**Two fields added to the route row, and both are evidence the device
volunteered.** `nextHopVrf` from `*via 203.0.113.4%default` — the next hop is an
address in *another* table, and resolving it in the tenant's own finds nothing,
so a path the device is perfectly happy with was reported unresolvable.
`segmentId` from `segid: 50000 tunnelid: 0x… encap: VXLAN` — the device
stating, in its own routing table, that this prefix is reached across the
overlay.
**The path engine now follows a routed L3 VNI**, which it could not before:
`segmentFor` matches an address against a segment's prefix, and an L3 VNI
carries a VRF rather than a VLAN so there is no prefix to match. The route is
the only evidence there is. It draws the same three steps the bridged case
does — into the overlay, the underlay traced on its own, out at the far end —
and refuses rather than inventing a far end for a VTEP nothing crawled holds.
**Nothing from the captures is in the repository.** They are a production
network; they stayed on his machine, were read for shape only, and
every fixture here is retyped with invented names, documentation addresses
(RFC 5737) and VNIs that are not his. `examples/parse_capture.rs` is how a
capture gets read by the parsers without a device to log in to.
**Also found, and not a bug:** the 80-column wrapping and the `--More--` in
those captures are the operator's own terminal, not something the app will
meet — its sessions ask for a 200-column PTY and send `terminal length 0`.
`--More--` glued to the front of a row is stripped anyway, because a capture
pasted in from elsewhere is a thing people will do.

### LT-347 — VXLAN, EVPN and per-VRF routing are collected, and NX-OS has answered — 2026-09-20
**Source:** the request of 2026-09-20, which asked for overlay and underlay
paths "where discovery already provides the required data" — and it did not —
then "I don't have multi vdom yet / And no vxlan ready / Can you build it and i
test it".
**Shipped 2026-09-20:** `vrftables.rs` reads the VRF listing and each VRF's own
table for Cisco, Arista, Junos and FortiOS; `overlay.rs` reads the VNI-to-VLAN
mapping, the remote VTEPs, the VTEP source address and EVPN type-2 and type-5
routes for NX-OS, Arista and Junos. Both are wired into `DetailOptions` as
tick-boxes that are **off by default**, and flattened onto the crawled device
so LT-346's `vrfRoutes` and `vtep` fill themselves. Neither LT-346 nor LT-348
changed.
**Built from vendor documentation (D-051), which was the whole risk** — and the
risk was real. A live VXLAN/EVPN fabric answered on 2026-09-20 and three of the
four NX-OS parsers were wrong; what they got wrong is recorded in LT-350 with
the fixes.
**Verified against hardware, and the field says so:**
`OverlayDialect::NxOs` and `VrfDialect::Cisco` now return true from
`verified_against_hardware()` — a Nexus leaf and a Nexus spine, 2026-09-20,
answering `show vrf`, `show ip route vrf <name>`, `show nve vni`,
`show nve peers`, `show nve interface nve1 detail` and `show bgp l2vpn evpn`.
**Arista, Junos and FortiOS are still hypotheses** and still say so; the
`VrfDialect::Cisco` arm covers IOS-XE too, whose `show vrf` is a different
table again and has not been seen. The test that pins this asserts both halves,
so a future edit cannot quietly claim the rest.
**Earned by `examples/probe_overlay.rs` and `examples/parse_capture.rs`** — one
for a device that can be logged in to, one for a capture that already exists.
The lab 2960CX had already proved the first behaves when a device does not know
the commands: `% Invalid input detected`, reported as a refusal rather than as
an empty fabric.

### LT-349 — Back to the Windows installer only — 2026-09-20
**Source:** asked 2026-09-20 — "Push and only Build windows installer just like
last time / No msi or offline installer".
**The fourth time this set has been narrowed or widened** — LT-305 narrowed,
LT-311 widened, LT-331 narrowed, LT-337 widened — which is why none of it is
ever deleted. The Linux leg is commented, `bundle-macos` and `appimage-smoke`
carry `if: false`, `bundle-windows-offline` stays off, and Windows builds NSIS
only through `--bundles nsis`, so the MSI is not built at all rather than built
and thrown away. Each comes back in one edit.
**`test` still runs on Linux and Windows both**, so nothing about Linux goes
unchecked; only the bundling is paused.
**One artifact from a push: `coreview-windows`, the NSIS `.exe`.**

### LT-348 — The application path, on a page of its own — 2026-09-20
**Source:** asked 2026-09-20 — extend Path Intelligence into "the final
application-flow visualization/reporting capability", with the original
topology as the source of truth and **non-negotiably unmodified**, the result
as a separate page through the existing Pages system, drawn with lines rather
than listed, explained, exported, and working on large networks.
**Additive throughout. Nothing was redesigned, replaced or removed.** LT-346's
engine was extended, not rewritten; `withNewPage` gained one optional
parameter and every existing caller is untouched; the Pages system was reused
rather than duplicated. All 1,248 existing tests passed before and after.
**The source page is protected structurally rather than carefully.**
`buildApplicationPage` takes a `TraceResult` and returns *new* nodes and edges;
it never receives a page and never returns a mutation. There is a test that
the original document is byte-for-byte identical after a generation, another
that generating a second application leaves the first generated page alone, and
another that no generated id can collide with an existing one.
**The engine gained the things that change where traffic goes without routing
it**, each as its own kind of step so a drawing cannot misrepresent one as
another:
- **Per-VRF routing tables.** A VRF is answered from that VRF's own table or
  not at all — two VRFs on one device are properly isolated, with a test that a
  prefix in RED is invisible from BLUE.
- **NAT.** A destination translation happens on arrival, *before* the route
  lookup, and every lookup after it uses the new address.
- **VIPs.** A virtual address is answered by the balancer and each pool member
  becomes a path of its own, because any of them may serve the connection.
- **VXLAN/EVPN.** An address inside a VNI a remote VTEP carries is one bridged
  hop across a tunnel, not an L3 hop — and the **underlay is traced separately
  with the same engine** and kept as its own steps, so the spines are visible
  instead of hidden inside the overlay hop. The underlay trace runs with the
  overlay switched off; without that a tunnel carries itself and the stack
  gives out, which is how that was found.
- **BGP local preference, AS path and MED** carried onto the hop where the
  device reported them.
**Drawn, not listed:** a node per step with the kind on its label and the right
glyph (NAT as a firewall, VIP as a load balancer, VTEP as a switch), a column
per equal-cost path, the tunnel and its underlay dashed because they are not a
cable, and the destination drawn as the address the traffic is *really* aimed
at — a NAT and a VIP both rewrite it, and drawing the original would contradict
the NAT box above it.
**Only the path is drawn.** The generated page holds the handful of objects on
the path; nothing is copied from the source page, so a fabric of a thousand
devices produces a page of eight.
**Report** as Markdown beside the project's other exports: what it is, source,
destination, flow, VRF, the ordered device table, the recursive resolutions,
the numbered explanation, and a **Not resolved** section that is always present.
**36 unit tests** across the areas asked for, and `e2e/pathtrace.mjs` drives it
with 29 checks — including that the original page is unchanged after
generating two applications.

### LT-338 — "Where is this?" — one search over everything discovery has found — 2026-09-20
**Source:** agreed 2026-09-20 from a plan he asked for — "I love it / lets do
it all".
**The question a network engineer actually asks** is "where is this thing
plugged in", and every piece of the answer is already collected and none of it
is searchable. A MAC, an address, a hostname or a maker's name should return:
which switch, which port, which VLAN, which access point and SSID when it is
wireless, what the OUI registry calls the maker, and when it was last seen.
**Nothing new is gathered.** It is a query and a result view over `attached`,
the merged ARP tables, the DHCP leases and the FortiGate device store — all of
which a crawl already produces.
**Why it is first among these:** it is the feature that gets the app opened on
an ordinary Tuesday rather than only during a documentation push.
**Shipped.** A **Where is** tab beside Trace path. It reads a saved crawl run
and searches what every device learned on every port: a MAC matches however
either side punctuates it (`000c.e600.00a0` finds `00:0c:e6:00:00:a0`), an
address matches whole or by leading octets, and a name, a maker or a VLAN
matches as text. Each hit says which device saw it, on which port, in which
VLAN, and what the OUI registry calls the maker.
**Two things it does that are the whole point.**
- **Most answers are about things nobody drew.** A printer on a port is a MAC
  and a vendor and nothing else; the e2e harness asserts that a device absent
  from the diagram is still found, because that is the case the feature exists
  for.
- **A wireless client's port is its SSID.** A FortiGate reports its clients
  with the SSID where a switch reports a port, so asking where a handset is
  answers with the network it is on and the controller that saw it — without a
  separate wireless search, and without collecting anything new.
**What it refuses.** A port with several addresses behind it leads to another
switch, so the hit is marked `shared` and names the switch rather than
pretending to name a socket. An empty query returns nothing rather than the
estate, and a miss says which query missed (D-050).
**Matching is literal, not fuzzy**, unlike the command palette (LT-230): that
is a jump-to, this is an answer about one device, and `aa:bb` quietly matching
a VLAN name would make it untrustworthy.
**Checked:** 9 unit tests in `whereIs.test.ts` and 14 in `e2e/whereis.mjs`,
which drives the real panel.

### LT-333 — Choose what goes on the diagram by what it is — 2026-09-21
**Source:** asked 2026-09-19 — "the idea is to educate the discovery tool …
we get all the devices on the wired and wireless network by collecting the mac
address from the devices we crawled and build the diagram based on that / ping
sweep could also help in this case to id the devices / if admin wants to build
a full topology of the network they select all the devices discovered. if not
and only wants to build the topology of the routers, switches, access points,
servers, firewalls then they only select what they want".
**Half of it exists.** The crawl's review step already lists every change with
a tick box, and the endpoint side is largely built: `parse_device_store`
(wired *and* wireless, with the FortiAP name and SSID on each), `parse_wtp_status`,
`parse_dhcp_leases`, ARP, the OUI lookup, and `endpoint_class` which already
decides what an endpoint is. The sweep's identification (LT-124/125) feeds the
same picture.
**What is missing is choosing in bulk, by role.** Thirty endpoints reviewed one
tick at a time is not a choice, it is a chore — and the choice he described is
exactly "infrastructure only" versus "everything".
**To ship:** the review groups by device class and offers **Infrastructure
only** (routers, switches, firewalls, access points, servers) against
**Everything discovered**, with the individual ticks still there underneath.
**LT-332 is done**, so the endpoints are now there to choose from: his
FortiSwitch alone contributes 35 distinct MACs, and the FortiGate 46 DHCP
leases of which 41 are wireless and name their SSID and AP.
**Shipped.** The review's actions now read **Select all {n}**, **Infrastructure
only ({n})** and **Select none**, with every individual tick still underneath —
a starting point rather than a mode.
**What counts as infrastructure, and why it is a judgement worth stating.**
Routers, switches, firewalls, wireless controllers, access points and servers.
A server is a thing somebody drew on purpose and expects on a topology; a
phone, a camera, a printer and a laptop are things the network carries.
**`unknown` is deliberately excluded**: a device nothing could identify is far
more often a workstation than a switch, and putting every unidentified MAC on
the diagram is the exact outcome "infrastructure only" exists to avoid.
**Both buttons say what they will do before they are pressed**, counting the
rows actually visible, so a filter narrowing the list narrows the number too.
**Checked:** 6 unit tests in `deviceRoles.test.ts` — including that every
member of the class union is decided one way or the other, so a new class
cannot be silently neither — and 4 in `e2e/crawling.mjs` driving the real
review, where the counts are the proof the buttons read the rows rather than
showing a constant.

### LT-298 — IPAM Phase 2: devices, sites, tenants, bulk operations, reporting
**Source:** the same specification, Phase 2.
**Scope:** sites and tenants; devices and interfaces linked to addresses; tags
and custom fields across objects; filtering, saved views, the column chooser,
bulk selection and bulk actions; CSV and JSON import and export; the utilisation
dashboard and its history; split and merge with an explicit review of what
happens to the addresses inside.
**In progress — one part shipped, 2026-09-21: CSV import.**
The register has always *written* CSV (`ipamRows`) and nothing read it back,
so the round trip was one-way and an estate already kept in a spreadsheet had
to be typed in. **Import CSV** in the register's bar now reads one.
- **Columns are matched by heading, not by position.** A spreadsheet that has
  been through three people has reordered columns and added its own; insisting
  on an order would reject exactly the files worth importing. Only `Address`
  is required, because it is the only field that must parse. `IP`, `Name`,
  `Held as`, `Used as` and the rest are all understood.
- **Nothing is guessed, and nothing is half-applied.** The file is summarised
  before anything is written: how many will be added, which rows were skipped
  and why with their line numbers, which addresses two rows both claimed, and
  which subnets the file names that the register does not hold. Only then is
  there an **Add them** button.
- **A subnet is reported as wanted rather than created.** Creating subnets is a
  decision about someone's network (D-050).
- **Both sides of a conflict stay out.** Two rows claiming one address is a
  disagreement, not a preference for the later row.
**Checked:** 9 unit tests, including a round trip against what `ipamRows`
writes, and quoted fields so a note may contain a comma. `e2e/ipamlab` stays
green.
**Second part shipped, 2026-09-21: tags, and a filter box that understands
them.** A register of two hundred addresses is a list nobody reads; filtering
is what turns it back into an answer, and it is what saved views and bulk
actions will both be built on, so the grammar was worth getting right once.
- **Bare words behave exactly as before** — the box already searched address,
  name, hostname, MAC, owner and the rest, and still does.
- **`field:value` narrows and a leading `-` excludes**: `tag:pci`, `vlan:14`,
  `source:crawled`, `-tag:decommissioned`. Every term must match, because that
  is what a person means by typing two of them. A quoted value may contain a
  space.
- **`tag:` and `vlan:` match exactly, the text fields by substring.** If
  `tag:core` also matched `core-switches` then `-tag:core` would quietly
  exclude things nobody asked it to, and an exclusion you cannot trust is
  worse than none.
- **An unknown field is a word, not an error.** Someone typing `printer:2f`
  means to search for that text; rejecting the query would be the least useful
  possible answer.
- **Tags are lower-cased and deduplicated on the way in.** A register where
  `PCI` and `pci` are two different tags is one nobody trusts.
**Checked:** 11 unit tests on the grammar, and 5 in `e2e/ipam` that set a tag
through the form and then find it — both halves, because a tag that can be
filtered but not set is half a feature.
**Third part shipped, 2026-09-21: bulk actions.** Filtering made a long
register answerable; this makes it editable. Add or remove tags, set an owner
or a purpose, or change what addresses are held as — applied to everything the
filter found.
- **The bar only appears once a filter is narrowing the list.** "Do this to all
  of them" is only a sensible offer when "them" is a chosen set.
- **It says what will change before it changes anything**, and the number is
  not the number of rows on screen: an address that already carries the tag is
  not a change. The button reads `Apply to 12` beside `12 to change, 3 already
  so, 2 belong to a device`.
- **A row that came from a device on the diagram is not edited, and is counted
  and named rather than silently skipped.** Its address is a fact about the
  device; the register displays it rather than owning it, and bulk-writing to
  it would record something the device never reported.
- **The whole edit is one undo.** `applyIpamBulk` commits once — a loop over
  `updateIpamEntry` would be correct and unusable, because putting two hundred
  changes back would mean pressing undo two hundred times.
**Checked:** 10 unit tests on the planner, and 5 in `e2e/ipam` that filter,
apply a tag to every match through the real bar, and then undo the lot in one
step — the last asserted through the store rather than Ctrl+Z, because the
claim under test is the commit granularity, not the shortcut.
**Fourth part shipped, 2026-09-21: saved views.** Once a filter can say
`source:crawled vlan:14 -tag:audited`, it is a sentence worth writing once
rather than retyping.
- **A view holds only the query, never the rows it matched.** It therefore
  cannot go stale: opening it asks the register again rather than showing an
  answer from last week. An e2e check asserts the stored object has no
  addresses in it, because that is the design and not an implementation
  detail.
- **Save appears only when there is a filter to save**, and a view can be
  forgotten from the same bar.
**Checked:** 5 checks in `e2e/ipam` — save, clear the box, reopen it, confirm
what was stored, and forget it.
**Fifth part shipped, 2026-09-21: the utilisation view.** "So I know in the
future that this subnet is used and that subnet is not used" is the sentence
this register was asked for, and the list answered it one subnet at a time.
**Utilisation** is a sixth view in the register's bar that answers it for the
estate at once.
- **Fullest first**, because that is the end that needs acting on. Ties break
  by size and then by name, so the same data always reads the same way.
- **Four bands rather than one sorted column**: nearly full, busy, lightly
  used, and *nothing in them*. A sorted list makes you read all of it to find
  the two that matter. Empty is its own band because 0% is not "very light" —
  it is reclaimable, and it is the other end an operator acts on.
- **The reclaimable ones are named in a sentence**, not left to be spotted.
- **A subnet holding only excluded addresses or a DHCP pool is not
  "untouched"**: a server owns those, and offering them back would be wrong.
- **Nothing is stored.** Every number is derived from the same `buildIpam` the
  list beneath it uses, so the two cannot disagree and the view cannot go
  stale.
**Checked:** 10 unit tests — including that a /31 or /32 is not divided by
zero — and 4 in `e2e/ipamlab` which assert the view agrees with the register
rather than merely rendering.
**Still to do in this phase:** sites and tenants; devices and interfaces linked
to addresses; custom fields; the column chooser; JSON import and export;
utilisation *history*; split and merge with an explicit review.

### LT-299 — Discovery ingestion: the register learns what is actually in use — 2026-09-21
**Source:** the same specification, Phase 3.
**Scope:** DNS record and DHCP scope/lease models and screens; a discovery
ingestion path that feeds the existing crawl and sweep into the register; the
reconciliation queue with its rules — new address, new MAC on a known address,
known MAC at a new address, DNS mismatch, lease against a static assignment,
stale records that are flagged and never auto-released; conflict reporting; and
the DNS/DHCP comparison reports. **Includes LT-296** (the discovery form filling
itself in).
**Narrowed by D-052, 2026-09-21, and the reason is recorded there.** The scope
above is an IPAM product: scope and record models, a reconciliation queue,
conflict reporting, connectors to Infoblox and Microsoft DHCP. The operator
drew the line himself — "not become dhcp/dns management tool i just want to
have visibility and tracking so i know in the future that this subnet is used
and that subnet is not used."
**What this item is now:** the crawl and the sweep already see far more than
ever reaches the register. `buildIpam` reads addresses off **drawn devices**,
so a device nobody drew contributes nothing — and one FortiSwitch alone
contributed thirty-five MACs and one FortiGate forty-six DHCP leases, none of
it drawn. Ingestion writes what was *observed* into the register, so
"which subnets are in use" is answered from the network rather than from
memory.
**What it must keep straight.** An observed address says it was seen; it does
not say it was intended. The register already distinguishes `drawn`, `crawled`
and `typed`, and an ingested address is evidence, not an allocation. Nothing is
auto-released: an address unseen for a month is reported as unseen, never
recycled.
**Moved to Icebox with D-052 as the reason, not deleted:** DNS record and DHCP
scope models and screens, the reconciliation queue and its rules, conflict
reporting, the DNS/DHCP comparison reports, and the third-party connectors.
**Shipped, 2026-09-21 — "From the last crawl" in the register's bar.**
It reads the newest saved crawl and offers every address it saw that the
register does not already hold: each device's own addresses first, then
everything those devices learned on their ports — which is where the ARP
tables, MAC tables and FortiGate DHCP leases were already merged (LT-134,
LT-332). A wireless client arrives with the SSID it was on, because that is
what its "port" is.
**It plans rather than applies**, like the CSV import: it says how many were
seen, how many the register already holds, and lists the first of them with
where each was seen, and only then offers **Add what was seen**.
**Four rules, and each is a refusal to overstate.**
- **An address the register already holds is left exactly as it is.**
  Re-ingesting a crawl must never overwrite what somebody typed; a test asserts
  the hand-typed label survives.
- **A device's own claim beats something that merely learned of it.** Devices
  are walked first, so `CORE` naming its own loopback wins over a neighbour's
  guess about the same address.
- **One address is counted once**, however many switches saw it.
- **IPv6 is reported, not silently dropped** — once, not once per sighting —
  because this register holds IPv4 and saying so is better than saying nothing.
**Every ingested entry says where it came from:** `Seen by a crawl on SW1
Gi0/7, VLAN 14`. Observed is not intended (D-052), and the note is what keeps
the two apart when somebody reads the register a year later.
**Checked:** 10 unit tests; `e2e/ipam` and `e2e/ipamlab` stay green.

### LT-139 — Stacks and virtual chassis, built from the vendor guides
**Source:** asked 2026-09-12 — "for teh stacking build it based on the guides
and make sure its ready to be tested for all of tehm", after supplying the
Cisco, Aruba VSX/VSF and other-vendor references gathered under LT-136.
**This overrides a standing rule, and the override is his to make.**
`CLAUDE.md` says parsers are written against captured output from real
hardware, not against documentation, precisely because a documentation-built
parser fails silently on kit nobody tested. He has asked for the opposite —
build it from the guides and make it ready to test — which is reasonable when
the hardware is not to hand and the alternative is nothing at all. Recorded as
**D-026** so it is a decision rather than a lapse.
**What that means in practice, and it is not a detail:** every parser landed
under this item is **unverified against hardware** until it has met a real
device. Each is marked as such in its own doc comment, with the exact command
and the vendor page it was built from, so the next person knows which have
been proven and which have only been written.
**Families to cover:** Cisco IOS/IOS-XE stacking (`show switch`), Cisco
StackWise Virtual and VSS (`show switch virtual`), Aruba AOS-CX VSF
(`show vsf`, `show vsf topology`) and VSX (`show vsx status`), Juniper Virtual
Chassis (`show virtual-chassis`), Dell N-Series, FortiSwitch stacking through
a FortiGate, Netgear M4300, D-Link DGS-3130.
**The distinction the drawing turns on**, from his own VSF-vs-VSX material: a
stack and VSF are *one* logical switch — one management plane, one node. VSX
and VSS are *two* chassis sharing an inter-switch link and presenting a common
LAG downstream; drawing those as one node hides the very thing they exist for.
So the model records which it is, and the diagram can then be right.
**Acceptance:** one command per family that a crawl can run, a parser for each
answer, and a way for the operator to point the app at a real stack and see
whether it was right. Nothing claimed as verified until it has been.
**Built 2026-09-12** as `crates/coreview-discover/src/stacking.rs`:
`StackKind`, `StackMember`, `StackInfo`, `commands_for` per platform family,
and parsers for `show switch` (Cisco/Dell/Netgear/D-Link shape),
`show switch virtual` (StackWise Virtual *and* VSS, told apart by the
`Switch mode` line), `show vsx status`, `show vsf topology` and
`show virtual-chassis`. 12 tests.
**`StackKind::draws_as_one_node()` is the point of the module:** a stack, VSF
and a Virtual Chassis are one node; VSX, StackWise Virtual and VSS are two
chassis and an inter-switch link, and collapsing those to one node would hide
the redundancy they exist to provide.
**Every family reports `verified_against_hardware() == false`,** and every
`StackInfo` carries `unverified: true` so the interface cannot present a
documentation-derived guess as a fact. A test asserts none of them claims
hardware it has not met.
**The one thing actually measured:** a WS-C2960CX answers all four Cisco
commands with `% Invalid input detected`, and that reads as *standalone*
rather than as an error — verified against `LAB-CORE-SW1` on 2026-09-12 with
the new `probe_stack` example. Claiming a stack that is not there is the worst
failure this module could have, and it is the one case that is now proven.
**Ready to test, which is what he asked for:**
`cargo run -p coreview-discover --example probe_stack` with `CV_HOST`,
`CV_USER`, `CV_PASS` and optionally `CV_PLATFORM` prints the raw output of
every command *and* what the parser made of it, so the two can be compared by
eye and the bytes pasted into a test afterwards.
**Verified against vendor documentation 2026-09-12** — and the verification
found real faults, three of which would have produced wrong diagrams:

- **A Catalyst 9500 chassis pair read as a stack.** StackWise Virtual uses
  `show stackwise-virtual`, not `show switch virtual` (which is the VSS
  form), and its table starts each row with a switch number — so it fell
  through to the Cisco stack parser, which read `1  1  HundredGigE1/0/25` as
  a member with role "1". `draws_as_one_node()` then collapsed two chassis
  into one node, hiding the redundancy the pair exists for. That is the worst
  mistake this module could make. Fixed with its own parser and command, and
  `parse_show_switch` now demands a full row *and* a MAC in column two.
- **Dell N-Series and Netgear M4300 answer `show switch` with a different
  table** — two-word roles, no MAC, no priority. The Cisco parser read `Sw`
  as a hardware address and invented a stack. They have their own parser now,
  detected by the `Management Status` header.
- **Aruba `Device Role primary secondary` is a table row with no colon,** so
  the key/value branch never saw it and both members came back role-less. Read
  from the attribute table, which also states the peer's role outright instead
  of inferring it.
- **Current AOS-CX calls the master a Conductor**, so a parser insisting on
  "master" returned nothing on current firmware; and `show vsf` is a table
  worth parsing where `show vsf topology` is ASCII art. Both are read, table
  first.
- **Juniper's role is not the last column** — the row ends with a neighbour
  list, so `last()` returned a port name like `vcp-255/1/0`. Matched by
  keyword now.
- **`diagnose switch-controller stack status` is not a FortiOS command.** The
  real one is `diagnose switch-controller switch-info topology`. And
  FortiSwitch "stacking" is MCLAG — two switches with an inter-chassis link —
  so `FortiLinkStack` now draws as a chassis pair, not as one node.

20 tests. D-Link's `show stack` family was left unimplemented rather than
guessed at, because no verbatim output could be found.
**Wired into the crawl 2026-09-12.** A reached device is asked the commands
for its family and the result lands on `CrawledDevice.stack`, with a stack of
one discarded — a standalone switch must not wear a StackWise badge. Every
result still carries `unverified: true`.
**Still to do:** the drawing. The model knows a pair is two chassis; the
topology builder does not yet split one into two nodes with an ISL between
them. And `verified_against_hardware()` stays false for every family until
one has met a device — `probe_stack` is how that gets earned.
**Blocked on a customer's approval, 2026-09-13.** In the operator's words:
"i must do it at the customer site when they approve". No lab stack exists.
**When it happens, D-027 applies to what comes back:** captured output from a
customer site is anonymised on his machine before it is shared (hostnames,
addresses, serials replaced), and a fixture written from it carries invented
names and RFC 5737 addresses only. `verified_against_hardware()` flips per
family on that evidence, and the entry records which families were proven,
not where.

### LT-136 — Stacks, chassis pairs and virtual switches are one device
**Source:** asked 2026-09-12 — "also this app should count for Port channel
but not sure if we ever addressed stackwize virtual, and switch stacking and
VSS, Virtual Switching Framework (VSF), VXS , and all other stacking
capablitiy?"
**Where this already stands, so the gap is the real one:**
- **Port channels are done** (LT-009): `etherchannel.rs` reads
  `show etherchannel summary` and two cables in a bundle draw as one link.
- **A stack is already one device with several serials** (LT-115): one
  hostname, one management address, one node, and every member's serial kept
  so each can be RMA'd. That covers IOS stacking as seen from the prompt.
**What is not addressed:** the cases where *two chassis* present as one
logical switch and the diagram should say so — Cisco **StackWise Virtual**
and **VSS**, Aruba/HP **VSF** and **IRF**, Juniper **Virtual Chassis**, and
the FortiSwitch equivalent. These differ from a plain stack: the members are
separate boxes, often in separate racks, and the failure domain an operator
cares about is which chassis a link lands on. A diagram that draws them as
one featureless node hides exactly what a dual-homed link is for.
**The open question is what to draw**, and it is worth deciding before
writing anything: one node that names its members, or one node per chassis
with the virtual pairing drawn between them. The second is more honest about
cabling and more work.
**Confirmed against his own switch, 2026-09-12.** `LAB-CORE-SW1` is a
WS-C2960CX-8PC-L running 15.2(7)E, and it answers:

- `show switch` — **not understood**. The 2960CX is not stackable, so the
  command a stack is detected with does not exist there. Whatever reads it
  must treat "not understood" as "standalone", not as a failure.
- `show version` — carries the member table even on a standalone box:
  `Switch Ports Model  SW Version  SW Image` with a single starred row
  `*    1 12  WS-C2960CX-8PC-L`. On a real stack that table lists a row per
  member, which makes it the fallback when `show switch` is unavailable.

**Commands and references he supplied 2026-09-12**, to write against rather
than invent:

- Cisco: `show int lag 256`, `show lacp interfaces`;
  [9000 stacking](https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/infra/stacking/stacking.html),
  [StackWise Virtual white paper](https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-9000/nb-06-cat-9k-stack-wp-cte-en.html),
  [3850 stacking Q&A](https://www.cisco.com/c/dam/en/us/products/collateral/switches/catalyst-3850-series-switches/q-and-a-c67-738577.pdf)
- Aruba VSX (8360): `show vsx status`, `show vsx status config-sync`,
  `show lacp interfaces multi-chassis`; ISL over a `lag`, roles primary and
  secondary, `vsx-sync` for config, SVIs created on both with
  `active-gateway`.
  [AOS-CX VSX](https://arubanetworking.hpe.com/techdocs/AOS-CX/10.15/HTML/vsx/Content/first_intro.htm)
- Aruba VSF (6200): `show vsf`, `show vsf link`, `sh vsf topology` — which
  prints the member tree with master and standby.
  [VSF vs VSX](https://www.thenetworkdna.com/2023/11/a-closer-look-aruba-vsf-vs-aruba-vsx.html)
- Other stacking families he wants counted: Dell N-Series (N2000/N3000,
  dedicated stack modules), Juniper EX Virtual Chassis (EX2300/EX3400),
  FortiSwitch managed stacking through a FortiGate, Netgear M4300 mixed
  stacking, D-Link DGS-3130.

**The distinction that matters for the diagram**, and which the VSX/VSF
material makes concrete: VSF is *one* logical switch (one management plane,
like a stack), while VSX is *two* independent switches that share an ISL and
present a common LAG to downstream kit. They should not draw the same way —
a VSX pair is two nodes with an ISL between them, and its whole purpose is
that a downstream link survives losing one. Drawing it as one node hides
exactly what it is for.
**The Aruba CX image in the lab does not boot, and that was investigated
properly rather than assumed** (2026-09-20). The node runs, but it spins at
99% CPU indefinitely and **never writes a single byte to its overlay disk** —
it is not reaching the operating system at all. Ruled out, each by test:
permissions (identical ownership to a working NX-OS image, and
`unl_wrapper -a fixpermissions` run afterwards); the disk itself
(`qemu-img check` reports **no errors** — 16,006 leaked clusters, which it
says are harmless — and the raw image has a valid MBR with an active FAT32
boot partition); the NIC count (a second node built with the template's own
defaults of seven behaves identically); and the CPU model (adding `-cpu host`,
which the CSR and NX-OS templates carry and this one does not, changed
nothing). Two independent nodes behave the same way, so it is the image or its
qemu pairing, not the lab. The EVE-NG how-to describes 10.04; the installed
image is 10.07. **A re-converted image is what would unblock this**, not more
configuration.

**Still blocked on:** hardware for the multi-chassis families. The screenshots
he sent are images, and a parser here is written against captured text, not a
picture of it. Text output of `show vsx status`, `sh vsf topology` and
`show switch` from a real stack is what unblocks each one.

### LT-029 — No known bugs
**Source:** asked 2026-08-30 — "I don't want any bugs".
**Acceptance:** a standing bar rather than a task that finishes.
- Every bug you report gets its own roadmap item the moment it is reported,
  with the symptom in your words. It is not folded into whatever else is being
  worked on.
- A bug is not fixed until it has been *reproduced* first — by a test that
  fails without the fix — and then verified by running it. "It compiles" is
  not "it works", and neither is "I changed the thing that looked wrong".
- The known-bug list is the items below tagged **bug**. When that list is
  empty, this item says so with a date. It goes back to Now the moment
  anything lands on it.
- Where a bug cannot be fixed, it says why in plain words rather than being
  quietly closed.

**Known bugs, open:** none, as of 2026-09-20 — but the count that day is worth
recording. Seven were found and fixed: LT-355 and LT-356 from a report and from
reading; LT-358, LT-359 and LT-364 from three different platforms silently
dropping their uptime; and LT-361, LT-362 and LT-363 from pointing the VRF
parsers at a real IOS router and a real Nexus for the first time. **Five of the
seven were found by hardware, not by reading**, and none of them could have
been: every fixture in the repository used the one shape that already worked.
LT-357 and LT-360 remain open by choice and are described where they sit.
**LT-137 is now closed outright** rather than accepted: the credentials were
gone from the working tree long ago, and on 2026-09-18 the published history was
replaced by a single commit (LT-314), so they are gone from that too.
**Confirmed by the operator, 2026-09-13:** LT-107 and LT-108 — "LT-107 and
LT-108: confimed". Nothing is held pending his eyes.
**Known bugs, closed:** LT-137, LT-030, LT-031, LT-003, LT-044, LT-004, LT-005,
LT-082, LT-083, LT-084, LT-085, LT-091, LT-101, LT-128, LT-129, LT-132,
LT-133, LT-141, LT-144, LT-273.

### LT-010 — Verify against Catalyst 9000 / IOS-XE 17
**Source:** asked 2026-08-29.
**Blocked on:** access to a Catalyst 9000. The CDP and LLDP parsers are written
against a C2960CX, a FortiSwitch and a FortiGate only. Operator has a 9300 he
will power on to test against (2026-08-30).

### LT-012 — Legacy binary `.vss` stencils
**Source:** raised 2026-08-30; deferred by the operator, then unblocked by him
the same day: `libvisio-tools` is installed (vss2xhtml and friends on PATH),
and LibreOffice itself reads Visio through the same libvisio. Folded into
LT-045's converter work — the .vss route lands there.

## Next

*Phases 2–8 of the mission set 2026-09-16, one item per ask, not started. Each
gets its full acceptance when it is picked up. Standing constraints: parsers are
written against captured output from real hardware (D-026 is the only
exception); fixtures and samples are invented (D-027); no network call the
operator did not start.*

**Phase 2 — discovery.** *Already built: SNMP v1/v2c/v3, LLDP and CDP, ARP and
MAC tables, stacks, the default route, sweeps and crawls from a seed.*
- **LT-201** — BGP peer and OSPF neighbour collection. Blocked on Q-011: no
  router in the lab peers, so there is no output to write it against.
- **LT-205** — NETCONF/RESTCONF, read-only, optional. RESTCONF is HTTP:
  blocked on Q-008.

**Phase 3 — validation and live operations.**
- **LT-218** — HTTP/HTTPS HEAD probe, opt-in and clearly labelled. Blocked on
  Q-008.
- **LT-221** — BGP/OSPF neighbour-state probe. Blocked on Q-011, with LT-201: no
  router in the lab to write it against.
- **LT-223** — Scheduled validation sessions. Blocked on D-030 being accepted.
- **LT-229** — Local OS notifications. Blocked on D-030 being accepted.

**Phase 4 — UX and workflow.** *All done; see Done.*

**Phase 5 — import and export.** *All done; see Done.*

**Phase 6 — reporting.** *All done; see Done.*

**Phase 7 — security hardening.**
- **LT-261** — Optional encrypted database (SQLCipher) keyed from the OS
  keychain. Blocked on Q-012: SQLCipher needs OpenSSL built into every
  installer, which is a build-time and CI-cost decision.
- **LT-263** — Optional hardware-backed key derivation (TPM / Secure Enclave).
  Blocked on Q-013: nothing here has a TPM or a Secure Enclave to build it
  against.
- **LT-281** — Upgrade vite and vitest past their advisories (GHSA-67mh-4wv8-2f99,
  GHSA-82fw-gwwq-j7x9). Development-only — nothing ships in an installer — and
  both fixes are major versions (vite 8, vitest 5), so it is its own change with
  the whole gate re-run. Found by LT-265.

**Phase 8 — quality and developer experience.** *LT-190's canvas benchmark was
pulled into Phase 1.*
- **LT-269** — CI matrix: Windows 10/11, macOS 12+, Ubuntu 22.04/24.04. Cost:
  Q-010.

## Done

### LT-345 — Test this login — 2026-09-20
**Source:** agreed 2026-09-20.
**Shipped:** a **Test it** button on every saved SSH credential, with the
address to try it against filled in from the device itself where there is one.
It opens a shell and closes it — nothing is typed, no command is run, no
transcript is written. The handshake and the authentication are the parts in
doubt.
**Three outcomes, not two**, and that is the whole value: `reached`, `refused`
and `unreachable` are three different problems with three different fixes.
Collapsing the last two into "failed" is what makes a wrong password and an
unplugged switch look identical, which is most of why "is this password right"
was hard to answer.
**Verified against real hardware — 2026-09-20**, all three: the lab FortiSwitch
with the right password opened in 400 ms (`reached`); the same switch with a
wrong one answered "rejected the credentials" (`refused`); an address with
nothing on it gave "No route to host", reported as `unreachable` with "The
login itself was not tested" appended, because it was not.
**SNMP is deliberately not offered one** — a shell cannot authenticate an SNMP
credential, and a button that cannot mean anything is worse than no button.
**Rate limited** like everything else that reaches the network (LT-260), at 40
a minute: checking a password is cheap and people do it in bursts while they
get it right.

### LT-342 — Search the terminal's scrollback — 2026-09-20
**Source:** agreed 2026-09-20.
**Shipped:** `@xterm/addon-search` (MIT, in the notices), a find box in the SSH
tab with next and previous, Enter for next and Shift+Enter for previous, Escape
to close. Scrollback nobody can search is scrollback nobody uses, and a `show
running-config` has gone past long before it can be read.

### LT-343 — Send one command to several sessions — 2026-09-20
**Source:** agreed 2026-09-20.
**Useful and dangerous in the same mechanism**, so it shipped with every guard
rail the roadmap entry demanded, and each one has a check in `e2e/ssh.mjs`:
- **The button opens a form; the form does not send.** Nothing leaves until a
  second, separate confirmation.
- **Targets are ticked one at a time and there is no "all".** Choosing every
  device in an estate should take as long as it deserves.
- **The confirmation names every device** it is about to reach, and quotes the
  command as it will be sent.
- **Only open sessions**, re-checked at the moment of sending rather than
  trusted from when the box was ticked — a session can drop in between, and
  the whole point of the dialog is that nothing goes anywhere unexpected.
- **Nothing is added** to the command but the Enter that runs it.
- The form closes afterwards rather than staying armed.

### LT-344 — Copy on select and right-click paste, behind a checkbox — 2026-09-20
**Source:** agreed 2026-09-20 — "We need a check box to enable and disable".
**He was right that it needs a switch, and both default to off.** Copy-on-select
is muscle memory for anyone who came from PuTTY and a nasty surprise for
everyone else, because it replaces the clipboard every time a line is
highlighted to read it. Right-click paste types into a live device with nothing
to confirm.
**Shipped:** one checkbox each in the SSH tab, each saying in its tooltip what
it does and why it is off, remembered on the machine like the font and the size
(LT-323). Both read the setting at the moment of the event rather than when the
session opened, so a checkbox takes effect on the next click instead of the
next session.

### LT-340 — The port map, and which ports are free — 2026-09-20
**Source:** agreed 2026-09-20.
**Shipped:** `portMap` gives one row per port of every crawled device that
reported its ports — port, description, status, VLAN, speed, duplex, what the
MAC table learned on it and who announced themselves on it. `portTotals` counts
free, shut and in use per device, emptiest first. `portMapCsv` is the sheet
somebody has to hand over, free ports included, quoted properly.
**"Free" is three conditions, not one**, and that is the part worth getting
right: the switch says nothing is connected, **and** nothing is learned on it,
**and** no neighbour announced itself. Any one alone is wrong often enough to
matter — a port reads `notconnect` for a machine that is asleep, and a port
that has aged its table out has learned nothing without being spare.
**A shut port is counted apart from a free one.** Both are capacity, but a port
was probably shut on purpose and reclaiming it is somebody's decision; a count
that merges them overstates what is available.
**A device that was not asked for its ports contributes nothing**, rather than
having rows invented from its MAC table — that would list only the busy ports,
which is the opposite of the question being asked.

### LT-341 — Two MACs claiming one address — 2026-09-20
**Source:** agreed 2026-09-20.
**Half of it already existed:** duplicate MACs — one MAC alone on two ports —
have been a finding since LT-213. The missing half was the address.
**Shipped:** a `duplicate-ip` finding beside the others, from the addresses the
crawl already resolved per learned MAC. Two different MACs claiming one address
is a static address typed onto a second machine, a DHCP pool overlapping
something reserved, or a device that came back with a new network card while
the old ARP entry is still alive. It is a classic cause of "it works
intermittently" and it is invisible on a diagram.
**Counted by distinct MAC, deliberately.** One device learned by three switches
has one MAC and one address; counting sightings would report every correctly
working host as a conflict. That distinction is LT-339's, already made, and
there is a test that it holds here.

### LT-334 — The LLDP detail form is read, for the two keys the summary lacks — 2026-09-20
**Source:** found 2026-09-19 in a real capture; agreed 2026-09-20.
**The summary gives the link and stops there.** `parse_lldp_summary` read the
fixed-width table and nothing read the detail form, so a command that returned
a neighbour parsed as zero. Nothing was *missing* from the diagram — the
summary already carries the cable — but the detail form carries the two things
that make a neighbour joinable: its **chassis MAC** and its **management
address**. Without them a neighbour that cannot be matched by name stays a
separate node beside the host a sweep already drew (LT-126).
**Shipped:** `parse_lldp_detail`, and the crawl merges it onto the summary's
neighbours **by local port** — the one field both forms always agree on. A
summary row with no detail keeps exactly what it had; a neighbour the detail
form saw and the summary did not is still added.
**Measured on his 224E, before and after:** 0 neighbours parsed → 1, with
chassis `cc7f75……` and a management address, which is the Catalyst it is
cabled to and can now be joined to by MAC rather than by hoping the names
match.
**Four tests**, from that capture with the address, hostname and chassis MAC
replaced (D-027) — including that the capability legend every run prints is
not mistaken for a neighbour.

### LT-339 — One MAC, two switches: the quietest port wins — 2026-09-20
**Source:** his question of 2026-09-19 — "we may get multiple devices to the
same port that could be coming from another switch downstream" — planned and
agreed 2026-09-20.
**`selectAttached` already deduplicated by MAC and said in its own comment what
was wrong with how:** "the first sighting wins, which is the switch nearest the
seed". That is a fact about where the crawl started, not about where the device
is plugged in.
**The rule now, and it is the one every network management system uses:** the
switch that sees a MAC on the port with the **fewest** MACs wins. A switch
seeing it among thirty others is seeing it through something; a switch seeing
it alone has it in front of it. Ties break towards the sighting that resolved
an address, then by name, so the answer never depends on crawl order — there is
a test for exactly that.
**And it resolves before it filters**, which is the half that is easy to get
backwards: filtering first lets a filter knock out the true sighting and leave
a worse one standing, so the device would attach to whichever switch happened
to survive.

### LT-336 — A crowded port with nobody answering on it is drawn as the switch it must be — 2026-09-20
**Source:** his question of 2026-09-19, planned and agreed 2026-09-20.
**What made it safe is that the hard half was already decided.** The crawler
excludes every port with an LLDP or CDP neighbour from `attached` before the
front end ever sees it (LT-009), so a crowded port still in that list is one
where the crawl *asked* and nothing answered. The count is a number the switch
itself reported. Neither half is a guess.
**Shipped:** `inferredSwitches` finds them, and `buildTopology` draws one node
per crowded port — tagged `inferred`, labelled "Unmanaged switch on Gi0/11",
cabled up to the real port and with the crowd hanging off **it** rather than
off the socket. Its note says what is known and what is not: "What it is was
not discovered; that it is there was."
**Three is the threshold, and the reason is a desk phone.** Two MACs on an
access port is almost always a phone with a PC behind it — and a phone *is* a
three-port switch, so the deduction is true and useless. Three is where it
starts being worth drawing. The number is a parameter with a default.
**A deduction with nothing behind it is not drawn.** The node is created the
first time a device behind it is actually placed, so a crowd that was filtered
out leaves no switch claiming to exist.
**Counted from what LT-339 resolved**, not from every sighting — otherwise two
switches seeing one crowd invent two unmanaged switches.

### LT-337 — Every installer builds again
**Source:** asked 2026-09-19 — "go ahead and build the other OS's".
**LT-331 paused them on 2026-09-19 at his instruction** — "only windows
installer for now please I will tell you when to push the rest of the
installers later", then "Only nsis please". This is him saying so. A new ID
rather than reopening LT-331, because an ID is never reused (and this is the
third time the installer set has been narrowed and widened: LT-305, LT-311,
LT-331).
**Done 2026-09-19.** The Linux leg of the `bundle` matrix is back with
`bundles: deb,appimage`, and `bundle-macos` and `appimage-smoke` have lost
their `if: false`.
**The Linux leg was built here before pushing**, rather than trusting the YAML
to parse: `Coreview_0.2.0_amd64.deb`, 8.5 MB, in 12 minutes, carrying
`LICENSE.txt` and `THIRD-PARTY-NOTICES.md` beside the binary as
`bundle.resources` promises and declaring `iputils-ping`, `traceroute`,
`libwebkit2gtk-4.1-0` and `libgtk-3-0`. **macOS cannot be built or checked
from this machine at all** — Tauri does not cross-compile it and `.dmg`
creation needs `hdiutil` — so for that leg CI is the only check, and a Mac is
the only place the result can be opened. That limit is not new (HANDOVER 6.8)
and is worth restating every time this is turned back on.
**Windows stays at NSIS only**, and that is deliberate: "the other OS's" is
about macOS and Linux, and his instruction about Windows was explicit and
separate. The MSI line and `bundle-windows-offline` are still commented and
`if: false` respectively, each one edit from returning. Said here so it is a
recorded decision rather than something overlooked.
**The macOS `.dmg` is unsigned and un-notarised** and will be refused by
Gatekeeper as "damaged", which it is not — see HANDOVER 6.8 and the
`xattr -dr com.apple.quarantine` line. Unchanged by this item; worth doing
properly before the app reaches anyone who did not build it.

### LT-335 — **bug** Another project's logins showed, and a wiped one killed a crawl — 2026-09-19
**Source:** reported 2026-09-19 — "when I switch from one project to another the
passwords in tools settings showing! these passwords should be per project not
real global for all projects … must be separate from one project to another and
they don't leak, but global for within the project they belong to. also I keep
getting this msg That saved credential no longer exists."
**Two faults, and they share a cause**: a project stores credential *ids*, and
the vault they point into is one encrypted store per machine that outlives any
one project.
**The leak.** `credentialDefaults` has been per-project since LT-286 and
`openProject` replaces it correctly — but the Settings screen rendered the
vault's *whole contents* underneath, so opening a second project listed the
first one's credentials by label and username. The secrets never moved; the
fact of them did, and that is a leak. **Fixed:** the screen shows what *this
project refers to*, derived with no new storage — its own logins, its rules and
its devices (`credentialScope.ts`, seven tests). The machine-wide vault is one
disclosure away and says plainly that it is the whole computer.
**The failure.** An id goes stale whenever a credential is wiped, or a project
is opened on a machine whose vault never had it. Three places resolved one with
`?`: the SNMP list, and both halves of `resolve_bindings`. **One device
anywhere on the diagram still pointing at a wiped credential failed the entire
crawl**, with a message that named nothing and appeared wherever the run
happened to touch it. That is why typing fresh credentials did not help — the
stale reference was somewhere else.
**Fixed:** `credential_exists` is checked first and a missing one is skipped,
which is what the comment above the SNMP list had always claimed ("every one
that resolves is kept"). A binding is best-effort by construction. And the
front end prunes stale references once, on the Settings screen, where it can be
explained, rather than failing later somewhere unrelated.
**Checked:** a second project in `credentials.mjs` proves the first one's
logins do not appear, that the empty project says so, and that the vault
disclosure is shut; `db.rs` pins that asking for a wiped credential is an
answer rather than an error.

### LT-332 — **bug** A FortiSwitch's MAC table was read as nothing at all — 2026-09-19
**Source:** found 2026-09-19 while validating against his lab, on his
instruction to "ssh to the fortinet switch and fortigate and learn the
commands".
**Two faults, and the first was invisible.** `parse_mac_table` keeps a line
containing the word `DYNAMIC`; a FortiSwitch writes two lines per entry and
puts the flag on the second:

```
MAC: cc:7f:75:00:00:01   VLAN: 499 Port: port24(port-id 24)
  Flags: 0x00010441 [ hit dynamic src-hit native ]
```

so it read **0 entries from 12,499 lines** and said nothing about it. And the
crawl never asked for it anyway — the FortiOS branch sent no MAC-table command,
so `show mac address-table` was rejected and that was the end of it. Between
them, every endpoint a FortiSwitch had learned was invisible.
**Fixed:** `parse_fortiswitch_mac_table`, chosen automatically by looking at
the output so no caller has to know which platform answered, and `diagnose
switch mac-address list` asked of a FortiSwitch — only of a FortiSwitch, since
a wasted round trip on every firewall in an estate adds up. The result joins
the same list the IOS path fills, so port population, uplink detection and
attachment all work on it unchanged.
**`internal` is dropped**, and it is most of the table: a 224E reports its own
address on the CPU port once per VLAN — 4,094 of the 4,163 entries on his
switch, none of them a device.
**Measured on his 224E, before and after:** 0 entries and 0 distinct MACs →
**69 entries, 35 distinct MACs**, with port24 showing 27, which is exactly the
signature the topology code reads an uplink from.
**Second fault, same session:** `rejected_command` did not recognise
`Unknown action 0`, which is what a non-super_admin account gets for a
`diagnose` it may not run — confirmed twice on his FortiGate-60F. The crawl
could not tell "no endpoints here" from "this account may not ask", and
reported the first. Now 2 refusals are recognised where 0 were.
**How it was found, and the tools are committed:**
`examples/interactive_shell.rs` (now answering the FortiOS pager and the FIPS
banner the way a person would) captures a real session;
`examples/parse_capture.rs` runs Coreview's own parsers over the capture and
says what they understood. A parser that reads none of what it was given is
exactly the failure that tool exists to make visible.

### LT-321 — A choice of terminal: the panel, or the one already on the machine — 2026-09-19
**Source:** asked 2026-09-19 — "is it possible to let the admin select if they
want to open real terminal like putty or use the panel ssh".
**Shipped:** both entries are always on a device's right-click menu — **SSH to
this device** and **SSH in an external terminal** — and a setting says which
one the first entry does, so a preference never takes the other choice away.
The command is `{user}@{host}` with `{port}`, defaulting to PuTTY on Windows,
the `ssh://` handler on macOS and `x-terminal-emulator` on Linux, and editable
for anything else.
**The password is not passed, and that is D-048**, not an omission. `-pw` and
its equivalents put the secret on a command line, where the rest of the machine
can read it. The client asks; the username is already filled in.
**There is no shell.** The command template is split into a program and
arguments *first*, and the host and user are substituted into the pieces
afterwards, so a device calling itself `; rm -rf ~` can only ever be one
argument to PuTTY. Four Rust tests hold that, including the quoted Windows
path that made splitting necessary in the first place.
**Said plainly in the guide:** Coreview knows nothing about a session it did
not open — no log, no colour, no keepalive.

### LT-322 — Colour the output of devices that do not colour it themselves — 2026-09-19
**Source:** asked 2026-09-19 — "the panel ssh should have colorize output of
command line interface for devices where CLI is not colored by default".
**Shipped:** `src/lib/colourise.ts`, on by default, with a toggle in the SSH
tab. Errors and `%` lines, down and failure words, administratively down as its
own colour (a decision, not a fault), up and connected, addresses and MACs in
all three spellings, interface names, and the prompt.
**Everything about it is shaped by doing no harm.** A line carrying an escape
of its own passes through untouched, so a device that colours itself is left
alone. A line being redrawn — a pager, `?` completion — is left alone, because
it is not finished. Only **complete** lines are coloured, with the tail of a
chunk held until its newline arrives, and each character claimed by at most one
rule so escapes never nest. Eighteen tests, including a whole exchange
reassembled to prove nothing is lost.
**Two bugs, each found by running it and each fixed with a test.** The harness
found the first: a device ends a line with `\r\n`, and reading that trailing
carriage return as a mid-line redraw made *every* line untouchable, so nothing
was coloured at all. **A real 2960CX found the second**: `show ip interface
brief` has an `OK?` column heading, and `ok` was matching inside it — a heading
coloured as though it were a state, on every table the device prints.
**Otherwise it came through clean on real output — 2026-09-19:** 1,724 bytes
fed in 37-byte chunks that land mid-word and mid-line-ending, 55 coloured runs,
every escape balanced, and the text identical once the colour is stripped back
out.

### LT-323 — The terminal's font and size are the admin's choice — 2026-09-19
**Source:** asked 2026-09-19 — "also fonts and size".
**Shipped:** a font and a size on the SSH tab, applied to every open session at
once rather than only the next one, and remembered in the settings table — on
the machine, because this is how somebody likes to read and not a fact about
the estate.

### LT-324 — Save the session log, appended, where the backups go — 2026-09-19
**Source:** asked 2026-09-19 — "a checkbox to save log and save the log in the
same folders where the configuration files are pointed to save just like how
the backup saves the output and the name of the files, but it must append".
**Shipped exactly that, by reusing what backups already decided.** The
configuration folder from the project screen, one folder per device,
`backup_path_named` and the same `{site}_{device}_{stamp}_{kind}` pattern with
a new `BackupKind::Session` — so it also inherits the check that a device
calling itself `../../etc` cannot write outside the folder. Opened with
`append`, so reconnecting adds to the transcript rather than starting it again,
and a session still running already has its log on disk.
**The stamp is the day, not the second.** A backup stamps to the second because
two runs an hour apart are two captures; a transcript that is appended to wants
one file for the afternoon.
**Escape sequences are stripped** — `sessionlog.rs`, a nine-test state machine
that survives a sequence split across two chunks, resolves a redrawn line to
its final form, and rubs out what a backspace rubbed out. A saved capture is
meant to be read and diffed, and a file full of `ESC[` is neither.
**A tick on the tab** says which sessions are being recorded, from any other
tab; **Save the log** can be switched off without ending the session; and it
ticks when the log is actually open rather than when it was asked for.
**Proved against a device — 2026-09-19.** A real 2960CX session was run
through `SessionLog` end to end: 1,724 bytes in, 1,724 readable out, no escape
sequence and no bare carriage return surviving into the file. The path and the
naming are still only tested logically — those are `backup_path_named`'s rules,
which backups have been using for months.

### LT-326 — Save, Replace and Wipe on the discovery logins — 2026-09-19
**Source:** asked 2026-09-19 with two screenshots of the Discover devices tab —
"I need save button for snmp user and password in discover devices and save
button for the crawler user and password. also wipe and replace button".
**The machinery was there and called the wrong thing.** LT-286 already put the
whole life cycle under both the SSH login and each SNMP row; his screenshots
show the unkept state, where the only button said **Keep for this project** —
which does not read as Save, and where the wipe was three clicks away behind a
credential that had to exist first.
**Shipped:** **Save**, **Replace** and **Wipe**, in both places, in his words.
**Forget for this project** is kept beside Wipe because they are not the same
thing: forgetting stops *this* project using a credential, wiping takes it out
of the vault for every project on the machine and cannot be undone. Wipe is
marked as the destructive one and still asks first.
**No new storage.** The vault, `credentialDefaults` and the bindings were
already right (LT-318).

### LT-327 — Settings, on the Tools screen — 2026-09-19
**Source:** asked 2026-09-19 — "i need settings tab for global ssh user and
password and snmp user and password place it in tools and settings in the top
menue".
**There was nowhere that answered "what does this project log in with".** The
vault was on the project screen, which you have to close a project to reach,
and the discovery logins were inside a panel about running a scan.
**Shipped:** a **Settings** view on the Tools screen (LT-319) holding the
project's SSH and SNMP logins with Save, Replace and Wipe; the terminal
preferences, which were already settings with nowhere to be (LT-321–325); and
the vault itself, because "where are my passwords" and "what is my password"
are the same question asked twice.
**"Global" means the project's**, not the machine's — he said "global project
password", and `credentialDefaults` has been exactly that since LT-286. So this
is a home for something that existed, not a second store, and `CredentialOverride`
does both scopes with one form and one set of words.

### LT-328 — **bug** The reveal-password eye was dark on dark, everywhere — 2026-09-19
**Source:** reported 2026-09-19 with a screenshot — "the passwords revel button
not visiable because its dark" — and then, correctly: "the revel button is dark
for other places so make sure addressed globaly".
**He was right that it was global, and the cause is why.** The eye inside a
password field is not ours: the engine draws it, as `::-ms-reveal` in WebView2.
**A page that declares no colour scheme is assumed to be light**, so every
control the engine draws itself — that eye, the scrollbars, a number field's
spinners — was drawn for a light page and came out dark on this app's dark
chrome. No rule on our own elements could have reached it.
**Fixed with one line**: `color-scheme: dark` on `:root`, with `light` under
`@media print` because paper is light whatever the screen is doing. Our own
`.cv-eye` in the vault table also moved off `--text-faint`, which is a token for
text that is deliberately receding and never right for a control.
**`nativeControls.test.ts` holds it**, because one line is exactly the kind of
line that gets deleted by accident — the same reasoning as `groundTokens.test.ts`
after LT-315, and a different fault that that test could not have caught.

### LT-329 — **bug** "Create vault and save" was refused in silence — 2026-09-19
**Source:** reported 2026-09-19 — "can't create vault and save" — then, once
the rule was clear: "can't create vault and save with less than 12 characters
good keep it that way just fix the revel".
**The rule was right and has not moved.** Twelve characters is the minimum and
he confirmed he wants it. The fault was that the button simply went grey: the
minimum is stated in a paragraph at the top of the form, and nothing at all is
said at the point where pressing it does nothing.
**Fixed:** the form now says what it is waiting for, and changes as you type —
how many more characters, then the confirmation, then that the two do not
match — on the button's own title and beside it. Four checks in
`credentials.mjs` walk that sequence.

### LT-330 — The project's login is what everything starts from — 2026-09-19
**Source:** asked 2026-09-19 — "the discover devices should inherit the global
project password as first password, admin needs a check box to select it … but
global should be first but unchecked by default in the discover devices section
/ same for SNMP please / by default all devices should inherit the global ssh
and snmp password admin can override".
**The two defaults read as a contradiction and are not** — they are different
scopes, and each got the default he asked for:
- **A device inherits silently.** `planSsh` falls back to the project's
  credential, the device's own wins where there is one, and **SSH to this
  device** now works on a device nobody has given a login. One device is not an
  estate, and nothing is sent until a session is asked for.
- **The discovery form asks.** The project's login is offered as a **tick**,
  named, off until it is ticked, and first in the order once it is. It used to
  be applied silently as soon as the vault opened — a crawl logs into a whole
  estate, and it must not start doing that because a credential was saved for
  something else.
SNMP gets the same tick: a project keeps a list because a scan tries each in
turn, and the first is what everything falls back to.
**Which "global" this is:** the project's (`credentialDefaults`), which is what
he said — "global project password" — and which LT-327 gave a home.

### LT-331 — CI builds the Windows installer only, until told otherwise — 2026-09-19
**Source:** asked 2026-09-19 — "don't push all installers yet to github only
windows installer for now please I will tell you when to push the rest of the
installers later".
**The same call LT-305 made on 2026-09-12 and LT-311 undid on 2026-09-18**, for
the same reason both times: five installers on every push is the expensive part
of the pipeline, and while a feature is in flight only one of them is going to
be installed.
**Done:** the Linux leg of the `bundle` matrix is commented out and
`bundle-macos` and `appimage-smoke` carry `if: false`. Windows NSIS, MSI and
the offline pair still build. **Nothing is deleted** — each comes back in one
edit with its comments intact — and the `test` job still runs on Linux *and*
Windows, so nothing about Linux goes unchecked; only the bundling is paused.
**Reopen when he says so, and not before.**

### LT-325 — The session stays up until it is closed — 2026-09-19
**Source:** asked 2026-09-19 — "it must … send keep alive to maintain the
session until the admin close it, give admin real control please".
**Shipped:** an SSH-level keepalive every 30 seconds by default, settable from
0 (off) to an hour, changing every open session and not only the next one, with
**Last confirmed** in the panel so "is it still up" is answered by looking.
**It is driven by the session task, not by russh's own timer** — that is the
"real control" half. russh would send it from inside its own loop where nothing
can observe it; `Shell::keepalive()` is called on the operator's interval
instead, and each one that the connection takes is an event the window shows.
`keepalive_max: 0` leaves russh out of deciding a session is dead.
**Nothing is ever typed into the session to keep it alive**, and that is said
in the code and in the guide. A newline sent into somebody's half-finished
command line is how a keepalive becomes a configuration change.
**What it cannot do, and the guide says so:** a device with its own
`exec-timeout` will still close the session on its own schedule. This stops the
idle timers and the NAT translations in between; it cannot overrule the device.
**Proved against a device — 2026-09-19:** the keepalive went out on a live
2960CX session and the device sent nothing back at all, which is the point —
it must not disturb what somebody is half-way through typing.

### LT-320 — A shell on a device, in a tab, beside the others — 2026-09-19
**Source:** asked 2026-09-19 with a screenshot of SecureCRT — "the ssh should be
added to the bottom panel and everytime the admin ssh to device it should open
in a new tab in SSH tab in the bottom panel grouped with the reset of the opened
ssh sessions just like secure CRT" — and the half of LT-318 that had to wait for
a terminal to exist: "ssh to the device directly by selecting the device, right
click and ssh".
**What it needed that the app did not have, all three built:**
- **A terminal emulator.** `@xterm/xterm` 5.5.0 and `@xterm/addon-fit`, both
  MIT, both now in `THIRD-PARTY-NOTICES.md`. The first new front-end dependency
  in a long while, and not one worth writing.
- **A streaming SSH channel.** `ssh::Shell` in `coreview-discover` shares the
  handshake with `Device` and then stays out of the way: raw bytes both
  directions, `xterm-256color` rather than the `vt100` a capture asks for, a
  PTY sized by the terminal and resized with it, and no prompt detection,
  paging or enable — a person wants the device's own screen.
- **Session state that is not the document** — D-047, written the same day.
**Shipped:** **SSH to this device** on a device's right-click menu; an **SSH**
tab in the bottom panel showing how many are open; a tab per session with its
connected state and a close button; the device's saved login used to connect
(LT-318); the terminals kept mounted so switching tabs keeps every line the
device has said; and closing the project closing every shell.
**Two refusals before anything is sent**, because a timeout is the wrong answer
to both: a device with no address, and a device with no login of its own, each
say which half is missing. `sshLaunch.test.ts` pins those rules.
**Checked** by `e2e/ssh.mjs` — forty-three checks over the real protocol
(base64 in, base64 out, two sessions at once kept apart), plus `sane_size` in
Rust for the PTY a terminal that has not been laid out yet would ask for.
**And it has now met hardware — 2026-09-19**, at his instruction to run it
against the lab switch. `examples/interactive_shell.rs` drove a real 2960CX
through `ssh::Shell` with no stubs: shell open in 0.75s, the device drew its
prompt, a window-change to 200x50 was accepted, a keepalive went out and typed
nothing into the session, and typed commands came back echoed — which is what
proves the keystrokes arrived *as keystrokes* rather than as a command run on
somebody's behalf. `verified_against_hardware` is earned for the terminal.

### LT-319 — The bottom panel keeps what belongs to the diagram — 2026-09-19
**Source:** asked 2026-09-19 with a screenshot — "I think the bottom control
section takes too much space, I think its best to move them into tabs like the
address the onces that really don't need to be in the bottom panel like
compare, Racks, from drawing from file — the rest can stay in the bottom".
**The same split D-044 made when the register left the panel.** The bottom
panel answers one question — *what is happening to my diagram right now* — and
it had grown to ten tabs, so the answer arrived in a strip a few rows tall.
Four of the ten were never that question.
**Shipped:** **Tools** on the toolbar, beside the register, holding his four —
Compare, Racks, From a file, From a drawing — as one bar of tabs on a screen of
their own. Monitored objects, Event timeline, Ping sweep, Discover devices,
Backups and Path check stay in the panel, because each is something running
against the diagram while he works.
**Two things fall out of it.** A 42U rack no longer needs `.cv-panel.is-racks`
to borrow 64% of the window — the screen has the height, which is where it was
always going to have to come from. And the command palette's entries are
unchanged in name and still work: `requestPanelTab` redirects the four old tab
ids to the screen, so anything that learned them keeps working.
**Checked** through `racks.mjs`, `validation.mjs`, `importing.mjs`,
`endtoend.mjs` and `workflow.mjs`, all of which drove those four as panel tabs
and now drive them as a screen; `workflow.mjs` still audits every control on
both for an accessible name.

### LT-318 — A device keeps its own username and password — 2026-09-19
**Source:** asked 2026-09-19 — "on the side we need to add an override username
and password for admin to ssh to the device directly by selecting the device …
same for SNMP. override … admin needs a save button for every user and password
and saved on the app even after close or update the app. must be stored
encrypted on the app data base or encrypted file … also needs button to clear
user and password. global discovery username and password saved as well as SNMP
with option to save and clear".
**Half of it already existed and was not rebuilt.** The vault is Argon2id +
XChaCha20-Poly1305 (D-006), it survives a restart, the OS keychain can open it
by itself (LT-262), and LT-286 already saves and restores the **global**
discovery login — SSH and every SNMP row — with Keep, Forget and Delete in the
Discover devices panel. That half is his "global … with option to save and
clear", and it works today.
**The missing half was the device.** The inspector could only *choose* a
credential somebody had already built in Settings, which on a fresh install is
an empty list: there was no way to give one switch its own login from the
switch. **Its own username and password** now sits on every device — SSH with
a username, password and enable secret; SNMP with v2c or v3, the algorithm
words included — with **Save**, **Replace** and **Clear**.
**What is stored where, and it is checked:** Save makes the vault if there is
none (the passphrase form is now one component, `VaultGate`, rather than a
second copy of the flow inside `CredentialPicker`), puts the secret in it
encrypted, and writes only the **id** on the node. `e2e/credentials.mjs` drives
it end to end and asserts the password never reaches the saved document —
twenty-one checks, including that clearing deletes the vault record and unsets
the id. `credentialOverride.test.ts` pins the encoding the Rust side reads
back, where an empty username is what means v2c.
**Not shipped here, and deliberately:** *SSH to this device* on the right-click
menu. It is not a credential question — it needs a terminal — and it is
**LT-320**.

### LT-315 — **bug** The whole interface went dark-on-dark on the light ground — 2026-09-19
**Source:** reported 2026-09-19 — "Address register is dark and can't see it in
address tab … go through the tabs and words and make sure no dark on dark and
no white on white".
**Two faults, and the second is the one that mattered.** `CLAUDE.md` has said
since LT-046 that chrome reads the chrome tokens and the canvas reads the
ground ones, because only one of them flips. It was written down and never
checked, so it drifted:
1. `.cv-table tbody` took its background from `--page`. Press *White
   background* and every table turned white while its cells kept the chrome's
   near-white text.
2. **`.cv-app` set `color: var(--ink)`** — the inherited colour for the entire
   application was a ground token. On the light ground that is near-black text,
   inherited by every element that does not state its own colour, sitting on
   dark chrome. The register was the worst of it because it is mostly table,
   but it was everywhere: container rows, screen titles, numbers.
**Fixed** by putting chrome on the chrome tokens — `.cv-app` inherits `--text`,
tables and inputs and `kbd` take `--bg-raised` — and by giving `.cv-canvas` its
own `color: var(--ink)`, which is where the ground is supposed to flip.
**And it is now checked rather than remembered.** `groundTokens.test.ts` parses
the stylesheet, works out which rules are canvas and which are chrome, and
fails on any chrome rule reading a ground token. It found six on the first run.
**One harness read the wrong element.** `interact.mjs` sampled `.cv-app` to
decide whether the ground had turned white, which only worked because `.cv-app`
was painting itself from `--desk` — the fault itself. It now samples the
React Flow pane, which is the drawing surface, and checks alongside it that the
shell *stays* dark while the ground is white.

### LT-316 — Subnet rows in the hierarchy carry Edit and Remove — 2026-09-19
**Source:** reported 2026-09-19 — "if I just take without vlan or name I can't
edit or delete" — then **retracted the same day** after a retest: "actuly the
Hierarchy working when I add container and take subnet I can edit it in
address".
**So the bug was not real, and it is not recorded as one.** What the retest
showed instead was the thing behind the confusion: every subnet was editable,
but only from the Addresses view, because the subnet rows in the Hierarchy had
an empty actions cell. They now carry **Edit** and **Remove**, with the edit
form opening on the row itself — name, VLAN and note, validated the same way.

### LT-317 — **bug** A container reported more given out than it has — 2026-09-19
**Source:** his screenshot of 2026-09-19: `10.0.0.0/8`, capacity 16,777,216,
given out 16,777,472. A number that cannot be true, printed with a straight
face.
**Cause:** the rollup added every child container's capacity to every direct
subnet's size. His `/8` container holds a `/8` subnet *and* a `/24` container
that sits inside that subnet, so the `/24` was counted twice.
**Fixed** by merging the spans and counting the area actually covered. Where
the children genuinely overlap — which his do, and which is a fact about the
data rather than an error — the row now says **overlapping** beside the figure
instead of inventing one. A container whose children merely sit side by side
says nothing, because there is nothing to say.

### LT-314 — The production sweep, and one commit — 2026-09-18
**Source:** asked 2026-09-18 — "do a sweep on the app code and everything in
the app folder make sure it doesn't have anything personal or private … also
make sure github repo is clean and only contain the final push, no older
commits or anything extra".
**The sweep found two things worth acting on**, out of a working tree that was
otherwise clean of the whole scrub list:
- `scripts/import-pptx-stencils.test.mjs` carried an absolute path through his
  home directory and a Claude uploads id. It now reads
  `COREVIEW_PPTX_FIXTURE`, the way the Visio fixture already worked, and skips
  when it is unset.
- A tracked file literally called `ROOT CERT` — the **public** root CA
  certificate, no private key in it, which is exactly the file that has to be
  published for a signed installer to name its publisher. Renamed to
  `brand/coreview-root-ca.crt` and explained in `docs/SIGNING.md`, where it
  belonged.
Everything else came back empty: no lab addresses, hostnames, MACs or serials;
no credentials; no keys or `.env`; no personal paths beyond the generic
`/home/user` and `C:\Users\me` that test fixtures use on purpose.
**Two stale claims in the documentation were also wrong and are fixed:**
HANDOVER still described `e2e/dbg.mjs` and `dbg2.mjs` as debris to be removed —
they were removed long ago, and the two Python scripts that *are* there are
tools, documented where they are used.

**The history is now one commit.** He asked for it, and it does more than tidy
up: **it is what finally closes LT-137 and Q-014.** A real SNMP passphrase had
been a test fixture, and lab identifiers — his own subnet, hostnames, MACs and
serials — sat in commits published on GitHub. Both were fixed in the working
tree months ago and both survived in history, and the only two ways out were a
history rewrite or rotating everything. The rewrite is done: there is no
earlier commit for them to survive in.
**What that costs, stated plainly:** every previous commit hash is gone, along
with the reasoning in 288 commit messages. `docs/ROADMAP.md` and
`docs/DECISIONS.md` are why that is survivable — the *why* was never only in
the commit log. The old history was kept on this machine as the branch
`archive/pre-release-history` before the force-push, and is on no server.

### LT-313 — No trademark claimed, and the licence lets people pass it on — 2026-09-18
**Source:** reported 2026-09-18 with a screenshot of the installer's licence
page — "I think we made a mistake I don't own the Trade mark Coreview … TM
should not be used for Coreview", and "just make it simple and for me to be
able to share it with friends and other network engineers".
**Two mistakes, and the second was mine more than the first.**

**The ™.** LT-308 put `Coreview™` and `Almoola™` into the licence, the README
and About — and from there onto the licence page of every installer. A ™
asserts a mark; he does not own one, and *CoreView* is an established company
in another corner of the industry. Removed everywhere, with a line in the
licence saying the name is used as the name of the program and is **not**
claimed as a trademark. Copyright is untouched: `©` is automatic and needs no
registration or claim.
**He chose to keep the name** rather than rename — the alternative was renaming
the data folder, the file extension, the bundle identifier and three crates,
which orphans the projects already on his machine unless a migration is written
and tested on Windows. That trade was put to him plainly and he took the cheap
side of it.

**The licence forbade the one thing he wanted it to do.** It said the app "may
not be copied … distributed", which meant a colleague he gave it to could not
pass it on — while every sentence around it said this was for sharing with
other engineers. Rewritten in plain words:
- **It is free.** Any lawful use, any number of machines, no key, no
  activation, no registration. What he makes with it is his.
- **It may be passed on** — to a colleague, on a forum, from GitHub — provided
  it goes unchanged, with the licence and the third-party notices beside it,
  and never for a fee.
- **Reserved:** selling it, modifying it, derivative works, rebranding,
  reverse engineering. The source is public so anyone pointing it at a network
  can read what it does; reading it is not permission to reuse it.
**The redistribution clause carries the attribution duty with it:** a copy
passed on must keep `THIRD-PARTY-NOTICES` alongside, which is exactly what MIT
and Apache-2.0 ask of whoever distributes a binary.
**`licensing.test.ts` grew three checks**: no `™` in the licence, README or
About; the licence still says the name is not a trademark; and it still both
permits passing on and reserves selling and derivative works. `CONTRIBUTING.md`
now opens with "free to use and free to pass on" rather than implying the
licence is tighter than it is.

### LT-312 — The third-party notices, done properly — 2026-09-18
**Source:** asked 2026-09-18 — "how do we correct this … I dont want any issues
or deal with legal, also i want the app to be free for public use".
**The finding first, because it is the answer to the worry.** Every component in
both trees was checked: **there is no GPL, AGPL or SSPL anywhere**, so nothing
prevents Coreview being distributed as proprietary software, free to use. The
tree is MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0, Unlicense and CC0 — all
permissive, all attribution-only. Two things needed naming rather than fixing:
- **`r-efi`** offers `MIT OR Apache-2.0 OR LGPL-2.1-or-later`. An *or*, so MIT
  is taken and the LGPL is never reached.
- **Five MPL-2.0 crates** (`cssparser`, `cssparser-macros`, `dtoa-short`,
  `option-ext`, `selectors`). MPL-2.0 is copyleft *per file*: linking it into a
  larger proprietary work is expressly allowed, and the only obligation is to
  publish the source of any MPL file you **modify**. Coreview uses them exactly
  as published, and the notices name them with their source addresses.
**What was actually wrong with LT-308's version, and is now fixed:** it listed
package *names*. MIT says "the above copyright notice and this permission
notice shall be included in all copies" — the text itself has to travel with
the binary. `THIRD-PARTY-NOTICES.md` now reproduces every licence file found in
every shipped component, 364 distinct texts, identical ones grouped with the
components that share them.
**And it ships.** `bundle.resources` installs `LICENSE.txt` and
`THIRD-PARTY-NOTICES.md` beside the application, which is what discharges the
obligation — a file in a repository does not travel with an installer. About
says where it is.
**The generator refuses rather than warns.** A component under a blocking
licence fails the script instead of writing the file, and `licensing.test.ts`
fails the build if the notices lose their licence texts, if a manifest drifts
from `LicenseRef-Almoola-Free-Proprietary`, if `publish = false` disappears, or
if a copyleft licence ever appears in the tables.
**Free for public use is unaffected by any of it**, and that is worth saying
plainly: no dependency here restricts how Coreview may be used, priced or given
away. The obligations are attribution, and they are now met in the one place
they have to be met — inside the installer.

### LT-308 — Author, date and the licence — 2026-09-18
**Source:** asked 2026-09-18 — "can you add me Mohammed Almoola as Author and
date the app, you can use my linked in", with the licence text to use verbatim.
**Shipped.** `LICENSE` carries his words unchanged. About shows the author with
the LinkedIn, the build date beside the version, and the terms in full.
`package.json`, `tauri.conf.json` and all three Cargo manifests now name him as
author and the licence as `LicenseRef-Almoola-Free-Proprietary`, with
`publish = false` on the crates.
**One of those manifests was actively wrong:** `coreview-probe` declared
`license = "MIT"`, which contradicted the licence being written on the same day
— exactly the kind of thing "ready for production" is supposed to catch.
**And the part that is an obligation rather than a preference:**
`THIRD-PARTY-NOTICES.md`, generated by `scripts/third-party-notices.mjs` from
the real dependency trees — 34 npm packages in the bundle and 630 crates in the
executable. MIT and Apache-2.0 require their notices to travel with a binary,
and a proprietary licence is not an exemption. Development-only packages are
left out, because they never reach an installer.
**Q-009 is closed by this**, and `docs/BRAND_AND_LICENSING.md` no longer says
the licence is undecided.

### LT-309 — The logo — 2026-09-18
**Source:** asked 2026-09-18 with an image — "also update the logo".
**Shipped.** `brand/coreview-mark.svg` — his mark redrawn as geometry: a core in
a hexagon, four things on the compass points, four amber taps on the diagonals,
grid ticks behind. Drawn rather than traced because Coreview ships no
third-party artwork (D-028) and an icon has to hold from 16px to 1024px.
From it: `icon.ico`, `icon.icns` and every PNG size Tauri bundles, and a small
`currentColor` version of the same shape beside the wordmark in the toolbar, so
it takes the accent colour and needs no second asset.
**The Android and iOS sets `tauri icon` also writes are deleted** rather than
committed: this is a desktop application with no mobile target, and the icons
README says so for whoever regenerates them next.

### LT-310 — The repository, ready for production — 2026-09-18
**Source:** asked 2026-09-18 — "clean up the documentations and make it fully
ready for production".
**Shipped.** The README opens with the author and the licence and closes with
the terms in full, including what "free" means in practice — use it anywhere,
no key, no activation, no seat count; redistribution and derivative work are
what is reserved. `CONTRIBUTING.md` now says at the top that this is
source-available and not open source, because inviting pull requests under a
licence that forbids derivative works is unfair to whoever writes one.
`BRAND_AND_LICENSING.md` states the answer rather than the open question.

### LT-311 — Every installer, including the offline one — 2026-09-18
**Source:** asked 2026-09-18 — "build windows exe, msi and macOS and Linux,
also build the offline installer".
**This reverses two standing instructions, and both were his.** LT-305 had
narrowed CI to Windows that morning; LT-123 and LT-143 had kept the air-gapped
installer off since 2026-09-12 — "don't build the airgapped installer that
large 500 mig until i finish testing and I will tell you when to build it".
**Shipped.** The bundle matrix is Linux and Windows again, `bundle-macos`
builds the universal `.dmg` unconditionally, and `appimage-smoke` proves the
AppImage still carries its own WebKit. A new `bundle-windows-offline` job
builds the same commit with `webviewInstallMode: offlineInstaller` — the
WebView2 runtime inside the installer, no internet needed, and the ~500 MB that
made him hold it back.
**`src-tauri/tauri.offline.conf.json` overrides exactly one field.** Tauri's
`--config` merges rather than replaces, so the offline installer differs from
the ordinary one in that field and cannot drift in any other.
**A job of its own rather than a matrix leg**, so a failure there never holds up
the installer everyone actually uses.

### LT-303 — The user guide, in the app — 2026-09-18
**Source:** asked 2026-09-18 — "can we make a detailed instructions tab with
just like how you did the IPAM section?", clarified as "just a content type of
documentation on how the app works just like any help me type of documentation
and instrrcution how to use Coreview".
**Shipped.** **Help** in the toolbar opens the guide on a screen of its own:
sections down the left, the section on the right, and a search box that reads
the *whole* of every section rather than only the titles — nobody looking for
"why is my device grey" knows which of twenty-four headings it lives under.
**It is the same file that ships in the repository.** `docs/USER_GUIDE.md` is
read at build time with Vite's `?raw`, so there is one copy of the guide and
the app cannot drift from the documentation. Editing the guide edits the help.
**A parser of its own** (`helpDoc.ts`), not `noteMarkdown`: the guide has fenced
code and tables, notes have neither, and widening the note parser to suit a help
screen would change what a note draws.
**Checked** in `helpDoc.test.ts` — including against the real guide, which must
parse, must leave no section empty, and must give every section a distinct id.

### LT-304 — **bug** The subnet size field would not take "/24" — 2026-09-18
**Source:** reported 2026-09-18 with a screenshot — "I still can't take subnet".
**Two faults, one screenshot.** He had typed `/24` in the size field, which is
what a network engineer writes; `Number('/24')` is `NaN`, so no block was free,
so the form showed "every address here is already given out" — an answer to a
question he had not asked. And the container genuinely *was* full, because it
holds a `/8` subnet, which is the other half of why nothing was offered.
**Fixed:** the field takes `24` or `/24`, and says so when it is given neither.
A size that is not smaller than the container says *that*, rather than pretending
the space is used. The "everything is given out" message is now the last resort
it should always have been.

### LT-305 — CI bundles Windows only while this work is in flight — 2026-09-18
**Source:** asked 2026-09-18 — "only let CI build the windows exe installer for
now until we finish everything and then we build macOS and Ubuntu please",
alongside "test before commit to preserve GitHub tokens as I'm running low".
**Shipped.** The bundle matrix is Windows alone; the Linux and macOS jobs and
the AppImage smoke test are kept in full behind `BUNDLE_ALL`. Setting that
repository variable to `true` (Settings → Secrets and variables → Actions →
Variables) builds every platform again — nothing was deleted, so turning them
back on is one switch rather than a rewrite.
**The tests still run on Linux and Windows on every push.** Only the bundling
narrowed: a compile failure on either platform still fails the build.

### LT-306 — The dark ground is green — 2026-09-18
**Source:** asked 2026-09-18 with a swatch — "I need to change the color from
this dark blue to this green with the little dots in the back".
**Shipped.** Every dark-ground token moved from blue-grey to green at the same
lightness, so contrast and the relationships between surfaces are unchanged —
the desk, the page, the chrome, the panels, the lines and the three text
weights. A faint dot texture sits behind the chrome at 6% alpha.
**What deliberately did not move:** the accent and the status colours. Healthy,
warning, down, unknown, disabled and maintenance mean something, and an accent
that drifted towards green would sit on top of "healthy" — the one pair that
must never be confused. High contrast turns the dots off entirely: texture costs
contrast, which is the whole point of that ground.
**Colour still lives in exactly three blocks** of `styles.css` plus
`theme.ts`, as the file's own first comment requires.

### LT-301 — **bug** A container could not be edited at all — 2026-09-18
**Source:** reported 2026-09-18 with a screenshot — "I can't edit the
containers".
**An omission, not a decision.** LT-297 built `updateIpamContainer` in the
store, with validation and a history entry, and never put a form on it. A
container row offered "Take a subnet from this" and "Remove", so a name typed
wrong was fixed by removing the container and adding it again — which loses
every subnet's place in it.
**Fixed:** **Edit** on every container row — prefix, name, note — validated
like any other subnet field, with a bad prefix refused rather than stored.

### LT-302 — Taking a subnet from a container defines it in the same step — 2026-09-18
**Source:** the same message — "I can't take subnet from container and define
the subnet and so on".
**What it did:** offered up to four free blocks as buttons and, on a press,
created a subnet with no name, no VLAN and no note — which then had to be found
on the Addresses view and edited. The reason to allocate out of a container is
that it is one step, and it was two.
**Fixed:** taking a subnet opens a form — size, which free block (a list, not
just the lowest), name, VLAN, note — and creates it inside the container, in
that container's routing table, in one call and one line of history.
**And a container with nothing free now says why.** His screenshot showed
"Nothing of that size is free in this container" on a `/8` container holding a
`/8` subnet. True, and useless: it now names what is using the space —
"every address here is already given out — 10.0.0.0/8 (10 Space)".

### LT-300 — The register is one screen of its own, reached from the toolbar — 2026-09-18
**Source:** asked 2026-09-18 — "whats the difference between address and ipam,
can we combine, also can we move ipam to the top menu instead if the bottom, and
have it open up tabs and switch to its own screen".
**The difference was build order, not design.** "Addresses" (LT-285) was the
register as a table; "IPAM" (LT-297) was the hierarchy and the tools. Both
listed the same subnets and sat side by side in the bottom panel, which is
exactly the shape that makes a person ask what the difference is. There was no
answer worth giving, so the question was the bug report.
**Shipped.** One screen, **Addresses** in the toolbar, with a bar of five
views — Addresses, Hierarchy, Allocate, Split & merge, History — and "Back to
the diagram". Both bottom-panel tabs are gone; every other tab there is
untouched.
**Three things it had to get right, and each is checked:**
- **The diagram stays mounted behind it.** React Flow rebuilds its viewport
  from nothing when unmounted, so leaving the register would have come back to
  a diagram that had jumped. `.cv-main` is hidden, not removed.
- **One bar, not two.** The workbench's own tab strip is only drawn when it is
  used on its own; given a `view` from the screen above it renders that view and
  no strip, so there is one row of tabs rather than a row inside a row.
- **Nothing that asked for the old tabs falls silent.** A `requestPanelTab` for
  `ipam` or `lab` opens the screen instead of selecting a tab that is no longer
  there.
**F6 reaches it:** `.cv-register` joined the region cycle, and because the
regions behind it are hidden the existing visibility check already narrows the
cycle to the toolbar and the register without a special case.
**And the clipping is gone** — the split review and a deep hierarchy were being
cut off by a panel sized for watching a scan run.

### LT-297 — IPAM Phase 1, and a tab of its own — 2026-09-18
**Source:** the IPAM programme of 2026-09-18, then "go ahead do it all … build
them and design a new dedicated tab for them to switch over to them i love it".
**Shipped: an IPAM tab, beside Addresses, with four views.**

**Hierarchy.** Network containers — folders for address space, not subnets
anything sits on. `198.51.0.0/16` holds a site holds its subnets, nested by
what contains what rather than by what claims what (**D-042**), with capacity,
what has been given out, what is left, and addresses used rolled up the tree.
"Take a subnet from this" offers the free blocks of a chosen size, lowest
first, and adds the one picked to the register inside that container.
**Routing tables** live here too: a VRF list, `Global` always present and never
removable, a new one added by name, and one still holding subnets refused with
the count. Uniqueness across the register became `vrf + address`, so the same
subnet in two routing tables is two subnets and neither is a conflict.

**Allocate.** The wizard, in four steps: which subnet (searchable), which
address (the next free one, or a particular one), what it is (name, held as,
used as, hostname, MAC, owner, purpose), and a check that refuses the network
and broadcast addresses, an address already taken, one inside a DHCP pool or an
excluded range, and **the same MAC anywhere else in the project** — which is
how the machine somebody moved and never mentioned gets found.

**Split & merge.** Both are planned before they happen (**D-043**). A split
shows what each child would take with it, and a range crossing a new boundary
stops it outright rather than being cut in half. A merge takes only real halves
of one block: adjacent is not enough, and two that touch but are not a pair say
so. Children keep the container and VLAN they came from.

**History.** Every change to the register, newest first, with a field-by-field
diff of what it was and what it became — added, edited, removed, split, merged.
Kept in the project, capped at 500. **It is not an audit trail and the tab says
so**: there are no logins in Coreview, so it records what changed and when,
never who.

**Conflicts** are reported across the whole tab: two *devices* on one address in
one routing table. Deliberately narrow — a typed record documenting a device is
not a conflict, and flagging it would train people to ignore the column.
**Two bugs the harness caught before he could:** a subnet taken from a container
was added and then edited through a store snapshot captured at render, so its
container never stuck; and `add()` spread its caller's `vrfId: undefined` over
the default, which quietly put everything in one routing table.
**Checked** in `ipamPlan.test.ts` (24), the additions to `ipam.test.ts`, and
`e2e/ipamlab.mjs` (37 checks) which drives the tab itself.

### LT-294 — DHCP ranges, so "free" means free — 2026-09-18
**Source:** asked 2026-09-18 — "reserve dhcp … just like infoblox ipam".
**Why it mattered more than it looked:** a pool a DHCP server hands out read as
empty space. Someone takes the "next free" address, the server leases the same
one that afternoon, and two things answer to it. LT-289's *excluded* kind could
mark them one at a time, which nobody does two hundred times.
**Shipped.** A range on a subnet — first address, last address, a name, a note,
and what it is: **a DHCP pool** or **excluded**. `free` is now
`usable − used − excluded − pooled`, the next free address steps over both kinds
of range, and each subnet says "· 40 in a pool" beside its count. Ranges are
listed above the addresses they cover, and an address inside one says which.
**The arithmetic is the part worth reviewing** (`ipam.test.ts`): a range never
counts the network or broadcast address; two overlapping ranges do not count the
overlap twice; a DHCP reservation inside its own pool is one address, not two;
and a range wider than 65,536 addresses is counted rather than walked.

### LT-295 — Every field in the register is editable, including a device's own address — 2026-09-18
**Source:** asked 2026-09-18 — "I need to edit every field in the ipam … all
fileds should be something that we could edit just like infoblox ipam".
**What was left:** subnets and the register's own addresses were editable; a row
that came from a **device** was not, because its name and address belong to the
diagram.
**Shipped.** Editing a device row opens a form that says so — "this address is on
*Core switch*, on the diagram" — and saving writes through to the device itself:
name, address, interface label, MAC, hostname. One undo step, the same edit the
inspector makes. It searches every page, because the register is project-wide and
`updateNodeData` only ever reached the page being looked at.
**Said out loud rather than prevented:** a crawl will overwrite what it reads from
the device again. The form says so; refusing the edit would be worse.

### LT-296 — The discovery form fills itself in from what the project knows — 2026-09-18
**Source:** asked 2026-09-18 — "but also I need it to auto populate the fileds in
discovery please".
**Shipped.** **Fill from this project**, beside the seeds: the register's subnets
go into "stay inside these subnets", and the addresses of the devices a crawl can
actually walk from go into the seeds — core switches first, then L3 and
distribution, routers, firewalls, access switches, controllers. A printer is
never a seed. A device a crawl has already reached is preferred over one nobody
has tried, and ten is enough: past that it is a list nobody reads.
**Proposed, never applied.** It fills the form and says what it filled; a scan
reaches out to real equipment and stays something he starts deliberately.
`discoverySuggestions` is pure and unit-tested; nothing about it starts a run.

### LT-291 — **bug** The crawl panel said credentials are never saved — 2026-09-18
**Source:** reported 2026-09-18 — "'Credentials are used for this run only and
are never saved' I need to save the credentials please".
**It stopped being true this morning** and the form went on saying it. LT-286
had put "Keep for this project" in that very panel; the sentence under it, and
the SNMP rows' "Typed below, for this run only", both said the opposite. He
asked for the feature again because the app told him it did not exist.
**Fixed:** both sentences now say what happens — typed credentials are used for
the run and forgotten, and keeping one puts it in the vault and remembers it for
this project. Checked in `e2e/scansettings.mjs`, which now fails if the words
"never saved" or "this run only" come back.

### LT-292 — A project's SNMP credentials come back the way its SSH one does — 2026-09-18
**Source:** asked 2026-09-18 — "I need to save the credentials please both SNMP
and discovery on the projects".
**Half of it was built and did nothing.** `rememberCredential` had been writing
`credentialDefaults.snmp` since LT-286 and nothing ever read it: the chooser only
reached for a remembered credential when its kind was `ssh`. SNMP rows came back
from the machine-wide `scanSnmpRows` setting, so they were the same rows in every
project.
**Shipped.** A project that remembers SNMP credentials builds its rows from them,
one per credential; the global setting is the fallback for a project that has
kept none. The same rule for SSH: the project's credential beats
`scanCredentialId`. A second project no longer opens on the first one's login.
**A real bug found on the way, and it is why the SNMP half never worked in
testing:** every chooser kept its own copy of the vault's state, read once when
it mounted. Keeping an SSH credential created the vault, and the SNMP chooser
beside it went on believing there was none — so its "Keep for this project"
asked to create a second vault instead of saving. There is now a `vaultRevision`
in the store that every chooser watches, and the button re-reads the vault's
state before deciding what to do.
**Also fixed:** `forgetCredential` read `id !== undefined && x !== id`, which
emptied the whole SNMP list whenever it was called without an id.

### LT-293 — Save, override and wipe a project's credentials, from where they are used — 2026-09-18
**Source:** asked 2026-09-18 — "per project and they can saved and replaced and
wiped give me control please so we can save and over ride and wipe the saved
creds".
**Shipped.** Beside a credential a project keeps, three controls:
- **Replace it** — the typed fields come back, and saving overwrites *the same
  vault record*, so anything else pointing at it gets the new password and this
  project's reference does not move. (`save_credential` with an existing id
  already did this: `ON CONFLICT(id) DO UPDATE`.)
- **Forget for this project** — the project stops using it; the credential stays
  in the vault for whatever else does.
- **Delete from the vault** — after confirming, the secret goes, for every
  project. The reference goes with it.
**The distinction between the last two is the whole point** and the wording
carries it: one is "not here", the other is "gone".
**A flaw the test caught before he could:** the first build said "type the new
username and password above" while those fields were hidden, because a chosen
credential hides them. They are shown while replacing.

### LT-288 — The register's subnets are the admin's to edit, not just to read — 2026-09-18
**Source:** asked 2026-09-18, after using LT-285 against a real estate — "we
should make the IPAM more granular, giving the admin control to add, remove,
rename, update names … just like Infoblox".
**Shipped.** Every subnet in the register carries **Edit**, **Add address** and,
once it is the register's own, **Remove**. Edit opens a form on the row itself —
subnet, name, VLAN, note — rather than in a cell, so the fields are readable.
A subnet the app worked out for itself reads **Name it**: naming it *adopts* it,
which declares it in the register and makes it editable and removable from then
on. The form starts pre-filled with the interface a connected route named, which
is the name most people would have typed anyway.
**Two things the adoption had to get right**, and both are tested:
- Removing an adopted subnet returns it to derived rather than deleting it. The
  addresses on it are real and go on existing; only the declaration goes.
- A declared subnet still says what confirms it — "declared · also from
  addresses", or "· also connected route". Adopting a subnet must not erase the
  evidence for it, and the first build of this quietly did: a block the devices
  confirmed never got marked, because the declaration already contained them.
**Clearing a field clears it.** An emptied name is dropped rather than stored as
an empty string, so a subnet goes back to unnamed instead of being named nothing.

### LT-289 — Addresses the register owns: add, name, change, remove — 2026-09-18
**Source:** the same message — "also add address and remove address and
subnets, reserv .... etc".
**Shipped.** An address record with a **kind**, which is what makes the numbers
mean anything:
- **reserved** — held for something not built yet;
- **in use** — a real address on something not on the diagram: a printer, a
  server, someone's static lease;
- **excluded** — not to be handed out, and so neither free nor used.
Each carries a name and a note, and each can be edited or removed from the row
it sits on. **Add address** starts on the subnet's next free address, so holding
one back is still one click and one name. The free count is now
`usable − used − excluded`, and the next-free address skips all three kinds. An
address both excluded and in use counts as in use: the exclusion is the thing
that turned out to be wrong, and hiding it would be the lie.
**Migration, and it mattered.** `ipam.reservations` shipped this morning in
6bfeee6 and lasted one morning. `migrate.ts` turns it into `ipam.entries` with
`kind: 'reserved'`, and `entriesOf()` reads the old field for anything that has
not been through the migration — an exported package opened straight from disk,
for one. Tested both ways round.

### LT-290 — **bug** The address rows sat under the wrong column headings — 2026-09-18
**Source:** visible in his screenshot of 2026-09-18: `Discovered` — an
interface label — printed under **USED**, and the address repeated under
**SUBNET** and **NAME**.
**Cause:** LT-285's expanded address row had eight cells written for an address,
laid out under a header row written for a subnet. They lined up by accident
where they lined up at all: the interface fell under Used, the MAC under Free,
the note under Next free.
**Fixed** by giving the addresses their own table, with their own headings —
Address, Name, Held as, Interface, MAC, Note, Known from — inside the row that
expands. Two different things were being shown through one set of headings, and
no amount of reordering cells fixes that.
**Reproduced by reading the rendered table, not by eye** (`e2e/ipam.mjs`): the
check finds each column by its heading and asserts the cell under it, so a
future reshuffle fails the test rather than looking fine in a screenshot.

### LT-285 — IP address management (IPAM) — 2026-09-18
**Source:** asked 2026-09-18 — "is it possible to add an IPAM to the app".
**Scope taken, and Q-015 answered with it:** both halves, because either alone
is the spreadsheet again. The *known* half is derived, never stored: subnets
and what is on them are computed from the devices in the project every time the
panel draws, so an address that moves in the diagram has already moved in the
register. The *declared* half — subnets someone has decided on, and addresses
held back for something not built yet — is typed, and is the only part kept in
the project document.
**Shipped.** An **Addresses** tab in the bottom panel. Subnets appear without
being asked for: a crawled device's *connected* routes give the real prefix and
mask (a /25 stays a /25), named after the interface they are on; anything else
falls back to the /24 around it. Each subnet shows used and usable, a
utilisation bar, free count, the lowest address nothing is on, and where the
subnet itself came from; expanding one lists every address with the device, the
interface label, its MAC and how it was learned. "Add subnet" takes a CIDR,
name and VLAN, normalises what is typed to the network address and refuses a
duplicate; "Hold it" reserves the next free address with a note. An address
lands in the *most specific* subnet that contains it, as the routing table
would have it. Export: **Addresses as CSV**, a row per known address.
`src/lib/ipam.ts` is the arithmetic, pure and unit-tested (12 tests);
`e2e/ipam.mjs` drives the panel (21 checks). Undo covers it: the address
register was added to the undo history entry and to the packed history, so a
subnet removed by accident comes back.
**IPv4 only, deliberately.** "How many addresses are free" is not a question an
IPv6 prefix has a useful answer to; v6 addresses are listed against their device
and named in the panel as not counted, rather than silently dropped.
**Nothing ships pre-filled** — no example subnets, no addressing plan (D-027).

### LT-286 — A project remembers which credentials it uses, so nothing is retyped — 2026-09-18
**Source:** asked 2026-09-18 — "its still not saving the passwords to the app
after installed, thats causing an issue everytime I need to rescan or take a
backup i have to type the passwords, we need to change that to let the app
retain the password per project".
**The standing decision held, and is why this is shaped the way it is.**
Passwords live only in the encrypted vault (D-006; LT-137 is the scar). A
password written into the project file would travel with every exported
package and every diagram sent to a colleague. So: the *secret* goes in the
vault, and the *project* remembers which credential it uses, by id.
**Why it asked every time until now:** the saved-credential chooser only
appeared when a vault already existed and was unlocked, and nothing in the crawl
or backup form offered to keep what had just been typed. A fresh install has no
vault, so every run was typed from nothing.
**Shipped.** "Keep for this project", beside the typed credentials in the crawl
form, the backup form and each SNMP row. One step: it creates the vault if
there is none (asking for a passphrase once, with the minimum length and the
no-recovery warning stated), unlocks it if it is locked, ticks "open the vault
by itself on this computer" (LT-262) so the passphrase is not asked for again on
that machine, saves the credential labelled after the project, and records its
**id** on the project (`credentialDefaults`). Next time the project is opened
the credential is chosen by itself and the password fields are not shown at all.
Choosing one from the list by hand records it the same way.
**Checked** in `e2e/scansettings.mjs`, which starts with no vault, keeps a
credential, and after a reload finds it chosen with no password field on the
form — and re-checks, with the distinctive fixture secrets, that nothing secret
reached the settings table or the project document.

### LT-287 — **bug** Space-drag panning needed the space bar let go, and often did not take — 2026-09-18
**Source:** reported 2026-09-18 — "when I hold shift and try to drag around to
move the whole diagrma around its still bugy i have to hit the space bar in the
keyboard then right select and hold then let go the keyboard and some times it
works and some times it doesn't work i want to be able to hold the space bar and
right select hold and move around without letting go the space bar".
**Reproduced first (D-020), and the Chromium harness was not enough.** With
space held, a **left**-button drag panned (317,307 pixels changed between
screenshots); a **right**-button drag moved nothing (368). The e2e harnesses
run against Chromium, where the right button pans perfectly well — this only
happens in WebKitGTK, so it was reproduced in the real app under Xvfb by
screenshot comparison, which is now how it is verified.
**Two causes, both fixed.**
1. **The right button.** WebKitGTK claims a right press for a context menu, and
   the element then receives no further pointer events for it — pointer capture
   included — so the pan sheet saw a press and nothing after it. The sheet now
   refuses the press (`contextmenu` and `mousedown`) and follows the drag on
   **window** listeners, hearing both the pointer and the mouse pair, with the
   viewport set from the absolute distance travelled so hearing the same
   movement twice is harmless. Both pan paths — the sheet, and the drag already
   under way when space arrives (LT-158) — now share that one function.
2. **Shift.** The report starts with shift-drag, which was React Flow's
   selection box. A plain drag on the pane already draws a selection box, so
   nothing was lost by making Shift a second hand for panning. Alt+Shift stays
   the lasso that adds to a selection (LT-173), whichever order the two keys go
   down in.
**Verified in the real app** (WebKitGTK under Xvfb), with the key never
released: right + space 274,449 pixels changed; left + space 290,948; left +
shift 302,991; right + shift 267,262 — all measured *during* the drag, with no
menu opened and nothing left stuck. Chromium checks added to `e2e/canvasfix.mjs`
(the shift half fails there without the fix; the right-button half cannot, which
is the point).

### LT-272 — i18n scaffolding, English first — 2026-09-16
**Source:** mission, Phase 8. **Asked:** i18n scaffolding, English first.
**Shipped.** `src/i18n`: an English catalogue (`en.ts`), a typed `t(key, params)` with `{name}` placeholders and plural forms chosen by `Intl.PluralRules`, `addCatalogue` for further languages, and `setLocale`, which falls back from a region to its language to English and is set from the system language at start. The guided tour panel and the report dialog use it first. `index.test.ts` checks every `t('…')` key in the source has an English message, and placeholders, plurals and fallback. No dependency added. (The first CI run failed on Windows only: the key check built its folder path with `URL.pathname`, which Windows reads as `D:\D:\…`; it now uses `fileURLToPath`.) **English first means only English:** no other catalogue exists, and the rest of the interface still carries its text inline — moving it is the ongoing part, with the pattern written into CLAUDE.md.

### LT-271 — Guided sample project — 2026-09-16
**Source:** mission, Phase 8. **Asked:** Guided sample project, with invented data only (D-027).
**Shipped.** "Guided tour" is the first sample on the project screen: the branch office, with invented crawl results on its core and access switches (one uplink up but dropping frames), and a checklist panel over the canvas — pick a device, look at a link, start validation, watch the answers come in (the loopback firewall green, the documentation addresses red), find anything with Ctrl+K, make a report. Each step ticks itself off when it is done, the progress is kept on the project, and "Hide the tour" hides it for good. Only documentation addresses and invented names (D-027). Checked in `guide.test.ts` and `e2e/guide.mjs`, which also found the panel sat under React Flow's pane and could not be clicked — its class name was already the alignment guides', which take no pointer events; renamed.

### LT-270 — Crawl and probe throughput benchmarks — 2026-09-16
**Source:** mission, Phase 8. **Asked:** Crawl and probe throughput benchmarks.
**Shipped.** Two benchmark programs, measured rather than asserted, like LT-190's canvas bench.

`examples/bench_crawl.rs` (coreview-discover): a fake network of real SSH servers on loopback, wired as a binary tree over CDP, each command answering after a set delay, crawled at several concurrencies. `examples/bench_probes.rs` (coreview-probe): the real engine with many TCP checks every second against a loopback listener, reporting results per second and the spread of each check's interval.

**Measured on this machine** (4-core QEMU VM, release builds, 2026-09-16):

| Crawl, 50 ms per command | 1 at once | 4 | 16 | 32 |
| --- | --- | --- | --- | --- |
| 63 switches | 1.4 /s (44.6 s) | 5.2 /s | 12.5 /s | 14.6 /s |
| 255 switches | 1.4 /s (180.9 s) | 5.5 /s | 18.7 /s | 29.5 /s |

A device costs about 0.7 s of fourteen 50 ms commands, so nearly all of a sequential crawl is waiting on the device and the engine's own cost is small; concurrency scales until the tree's width runs out (63 switches are six levels deep, so 32 at once gains little over 16).

| Validation, checks every 1 s, 64 at once | Results / s | Interval p50 / p95 / p99 / max |
| --- | --- | --- |
| 100 TCP checks | 95.5 of 100 | 1001 / 1002 / 1003 / 1003 ms |
| 1,000 | 949.6 of 1,000 | 1001 / 1002 / 1002 / 1003 ms |
| 3,000 | 2,848.5 of 3,000 | 1001 / 1002 / 1003 / 1004 ms |

Results per second are 95% of the schedule because checks start staggered over the first second of a 20 s run; the interval between one check's results stays within 4 ms of a second at 3,000 checks.

### LT-268 — End-to-end: import, crawl, reconcile, validate, export, report — 2026-09-16
**Source:** mission, Phase 8. **Asked:** End-to-end: import, crawl, reconcile, validate, export, report.
**Shipped.** `e2e/endtoend.mjs` — one session through the real app with only the Tauri bridge stubbed: a CSV inventory imported (devices, sites, models, checks created), a crawl started from the seed with a typed login, its result listed, the review showing the new switch and the change to the imported one, applied without duplicating it (serial added, link and ports drawn), validation started on every watched device with the engine's fields only, results reaching the status counts, the diagram exported to draw.io with everything found, and a post-change verification PDF naming what is down with the drawing. All 11 checks pass.

### LT-267 — Property-based tests for every parser — 2026-09-16
**Source:** mission, Phase 8. **Asked:** Property-based tests (proptest) for every vendor parser.
**Shipped.** Property tests with proptest in all three crates. `coreview-discover`: every command parser — CDP, LLDP, routes, spanning tree, VLANs, trunks, port status, counters, MAC and ARP tables, interfaces, ping, seeds, default route, uptime, every FortiOS reader, every stacking reader, walk files — never panics on arbitrary text, on text made of the parsers' own keywords, or on invented real-shaped samples cut short, with lines dropped, doubled, spliced or garbage inserted; plus a VLAN list names only VLANs 1–4094, a neighbour is always named, a ping summary never claims more replies than it sent, a walk counts no more rows than lines. `coreview-probe`: DNS, NetBIOS, mDNS and HTTP-banner readers on arbitrary and damaged bytes (including a DNS reply whose pointer is corrupted), ping, traceroute and neighbour-table output, subnets that read back as themselves, accepted targets that are one word, hex payloads that round-trip. `src-tauri`: the Visio, draw.io, Nmap and Excel readers on arbitrary bytes, damaged files and zips of nonsense. **They found three bugs on the first run: LT-283.**

### LT-266 — Isolation tests and IPC fuzzing — 2026-09-16
**Source:** mission, Phase 7. **Asked:** Isolation tests and IPC fuzzing.
**Shipped.** Isolation tests (`isolationRules.test.ts`): the command table against the backend, what passes and what is refused, a refusal keeping its callbacks, and 2,000 random messages that never make the rules throw. IPC fuzzing (`ipc_contract.rs`, proptest): arbitrary JSON, and every fixture with any one value replaced by arbitrary JSON, against every structured input — an error or a value, never a panic.

### LT-265 — cargo audit and npm audit in CI — 2026-09-16
**Source:** mission, Phase 7. **Asked:** `cargo audit` and `npm audit` in CI.
**Shipped.** The test job runs `npm audit --omit=dev` (fails the build) and `npm audit` (a warning: development-only packages), then `cargo audit`. Run here first: `cargo audit` found rustls 0.23.43 (RUSTSEC-2026-0285), updated to 0.23.45, and `rsa` "Marvin" (RUSTSEC-2023-0071, no fix), ignored in `.cargo/audit.toml` with why it cannot reach Coreview — SSH login is password or keyboard-interactive only, so no RSA private key is ever used. Both now exit 0 here. The development-only advisories are vite 5 and vitest 2, fixed only by major upgrades: LT-281. **CI itself has not run yet**; that is the push.

### LT-264 — Local credential use log — 2026-09-16
**Source:** mission, Phase 7. **Asked:** Local credential usage audit log: which credential, which device, when; never transmitted.
**Shipped.** Every time a saved credential is opened for a job it is noted in a local table — which credential (and its label, kept after it is deleted), what for (crawl, backup, SNMP uptime check, ping from a device, gateway ARP), which device, first and last time and how many times within the hour. A crawl notes each device it reached against the credentials offered to it, bindings matched by the crawl's own rule. "Where they were used" in the vault settings lists it, by credential, with "Clear the log"; nothing is sent anywhere. Unit-tested in `db.rs`; the view in `e2e/security.mjs`.

### LT-262 — OS keychain for the vault, opt-in — 2026-09-16
**Source:** mission, Phase 7. **Asked:** Optional OS keychain storage of the vault passphrase, opt-in.
**Shipped.** "Open by itself on this computer" beside Lock in the vault settings, off by default. On, the vault *key* — not the passphrase, so a passphrase used elsewhere is never written down — is kept in Windows Credential Manager, the macOS Keychain or the Linux Secret Service (`keyring` 3), and the vault opens once at start. A kept key is used only if it opens this vault's verifier; one left from a discarded vault is removed and said. Discarding the vault removes it. Checked with the mock store and **against a real Secret Service** (gnome-keyring on the session bus), and in `e2e/security.mjs`. Linux builds now need `libdbus-1-dev`; the .deb depends on `libdbus-1-3`. **Not run on Windows or macOS** — CI builds them; only those machines can confirm the prompt-free unlock.

### LT-260 — Rate limits on starting network jobs — 2026-09-16
**Source:** mission, Phase 7. **Asked:** Rate limit on `start_validation`, `start_crawl` and their kind.
**Shipped.** A sliding one-minute limit per kind of network job, checked before anything is sent: validation 10, crawl 6, sweep 10, backup 30 (one per group of a queue), test check 120, traceroute 20, ping from a device 30. Past it the command fails with how long to wait, and a refused start is not counted. Unit-tested in `ratelimit.rs`; the message reaching the screen is checked in `e2e/security.mjs`.

### LT-259 — deny_unknown_fields on every IPC input — 2026-09-16
**Source:** mission, Phase 7. **Asked:** `deny_unknown_fields` on every IPC command's input.
**Shipped.** `deny_unknown_fields` on every structured command input — probe configuration, project package and metadata, event row, crawl input with its SNMP, detail and binding parts, credential input, backup input and target, sweep options, saved credential, backup check, and the Visio drawing with its pages, shapes and links. The page builds each from an explicit list of the fields the Rust struct declares (`ipcPayloads.ts`), so a probe's notes and primary flag, or anything else on an object, no longer travel. `src-tauri/fixtures/ipc/*.json` are written from those builders; the frontend test checks they still match, and `ipc_contract.rs` checks each is read — and refused with one field more at any depth, or a field of the wrong type. Checked in the real app (validation started) and in `e2e/security.mjs`.

### LT-258 — Tauri isolation pattern — 2026-09-16
**Source:** mission, Phase 7. **Asked:** Tauri isolation pattern, validating every IPC message before Rust.
**Shipped.** Tauri's isolation pattern is on (`tauri` and `tauri-build` with `isolation`, `app.security.pattern` pointing at `isolation/`). Every message from the page passes `isolation/rules.js` in a sandboxed frame before it is encrypted for Rust: it must name one of Coreview's 78 commands or one of the four plugin calls the page makes (events, open and save dialogs), carry only that command's argument names, and stay within depth, size and field-name limits (no `__proto__`). A refused message is sent on as `ipc_refused`, which fails with the reason, so the call rejects with an explanation. `isolationRules.test.ts` checks the table against every `#[tauri::command]` and the registered list. **Run in the real app** under Xvfb: projects list, a sample saves, validation starts and records samples through the frame; with `get_settings` taken out of the table the app logged "refused a call to get_settings: Coreview has no command called get_settings".

### LT-257 — Report templates — 2026-09-16
**Source:** mission, Phase 6. **Asked:** Report templates: pre-change baseline, post-change verification, monthly health, new-site handover.
**Shipped.** Four templates in the report dialog — pre-change baseline, post-change verification, monthly health, new-site handover — each a choice of sections and a statement of purpose on the cover; every section can still be switched on or off before the report is made. Checked in `e2e/reporting.mjs`.

### LT-256 — PDF report — 2026-09-16
**Source:** mission, Phase 6. **Asked:** PDF report: title page, summary, diagrams, device and port inventory, cable schedule, probe configuration, results, diffs, appendix.
**Shipped.** Export → "Report as PDF…": a cover (template, project, customer, site, change, engineer, purpose, contents), a summary (counts, status, what needs attention, changes for the worse), each page's drawing on a page of its own, device inventory, port inventory, cable schedule, check configuration, results with every state change, changes (the last two validation sessions and the last two crawls, where there are two), and an appendix on how to read it. Laid out as A4 SVG pages — tables break across pages with their header repeated, every page after the cover numbered — and written as one PDF by the LT-251 writer, so text stays text. Checked by `e2e/reporting.mjs` and by rendering an 11-page report with pdf.js, which found LT-279 and LT-280.

### LT-255 — Save as directory: JSON plus a readable YAML sidecar — 2026-09-16
**Source:** mission, Phase 5. **Asked:** Save as directory: JSON plus a human-readable YAML sidecar for version control.
**Shipped.** "Project as a folder" writes `project.coreview` (which Open reads) and `project.yaml` (a readable copy) in a folder named for the project, keys sorted at every level so an unchanged project writes identical files, each written aside and renamed into place, never with saved credentials. Checked in `e2e/importing.mjs`.

### LT-254 — Self-contained interactive HTML export — 2026-09-16
**Source:** mission, Phase 5. **Asked:** Self-contained interactive HTML export, no server.
**Shipped.** "Interactive HTML page": one file with every page's drawing, tabs, drag to pan, wheel and buttons to zoom, a search across devices and addresses on every page, and details on a click. A content-security policy of `default-src 'none'` and no external reference of any kind; the harness opens the exported file and confirms nothing is requested. Checked in `e2e/importing.mjs`.

### LT-253 — Markdown report with embedded diagram images — 2026-09-16
**Source:** mission, Phase 5. **Asked:** Markdown report with embedded diagram images.
**Shipped.** The Markdown report embeds each page asked for as an SVG image in the file itself, so it travels as one file. Viewers that block `data:` images (GitHub among them) show the alt text instead. Checked in `e2e/importing.mjs`.

### LT-252 — CSV exports: ports, VLANs and probe results — 2026-09-16
**Source:** mission, Phase 5. **Asked:** CSV exports: devices, ports, cable schedule, VLANs, probe results, diffs.
**Shipped.** Ports (with error counters), VLANs (with access-port counts) and probe results (status, last RTT, last success and failure, availability over the samples held) join devices, links, the cable schedule and the comparison CSVs (LT-228). Every page. Checked in `e2e/importing.mjs`.

### LT-251 — PNG, SVG and PDF of the current page or all pages — 2026-09-16
**Source:** mission, Phase 5. **Asked:** PNG, SVG and PDF of the current page or all pages.
**Shipped.** A "Pages" choice in the Export menu (this page / all pages) for PNG, SVG, PDF, Visio, draw.io, the HTML page and the report's drawings. PDF of all pages is one document, a page each at its own size (`svgs_to_pdf`, svg2pdf's chunks placed with `pdf-writer`); PNG and SVG write a file per page. Checked in `e2e/importing.mjs`.

### LT-250 — draw.io XML export — 2026-09-16
**Source:** mission, Phase 5. **Asked:** draw.io XML export.
**Shipped.** "Diagram for draw.io" writes an uncompressed `.drawio`, one diagram per page, devices as draw.io's own `mxgraph.networks.*` stencils (names checked against its `networks.xml`), notes, drawing shapes, and links glued at both ends with bends, colour, dashes and ports as `Gi0/1 <> Gi0/2` — the form both readers split back out. Checked in `e2e/importing.mjs`.

### LT-249 — .vsdx export with routing and pages — 2026-09-16
**Source:** mission, Phase 5. **Asked:** `.vsdx` export with routing and pages.
**Shipped.** "Diagram for Visio" writes every page asked for as its own page part, and a link with waypoints as a connector routed through them, written the way Visio saves one (unrotated, local origin on its begin point). A Rust test reads the file back through the Visio importer and gets the same pages, a straight link straight, and the bends where they were drawn. Checked in `e2e/importing.mjs`.

### LT-248 — Nmap XML import — 2026-09-16
**Source:** mission, Phase 5. **Asked:** Nmap XML import.
**Shipped.** "Open Nmap XML…" in Ping sweep reads `nmap -oX` into the sweep's rows (`nmap_import.rs`). Captured with Nmap 7.98 on the lab subnet: the `DOCTYPE` a default XML reader refuses, `hosthint` elements that are not hosts, PTR and user names, closed ports, `srtt` in microseconds. **Not yet seen in a capture:** the MAC address and OS match, which need a privileged scan; read per `nmap.dtd` until one is. Checked in `e2e/importing.mjs`.

### LT-247 — NetBox JSON/YAML import from a file — 2026-09-16
**Source:** mission, Phase 5. **Asked:** NetBox JSON/YAML import from a file, not the API.
**Shipped.** "From a file" reads a NetBox export as JSON or YAML — a list response, a bare array, or `devices`/`cables`/`ip_addresses` together — into devices (role to glyph, site, rack, position, serial, asset tag, tags, primary address or an assigned interface address) and cables (current `a_terminations` and pre-3.3 `termination_a`; breakouts pair in order). **Not verified against a real export:** no NetBox instance was reachable, so it is built from NetBox's serializers on its main branch and says so in its doc comment. Adds the `yaml` package (ISC, no dependencies). Checked in `e2e/importing.mjs`.

### LT-246 — Import of saved SNMP walk files — 2026-09-16
**Source:** mission, Phase 5. **Asked:** Import of saved SNMP walk files.
**Shipped.** "Open SNMP walks…" in Discover devices reads `snmpwalk` text into the record an SNMP crawl builds (`walkfile.rs`, through the crawl's own `device_from_snmp`), so it reaches the table, the review and the diagram the same way. Captured from the lab switch with net-snmp 5.9 in all three forms — MIB names, `-On`, no MIBs — which showed multi-line values, quoted-only-without-a-MIB strings, MACs with dropped zeros, `BITS`, an unrecoverable quoted FDB index (paired by position with `dot1dTpFdbAddress`), and net-snmp's own stderr in the file. Reads identity, ENTITY serials and models, interface addresses, LLDP and CDP neighbours, forwarding table and ARP. Rows under MIB names it does not know are counted and named, with "walk with -On". Checked in `e2e/importing.mjs`.

### LT-245 — CSV and XLSX import with a column-mapping screen — 2026-09-16
**Source:** mission, Phase 5. **Asked:** CSV and XLSX inventory import with a column-mapping screen.
**Shipped.** "From a file" reads CSV or an Excel workbook (`spreadsheet.rs`, checked against workbooks saved by Excel and by LibreOffice: shared strings, formula text, booleans, skipped rows, dates by style, the 1904 system) and shows a mapping screen — sheet, header row (a title line above the table is skipped), devices or links, and a column for every field, guessed from the header and changeable — before anything is added. The old `.xls` is refused with how to fix it. Checked in `e2e/importing.mjs`.

### LT-244 — draw.io import — 2026-09-16
**Source:** mission, Phase 5. **Asked:** draw.io / diagrams.net XML import.
**Shipped.** "From a drawing" (was "From Visio") reads `.drawio` as well, in Rust (`drawio_import.rs`), into the same preview, corrections and placement as a Visio drawing. Built against the draw.io project's own example files (versions 7.7–24.8): compressed and plain pages, HTML labels, shapes inside containers, bends, and — most of their lines — edges with no `source`/`target`, which are joined to the shape their end touches and marked inferred. A line ending on another line (a bus) joins no device and is reported; areas, captions and AWS groups are left out and counted. Checked in `e2e/importing.mjs`.

### LT-243 — Visio import keeps routing, pages and text formatting — 2026-09-16
**Source:** mission, Phase 5. **Asked:** `.vsdx` import that keeps connector routing, pages and text formatting.
**Shipped.** Pages already came through (LT-110); now a connector's route and a label's formatting do too. A 1-D shape's `Geometry` rows are turned onto the page (pin, minus local pin, rotated by `Angle`), and the points between its ends become the link's waypoints on a stepped path; a label's `Character` colour, size, bold and italic and its `Para` alignment become the device's label style. Measured against connectors saved by Visio (the `vsdx` Python project's test drawings): every computed path starts and ends exactly on `BeginX`/`EndX`. They also showed a page shape can inherit its `MoveTo` from the master, so a path is only trusted when it meets both ends — otherwise the link stays straight. Those drawings have no bent connectors, so bends themselves are checked by a constructed page and by the export's round trip (LT-249), not by a Visio-drawn elbow. Checked in `e2e/importing.mjs`.

### LT-242 — High-contrast theme — 2026-09-16
**Source:** mission, Phase 4. **Asked:** High-contrast theme.
**Shipped:** a "High contrast" checkbox in the top bar, remembered per machine and defaulting to the system's `prefers-contrast: more`. It swaps the chrome and canvas tokens for pure black/white with saturated status colours (a light-ground variant too), draws a 3px yellow focus ring on every focusable control, and thickens links and selection outlines. Checked in `e2e/workflow.mjs` (class, tokens, persistence) and by eye against a screenshot.

### LT-241 — Screen-reader labels for devices, links and controls — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Screen-reader labels for devices, links and controls.
**Shipped.** Every device on the canvas carries a spoken name — its type,
name, role, primary address, and whether it is locked or in maintenance (its
live status was already read from the device) — and every link says what it
joins and on which ports (`ariaLabels.ts`, through React Flow's own labels,
cached so a drag does not rebuild them). An audit of every visible control
across the workspace, both inspectors and all ten bottom-panel tabs found eight
without an accessible name — page tab names, shape search, list filter, icon
folder, new view name, address label and address — now named; the audit stays
as a check so a new unnamed control fails.
**Checked:** `ariaLabels.test.ts` (2); `e2e/workflow.mjs` (a device's and a
link's names, and zero unnamed controls in every panel).

### LT-240 — Full keyboard navigation of canvas and panels — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Full keyboard navigation of canvas and panels.
**Shipped.** Devices were already reachable with Tab and selected with Enter
(React Flow), and arrows already nudge. Added: **Alt+arrow** selects the nearest
device in that direction — straight ahead preferred over nearer ones off to the
side, starting from the middle of the view when nothing is selected — pans it
into view if it is off screen, and announces it on the status line
(`spatialNav.ts`); **F6 / Shift+F6** move focus between the toolbar, shape
palette, diagram, inspector and bottom panel (`regions.ts`); the bottom panel's
tabs are a proper tab list — arrow keys, Home and End move and open. The status
line is now a polite live region.
**Checked:** `spatialNav.test.ts` (3), `regions.test.ts`; `e2e/workflow.mjs`
(Alt+Down and Alt+Right select without moving anything, F6 forward and back,
arrow keys along the tabs).

### LT-239 — Threaded comments on devices and links — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Threaded comments on devices and links, stored in the project.
**Shipped.** **Comments** on every device and link: start a thread, reply,
resolve (a reply reopens it), show resolved threads when wanted. Signed with a
name remembered on this machine; kept in the project on the object's data, each
change one undo step (`comments.ts`, `CommentsSection`). A device with open
threads shows a 💬 count on the canvas.
**Checked:** `comments.test.ts` (2); `e2e/workflow.mjs` (comment and reply kept,
badge shown, resolve clears it and keeps the thread, name remembered).

### LT-238 — Freehand annotation layer with a show/hide toggle — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Freehand annotation layer with a show/hide toggle.
**Shipped.** An ink toolbar on the canvas: **Pen** (five colours, four
widths) draws freehand strokes kept on the page in diagram coordinates, so they
stay on what they mark as the view moves; **Eraser** removes a stroke it
touches; **Hide ink / Show ink** keeps strokes but takes them off the canvas and
out of exports. With a tool in hand a clear sheet takes the pointer, so drawing
never drags a device; Escape puts it down. Strokes are thinned as they are kept
(Ramer–Douglas–Peucker at a pixel on screen), drawn smoothed, and drawn over the
diagram in SVG exports while shown; a stroke from a file can carry only a hex
colour and a sane width (`ink.ts`, `InkLayer.tsx`). Each stroke and each erase
is one undo step.
**Checked:** `ink.test.ts` (4), `diagram.test.ts` (ink in the export, over the
devices); `e2e/workflow.mjs` (draw, kept and drawn, hide, erase, Escape).

### LT-237 — Sticky notes in Markdown — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Sticky notes in Markdown.
**Shipped.** Notes already rendered a small Markdown subset (LT-096). The
reading now lives in one module the note and the SVG export share
(`noteMarkdown.ts`) and understands more: three heading levels, numbered steps,
quotes, rules and `*`/`_` bullets alongside checkboxes and bullets, and italics
and strikethrough alongside bold, code and links — italic marks inside a word
stay text. A **Sticky note** style (yellow on either ground) is in the palette,
the canvas menu and the note's Style.
**Checked:** `noteMarkdown.test.ts` (3), the existing note and export tests;
`e2e/workflow.mjs` (each element drawn, a sticky note added).

### LT-236 — Bulk edit for a multi-selection — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Bulk edit for a multi-selection.
**Shipped.** The bulk editor for a device selection already set type,
lock, maintenance, details, colours, tags, views and (LT-222) checks. Added:
**Role**, **Site**, **Rack / room** and **Vendor** for the whole selection —
showing the shared value or "Mixed", setting every device only when changed —
and a new editor for **several selected links**: cable type, path, line style
and width, each one undo step for all of them.
**Checked:** `bulkEdit.test.ts` (shared text fields, a blank counting as its own
value); `e2e/workflow.mjs` (mixed role shown, a site set on three devices in one
undo step and not on the fourth, cable and line style set on three links).

### LT-235 — Port view: partner, speed, duplex, VLAN and errors — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Port view: link partner, speed, duplex, VLAN, errors.
**Shipped.** A link's inspector has **Ports**: for each end, what it is
plugged into, the port's status, speed and duplex, its VLAN or trunk with
native and allowed VLANs, and its error counters — input (with CRC), output,
collisions, drops and resets — highlighted when there are errors, or a note that
no crawl has read that port. The counters are new: a crawl reads `show
interfaces` with the ports (`counters.rs`), and the device's port table gains an
**Errors** column.
**Written against captured output** from the lab switch's `show interfaces`
(physical ports, an SVI, up and down); the non-zero error test uses the
captured line layout.
**Checked:** `counters.rs` (2), `inventory.test.ts` (errors land on the right
port), `e2e/workflow.mjs` (both ends, errors highlighted, the unread end).

### LT-234 — Device inspector: neighbours and attachments beside interfaces, addresses, VLANs, routes and history — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Device inspector: interfaces, IPs, VLANs, neighbours, routes, probe history, notes, tags, attachments by local path.
**Shipped.** Most of the device inspector already existed — addresses,
tags, notes, the crawl's ports, VLANs, routes and spanning tree (LT-200–204) and
each probe's history (LT-224). Added: **Neighbours**, every link to the device on
any page with the port at each end and the link's live status, a click going to
the link; and **Attachments**, files kept by path (added by typing or **Choose…**),
opened through a new `open_attachment` command that opens only existing documents
and pictures — never anything runnable, since a path can arrive in an imported
project — or shows the file in its folder.
**Checked:** `commands.rs` (a picture opens; a script, a relative path, a missing
file and a folder are refused); `e2e/workflow.mjs` (neighbours in port order, a
path attached and named, Show in folder through the app).

### LT-233 — Focus mode — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Focus mode: dim all but the selection and its N-hop neighbourhood.
**Shipped.** **Focus on this — 1 link out / 2 links out** in a device's menu
(or on the selection it is part of) dims everything but those devices and their
neighbours that many links out; leader lines do not count as links. It combines
with the filter; the chip names the focus, and **Leave focus** or Escape ends it.
**Checked:** `canvasFilter.test.ts` (neighbourhoods, combining with a filter);
`e2e/workflow.mjs` (focus from the menu, the chip, Escape).

### LT-232 — Canvas filter — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Canvas filter by type, vendor, role, VLAN, subnet, probe status, crawl status, tag or note text.
**Shipped.** **Filter** in the top bar dims every device that does not
match — by type, vendor, role, tag (offered from what the page has), status,
how discovery met it, VLAN (number or name, including a crawled device's VLAN
table), subnet, or text in names and notes — and the links to them. Nothing is
hidden or moved; a chip on the canvas says how many are lit and clears it.
Sections stay lit as the background (`canvasFilter.ts`).
**Checked:** `canvasFilter.test.ts` (every criterion, combinations, subnet
maths); `e2e/workflow.mjs` (role and subnet filters dim the right devices and
links, the chip, clearing).

### LT-231 — Global search over devices, ports, addresses, MACs, hostnames, VLANs and subnets — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Global search over devices, ports, IPs, MACs, hostnames, VLANs and subnets.
**Shipped.** One index over every page (`search.ts`): devices, their
addresses, MACs, hostnames and DNS names, ports (from crawled inventories and
link port labels), VLANs, connected subnets, probes, notes and shapes. Matching
is fuzzy — exact, then prefix, then fragment, then punctuation-blind (so
`5e0053` finds a MAC), then every character in order with word starts counting
most and spaces as gaps (`br rtr` finds `BRANCH-RTR`). It is what the palette
searches; Ctrl+F's find box on the page is unchanged.
**Checked:** `search.test.ts` (3: what is indexed, how each kind is found, the
ranking order); `e2e/workflow.mjs`.

### LT-230 — Command palette — 2026-09-16
**Source:** mission, Phase 4. **Asked:** Ctrl/Cmd+K command palette with fuzzy search over nodes, ports, probes, notes, stencils and commands.
**Shipped.** **Ctrl/Cmd+K** opens a command palette. Typing searches the
whole project (LT-231); choosing a result switches to its page, selects it and
brings it into view, or adds a shape to the middle of the view. With `>` it
lists commands — fit, zoom to selection, find, present, undo, redo, save, grid
snap, add a page, arrange top to bottom, start and stop validation, keyboard
shortcuts, and opening the Ping sweep, Discover devices, Racks, Path check,
Compare and Event timeline tabs. Arrow keys, Enter and Escape; a combobox with an
active descendant for screen readers (`CommandPalette.tsx`).
**Checked:** `e2e/workflow.mjs` (opens, finds, goes to another page and selects,
Escape, a command opens a tab, a shape is added).

### LT-228 — Diffs exported as Markdown and CSV — 2026-09-16
**Source:** mission, Phase 3. **Asked:** Diffs exported as Markdown and CSV.
**Shipped.** Either comparison saves as **Markdown** (a titled table naming
both runs) or **CSV** (formula-guarded cells), through the usual export folder
or dialog.
**Checked:** `runDiff.test.ts` (both formats, escaping), `e2e/validation.mjs`
(the Markdown of a session comparison and the CSV of a crawl comparison).

### LT-227 — Diff two crawls — 2026-09-16
**Source:** mission, Phase 3. **Asked:** Diff two crawls: firmware, interface state, neighbours, routes.
**Shipped.** Every crawl's result is now kept (`crawl_runs`, the last 50
per project, removed with the project), and **Compare → Crawls** lists what
changed between two: devices that appeared or went, firmware, ports that came up
or went down, neighbours gained or lost on a port, routes added or withdrawn.
**Checked:** `db.rs` (runs kept, capped, oldest dropped), `runDiff.test.ts`
(every kind of change from one pair of crawls), `e2e/crawling.mjs` (a result is
saved with its seed), `e2e/validation.mjs` (a firmware change shown).

### LT-226 — Diff two validation sessions — 2026-09-16
**Source:** mission, Phase 3. **Asked:** Diff two validation sessions: devices, status transitions, latency regressions.
**Shipped.** **Compare → Validation sessions**: pick two sessions and see,
per check, availability that moved by a point or more, a slower or faster
average (a quarter *and* 5 ms), a slower 95th percentile (half *and* 10 ms), and
checks only in one session — worst first, with a ▼/▲ as well as colour. Summaries
come from the stored results (`session_summary`: per probe counts by status,
average and p95 response time; `list_sessions` with results and changes per
session).
**Checked:** `db.rs` (summary counts, average, p95), `runDiff.test.ts` (what
counts as a change, order), `e2e/validation.mjs`.

### LT-225 — Path validation: is A reachable from B on a protocol and port — 2026-09-16
**Source:** mission, Phase 3. **Asked:** Path validation: is A reachable from B on a given protocol and port.
**Shipped.** A **Path check** tab. Choose where from — this machine, or a
device on the diagram — and a device to reach. From this machine it tests ICMP,
or a TCP or UDP port, with the probe engine. From a device it logs in over SSH
with a saved credential and runs the device's own ping (`ping_from_device`; the
target is parsed as an IPv4 address before it goes near a command line). Beside
the test it shows the fewest-links path the diagram draws between the two, each
hop with its live status, naming the first device or link that is down and how
many hops nothing checks (`pathCheck.ts`).
**Written against captured output:** IOS ping from the lab switch — full reply,
total loss, and an unresolvable name (`pathcheck.rs`).
**Checked:** `pathcheck.rs` (2), `pathCheck.test.ts` (3), `e2e/validation.mjs`
(port test from this machine; drawn hops with the down link named; the device's
ping asked for by address and credential id, and its result).

### LT-224 — Probe result history with RTT and status sparklines — 2026-09-16
**Source:** mission, Phase 3. **Asked:** Probe result history with RTT and status sparklines (D-029).
**Shipped.** Every probe result is now kept: the `probe_samples` table
existed but nothing wrote to it. The engine's result stream is written as it
arrives, capped at 50,000 results a probe (about three days at five seconds),
indexed by probe and time, and read back by `probe_history`. Each probe in the
inspector shows **History**: response time as a sparkline with a soft fill and
the latest point marked, status as a strip of bars whose height carries the
state (sliver healthy, half warning, full down — readable without colour), and
availability and the response-time range, for the live window (last 120
results) or a stored hour, day or three days (`sparkline.ts`, `ProbeHistory`).
**Checked:** `sparkline.test.ts` (4); `db.rs` (samples round trip in a window,
oldest first, and the prune statement); `e2e/validation.mjs` (live results
drawn with availability and range; a stored window asked for by probe and time
and drawn the same way).

### LT-222 — Probe templates — 2026-09-16
**Source:** mission, Phase 3. **Asked:** Probe templates, saved and reused across devices.
**Shipped.** **Save as template** on any probe keeps its settings without
its target or device (`probeTemplates.ts`, kept with the project; an SNMP
template names its credential by id). **From a template…** adds one to a device,
aimed at its primary address; with several devices selected, **Add a check from
a template** adds it to each as one undo step and names any skipped for having no
address. Saving under a used name replaces that template.
**Checked:** `probeTemplates.test.ts` (3); `e2e/validation.mjs` (save without
target, add to another device, add to a selection with one skipped, one undo).

### LT-220 — SNMP sysUpTime probe — 2026-09-16
**Source:** mission, Phase 3. **Asked:** SNMP sysUpTime probe.
**Shipped.** An **SNMP uptime** probe: reads `sysUpTime` with a saved SNMP
credential chosen by vault id, reports "Up 58d 2h", and when uptime goes
backwards reports **Restarted** — a warning, since the device answered, that
clears on the next check. The probe crate holds no SNMP code or secret; the app
registers a reader at start-up that opens the vault in Rust when the check runs
(`snmpcheck.rs`, `register_snmp_uptime`).
**Checked:** `snmpcheck.rs` (a restart and nothing else is noticed), `state.rs`
(restart is a warning, then clears); the uptime read was verified live over
SNMPv3 against the lab switch; `e2e/validation.mjs` (only the credential id goes
to Test now, and a restart reads as reachable).

### LT-219 — DNS query probe — 2026-09-16
**Source:** mission, Phase 3. **Asked:** DNS query probe.
**Shipped.** A DNS probe can **Ask this server** for A, AAAA, CNAME, MX,
NS, PTR, SOA, SRV or TXT records, bypassing this machine's resolver: a plain
RFC 1035 query over UDP built and parsed in `dnsquery.rs`. Healthy on NOERROR
with an answer; NXDOMAIN, SERVFAIL and REFUSED are named; **Expected address**
still applies, to the answers from that server.
**Checked:** `dnsquery.rs` (5: query bytes, A/AAAA/CNAME answers with name
compression, malformed replies rejected, a fake server round trip, bad input
fails closed); live against the local resolver (A and AAAA answers, NXDOMAIN)
and the lab gateway (NXDOMAIN); `e2e/validation.mjs`.

### LT-217 — UDP probe — 2026-09-16
**Source:** mission, Phase 3. **Asked:** UDP probe.
**Shipped.** A **UDP service reply** probe (`udp.rs`): it sends a DNS
query, an NTP client request, an empty datagram or hex bytes to a port, and is
healthy on any reply. A host that says the port is closed (ICMP port unreachable)
is **refused**; silence is **no answer**, and the message says UDP cannot tell
an ignoring service from a firewall.
**Checked:** `udp.rs` (3, real sockets on loopback: an echo reply, a closed port,
a silent one); `e2e/validation.mjs` (the editor's Send choice and hex bytes are
kept on the probe).

### LT-216 — Reconcile review: accept or reject each added, changed, removed or moved item — 2026-09-16
**Source:** mission, Phase 2. **Asked:** Reconcile review panel: added, changed, removed and moved, each accepted or rejected; nothing deleted or moved without confirmation.
**Shipped.** **Add … to diagram** no longer writes anything. It lists the
crawl's changes for review, grouped: **New** devices (each with the links that
reach it) and links, **Changed** devices with only the fields that differ
("Model: C9300-24T → C9300-48P", ports and routes read again) — both ticked —
and **Moved** hosts (seen on a different switch port: re-cable and remove the
old link) and **Not found this time** (a device a crawl drew, inside this run's
subnets, that nothing reported; a discovered link between two devices logged
into that neither reported) — both *unticked*. With no subnet limit nothing is
offered for removal. **Apply** writes only what is ticked, as one undo step;
checks on removed devices go with them (`reconcile.ts`, `applyCrawlChanges`).
New crawled devices now keep their network name in **Hostname**, so finding them
again is not reported as a change.
**Checked:** `reconcile.test.ts` (5: additions ticked; only real differences;
removal unticked, in scope only, and nothing removed unless accepted; a link
neither end reports; a moved host re-cabled only when accepted);
`e2e/crawling.mjs` (nothing drawn before Apply, groups and ticks, one undo step);
`e2e/join.mjs` still joins sweep and crawl through the review.

### LT-215 — One multi-layer model: physical and logical links on the same devices — 2026-09-16
**Source:** mission, Phase 2. **Asked:** One multi-layer model merging the physical and logical graphs.
**Shipped.** One model, two layers of links. When the page has Physical
and Logical views (every new project does, LT-184), a crawl puts cables (CDP,
LLDP, MAC tables) on Physical and draws each layer-3 hop — a route on one
crawled device whose next hop is another crawled device's address — as a dashed
**L3** link on Logical, with the routes it carries in its notes and an arrow
each way where both route via the other. The devices are the same nodes, so a
view can be shown, hidden, locked or left out of printing on its own. A hop found
again is not drawn twice; a page with no Logical view gets no L3 links.
**Checked:** `topology.test.ts` (views assigned, one L3 link each way, not
redrawn, absent without the view); `e2e/crawling.mjs` (an L3 link on the Logical
view, landing on a device already drawn under another name).

### LT-214 — Role inference from platform, spanning tree and neighbour patterns — 2026-09-16
**Source:** mission, Phase 2. **Asked:** Role inference (core, distribution, access, edge, firewall, load balancer) from sysDescr, CDP platform and neighbour patterns, extending LT-145.
**Shipped.** A crawl now decides each device's role from evidence
(`roles.ts`): firewall and load balancer from unambiguous product lines or the
crawl's own class; wireless from class; edge for a router (noting when its
default route leaves the crawled network); and for switches — access when four
or more hosts are plugged straight in or access ports outnumber trunks, core
when it is spanning-tree root for most instances or learns routes from a
routing protocol and links two or more infrastructure devices, distribution
when it links three or more — then a second pass places quiet switches between
a core and access switches. Model names are never used to tell core from
access. A new node draws with the role's glyph, so **Arrange top to bottom**
(LT-145) puts it on the right row; the **Role** field says why ("A crawl decided
this: …"). A role someone typed is never overwritten, and typing one clears the
crawl's reasons.
**Checked:** `roles.test.ts` (3); `topology.test.ts` (glyph, role and reasons on
a new node; a hand-written role survives a re-crawl).

### LT-213 — Flag one-way and missing links, loops, orphans, duplicate MACs and blocked links — 2026-09-16
**Source:** mission, Phase 2. **Asked:** Flag unidirectional links, missing links, loops, orphans, duplicate MACs and STP-blocked links.
**Shipped.** A crawl's result lists **Findings**, worst first, each naming
its devices and ports (`crawlFindings.ts`): loops no spanning-tree port breaks
(cycles found as non-bridge links, LAG members counted as their bundle, two
unbundled cables between a pair counted as a loop); duplicate MACs (one MAC the
only device on two ports); one-way links (A reports B, B logged into and does
not report A; not claimed when either was only reached over SNMP); links on the
diagram neither end reported; links spanning tree blocks; up trunks with no
neighbour on them; and reached devices linked to nothing.
**Checked:** `crawlFindings.test.ts` (7: a tidy tree has none, one-way, the SNMP
exception, an open and a broken triangle, bundled and unbundled pairs, drawn
link/unidentified trunk/orphan, duplicate MAC vs a MAC behind an uplink);
`e2e/crawling.mjs` reads the list from a result.

### LT-212 — Crawl profiles — 2026-09-16
**Source:** mission, Phase 2. **Asked:** Crawl profiles: saved seeds, credentials and protocol toggles (LT-135 remembers a scan; this names and reuses several).
**Shipped.** **Profile** at the top of the crawl panel: name the current
settings and **Save profile**, choose one to put its settings back, **Delete
profile**. A profile holds the seeds, subnet limit, hops, probe address, port,
transport, the saved SSH credential and SNMP rows by id or shape, the tables to
read, reverse DNS, at once, give-up time, retries and the push-factor setting.
Kept with the project. Never a password: a profile is rebuilt field by field when
saved and when read (`readProfile`), so a stray secret cannot survive either.
Saving under a name already used replaces that profile.
**Checked:** `crawlProfiles.test.ts` (4, including a stored password and SNMP
passphrases that do not survive reading); `e2e/crawling.mjs` — save, change,
load back, replace by name, delete, and the typed password nowhere in the
project.

### LT-211 — Crawl dry run — 2026-09-16
**Source:** mission, Phase 2. **Asked:** Dry run: what would be crawled, with no packet sent.
**Shipped.** **Dry run** beside **Discover** works out the run's plan in the
app and sends nothing — no ping, DNS lookup, port check or login: each seed and
what would happen to it (dialled with which saved credentials, in the order the
crawl uses; a range's size inside the subnet limit; a hostname that would be
looked up; a seed that is not valid and why), the limits (hops, devices, subnet
limit or its absence, at once, give-up time, retries, transport and port), the
commands each device would be asked given the chosen tables, and whether SNMP
would be tried. What only the network can tell — resolved names, listening
addresses, neighbours — it says it cannot know (`dryRun.ts`).
**Checked:** `dryRun.test.ts` (4); `e2e/crawling.mjs` — the plan appears, no
backend call but the credential list is made, and the seed lines read right.

### LT-210 — Live per-host crawl table — 2026-09-16
**Source:** mission, Phase 2. **Asked:** Live per-host crawl table: queued, probing, authenticated, collected, failed with reason.
**Shipped.** **Devices this run** in the crawl panel: a row per address —
queued, probing, authenticating, waiting for approval (with the push message),
collecting (with the command being read), retrying, collected (or reported by a
neighbour, or over SNMP), failed with the reason, or skipped with why — and a
count per state. Built from the event stream by a pure reducer
(`crawlTable.ts`); a finished row is never made busy again by a late progress
line. The crawl now also announces what it has queued.
**Checked:** `crawlTable.test.ts` (3); `e2e/crawling.mjs` drives a stream of
events and reads the rows.

### LT-284 — **bug** On Windows a closed UDP port read as an OS error, not "nothing listening" — 2026-09-17
**Source:** CI for 6a9edd2 — the Windows runner failed the probe crate's tests
while Linux passed. **Bug:** the UDP check (LT-217) and the direct DNS query
(LT-219) treated only `ConnectionRefused` as the host's port-unreachable
answer. Windows reports that same ICMP message on a connected UDP socket as
`ConnectionReset` (WSAECONNRESET), so on Windows a closed port was "OS error"
instead of "refused", and `a_closed_port_is_refused_and_a_silent_one_says_so`
fails there.
**Reproduced:** by the Windows CI run; the job log is not readable without
GitHub credentials, so the failing test is inferred from the platform behaviour
and is confirmed only when the next run passes.
**Fixed:** `udp::closed_port` accepts both, used by both readers, with a test
of the rule itself that runs on every platform.

### LT-283 — **bug** A cut-short EtherChannel row panicked; VLAN 0 and impossible ping summaries were read — 2026-09-16
**Source:** found by LT-267's property tests on their first run. **Bugs:**
(1) a `show etherchannel summary` bundle row cut to two fields — what a slow read
or a swallowed paging prompt leaves — panicked slicing its member list, ending
that device's visit mid-crawl; (2) a VLAN range starting at 0 (`0-3`) named VLAN
0, which cannot exist; (3) a ping summary claiming more replies than requests
(`(1/0)`) was accepted as a result.
**Reproduced:** `a_bundle_row_cut_short_is_read_not_a_panic`,
`a_range_from_zero_names_no_vlan_zero` and
`more_replies_than_pings_is_not_a_summary` failed before the fixes (the first
with the panic at `etherchannel.rs:58`).
**Fixed:** members are read with `skip(3)`, a range starts at VLAN 1 at the
least, and an impossible summary is no summary. All three tests and every
property pass.

### LT-282 — **bug** Lab identifiers left in FortiOS and neighbour-table fixtures — 2026-09-16
**Source:** found writing LT-267's parser properties, by comparing every MAC,
serial and name in this session's lab captures against the tree. **Bug:** D-027
and LT-277 say no lab or customer identifier reaches the repository, but test
fixtures written from lab captures still carried them: a FortiGate DHCP lease
table (two SSID names, two interface names, client hostnames, five client MACs,
a lab address range), FortiAP serials and board MACs, the FortiSwitch's burned-in
MAC, an office AP's name, a VLAN name, and two lab MACs — an AP and a NAS — in the
neighbour-table and sweep tests and `e2e/discover.mjs`. Two had also reached a
doc comment written this session.
**Reproduced:** `git grep` for the captured values found them in
`fortios.rs`, `neighbour.rs`, `sweep.rs`, `e2e/discover.mjs` and `walkfile.rs`.
**Fixed:** every one replaced with an invented value of the same length (the
lease and AP tables are column-aligned), MACs keeping only their vendor prefix
as LT-277 did; the tests that asserted them updated to match, and the whole
tree searched again for every captured MAC in every spelling (colon, dash, dot,
dropped zeros, spaced hex) and for the raw bytes in binary fixtures — nothing
remains. LT-277's scrub had also missed the lab gateway's address written as an
escaped regular expression in `e2e/discover.mjs`, which left that harness
failing; it now matches the renumbered address and passes. **Still in git history** since commit 60d7cb9 and later: removing them
from published history is destructive and the operator's decision (Q-014).

### LT-280 — **bug** A narrow drawing's subtitle ran under the status legend — 2026-09-16
**Source:** found checking LT-256's report by rendering its PDF. **Bug:** the
title block puts a 520px status legend against the right edge and the
customer · site · change · engineer line against the left, with no limit on
either. A drawing shrink-wrapped to its devices is 560px wide at the least, so
on any small diagram — SVG, PNG, PDF or a report page — the subtitle and the
legend were drawn over each other.
**Reproduced:** `diagram.test.ts` "keeps the subtitle clear of the status legend"
failed: the subtitle ran to 579px against a legend starting at 34px.
**Fixed:** a drawing with a title block is at least 900px wide, and the subtitle
is cut to the room left beside the legend, so a sheet narrower than that still
cannot collide. The test passes.

### LT-279 — **bug** Addresses and port labels were missing from every PDF — 2026-09-16
**Source:** found checking LT-256's report by rendering its PDF. **Bug:** the
diagram sets the address under a device's name, and every port label, in a
`monospace` stack. The PDF converter bound only `sans-serif` to a font the
machine has; `monospace` stayed on its default, Courier New, and text whose
family cannot be found is left out rather than substituted. On a machine
without Courier New — this Linux one, and any stock Linux — the diagram PDF
(LT-077) came out with names but no addresses and empty port-label pills.
**Reproduced:** `pdf.rs` `monospace_text_reaches_the_page_too` failed with "text
in \"ui-monospace, SFMono-Regular, Menlo, monospace\" vanished".
**Fixed:** every generic family is bound — `monospace` to an installed monospace
face (Cascadia Mono, Consolas, SF Mono, Menlo, DejaVu Sans Mono, Liberation Mono,
Noto Sans Mono, Courier New), the rest to the sans — and the test passes. Checked
by rendering a report PDF with pdf.js: addresses and port labels are on the page.

### LT-278 — A crawl's failures and push-factor prompts never reached the panel — 2026-09-16
**Source:** found building LT-210. **Bug:** the crawl's event enum is tagged by a
`kind` field, and two of its payloads — a failure (LT-144's kind) and SSH progress
— carry a `kind` of their own. Both were written into one JSON object, and the
browser keeps the last, so a failure arrived as `auth-rejected` and a pending Duo
push as `awaitingSecondFactor`, never as `failed` or `ssh`. The panel's live
failure count stayed at zero and "approve the push on your phone" was never
shown — waiting for a push looked exactly like a hang, the thing that message
exists to prevent.
**Reproduced:** `crawl.rs` `every_event_arrives_under_its_own_kind` failed with
`{"kind":"failed",…,"kind":"auth-rejected"}`.
**Fixed:** the two payloads are nested (`failure`, `progress`), the panel reads
them there; the Rust test passes and `e2e/crawling.mjs` sees the push message and
the failure on the status line. The backup stream was already safe (adjacently
tagged).

### LT-208 — Crawl concurrency, per-host timeouts, retries and cancellation — 2026-09-16
**Source:** mission, Phase 2. **Asked:** Crawl concurrency limits, per-host timeouts, retry policy and cancellation on the probe engine's infrastructure.
**Shipped.** The crawl really runs devices side by side now: the
`concurrency` option existed but the loop visited one device at a time, and the
app passed 1 anyway. Visits run in a task set up to **At once** (1–32, default
4); the queue and visited sets are only touched between visits, and results are
listed in the order devices were started, so a run reads the same each time.
Each device has **Give up after** (default 5 min, login and all commands) and
**Retries** (default 1, 2 s then 4 s apart) for a device that did not answer at
all — a refused port or a rejected login is never retried. **Stop** aborts the
visits in progress at once. A push factor still logs in one at a time. New
`Visiting` and `Retrying` events feed LT-210.
**Checked:** fake-network tests — a silent device dialled 3 times with 2 retries,
given up on inside the limit, four devices at once taking under half the time of
one at a time, and a cancel returning within a second; all 17 existing crawl
tests still pass; `e2e/crawling.mjs` sends the settings; a live crawl of the lab
/24 reached the switch and reported the three devices that refuse its login.

### LT-207 — Seeds from CIDR ranges, hostnames or a CSV — 2026-09-16
**Source:** mission, Phase 2. **Asked:** Seeds from CIDR ranges, hostnames or a CSV of addresses.
**Shipped.** **Seed devices** takes a list — addresses, hostnames and CIDR
ranges up to a /20, separated by commas, spaces or new lines — and **From CSV…**
adds the address (or hostname) column of a spreadsheet, or every address-shaped
cell when there is no such heading. In Rust a hostname is resolved to its IPv4
address, a range is narrowed to the addresses that accept a TCP connection on
the login port (64 at a time, 0.8 s each), everything outside the crawl's subnet
limit is left out, and every seed that could not be used is reported with why.
All seeds share one visited set, so two seeds in one network crawl it once
(`seeds.rs`, `crawl_from`).
**Checked:** `seeds.rs` (3, including a real listener on loopback), a fake-network
crawl from two seeds, `seeds.test.ts` (4), `e2e/crawling.mjs` (CSV joins the
typed seeds and the list reaches the backend).

### LT-206 — DNS PTR enrichment of hostnames — 2026-09-16
**Source:** mission, Phase 2. **Asked:** DNS PTR enrichment of hostnames.
**Shipped.** After a crawl, each reached device's address and every
attached device with an address and no name gets a PTR lookup (the sweep's own
`reverse_name`, 1.5 s, sixteen at a time, each address once). A reached device
keeps it as **DNS name** in the inspector; an attached device with no name takes
it as its label. A name a device gave about itself is never replaced. On by
default, **Names from reverse DNS** in the crawl panel turns it off.
**Checked:** `ptr.rs` (3: fills gaps only, one lookup per address, a chunk runs
concurrently); `e2e/crawling.mjs` (the toggle is sent, the name reaches the
inspector). The resolver call itself is LT-109's, already measured.

### LT-199 — SNMP (and SSH) credentials bound per device from the vault — 2026-09-16
**Source:** mission, Phase 2. **Asked:** SNMP credentials bound per device from the vault.
**Shipped.** A device's inspector has **Log in with** and **SNMP with**: saved
vault credentials (ids only) a crawl tries on that device first, matched by each
of its addresses and its hostname. Resolution and ordering are LT-209's.
**Checked:** with LT-209; `e2e/crawling.mjs` picks an SNMP credential for a
drawn device and sees it sent as a device binding.

### LT-209 — Credential binding per subnet, vendor or device, resolved in Rust — 2026-09-16
**Source:** mission, Phase 2. **Asked:** Credential binding per subnet, per vendor or per device, resolved in Rust; no secret crosses IPC.
**Shipped.** Saved credentials can be bound to a subnet or a vendor/platform
word (**Saved credentials by subnet or vendor** in the crawl panel, kept with the
project) and, with LT-199, to one device. Before a device is dialled, Rust tries
the bindings that match it — device, then the narrowest subnet, then vendor
(matched on what a neighbour reported) — then the run's own logins, never the
same login twice; SNMP identification does the same (`bindings.rs`). The
interface sends scope, value and vault id only; `start_crawl` opens the vault
(`resolve_bindings`) and refuses the run if a bound credential cannot be opened.
**Checked:** `bindings.rs` (6), a fake-network crawl where only a subnet-bound
login gets in and is not tried outside its subnet, `credentialBindings.test.ts`
(3), and `e2e/crawling.mjs` (rules validated, kept with the project, sent as ids
with no secret).

### LT-200 — Routing table collection, IPv4 and IPv6 — 2026-09-16
**Source:** mission, Phase 2. **Asked:** Routing table collection, IPv4 and IPv6, for L3 inference.
**Shipped.** `show ip route` and `show ipv6 route`: prefix, code and protocol,
next hops (equal-cost paths on continuation lines included), interface, distance
and metric. Kept on the device and shown in the inspector; the layer-3 hops it
implies between devices are drawn by LT-215.
**Written against captured output** — static, connected and local IPv4 routes and
IPv6's two-line form, verified live (4 routes). The lab runs no dynamic routing,
so the OSPF line test is written in the captured shape and says so.
Each table can be turned off per run (**Also read from each device**).
**Checked:** `routes.rs` (5 tests); `e2e/crawling.mjs` (the toggle reaches the
backend and the table reaches the inspector).

### LT-202 — STP topology: root bridge and blocked ports — 2026-09-16
**Source:** mission, Phase 2. **Asked:** STP topology: root bridge and blocked ports.
**Shipped.** `show spanning-tree` per instance: protocol, root bridge and
priority, whether this switch is root, its root port, and every port's role and
state; blocked, alternate and backup ports picked out. The inspector shows root
per instance and the ports not forwarding; LT-213 flags the links they block.
**Written against captured output** (rapid-PVST, 32 instances, verified live).
Nothing is blocked in the lab, so the blocked-port test uses the captured row
layout with `Altn BLK`, and says so.
**Checked:** `stp.rs` (3 tests); `e2e/crawling.mjs`.

### LT-203 — VLAN membership and trunk/access classification — 2026-09-16
**Source:** mission, Phase 2. **Asked:** VLAN membership and trunk/access classification.
**Shipped.** VLANs (`show vlan brief`), trunks with native and allowed-active
VLANs (`show interfaces trunk`) and each port's access VLAN, joined into a mode
per port: trunk, access or routed. Shown in the inspector's port table, trunk
VLANs compressed (`1,10-12`).
**Written against captured output** from the lab switch, verified live (36 VLANs,
three trunks). VLAN names in fixtures are invented.
**Checked:** `vlans.rs` (5 tests); `inventory.test.ts`; `e2e/crawling.mjs`.

### LT-204 — Inventory: uptime, interfaces and speeds — 2026-09-16
**Source:** mission, Phase 2. **Asked:** Inventory completeness: uptime, interface list and speeds alongside the model, serial and firmware already read.
**Shipped.** Each device a crawl logs into now carries its uptime (from the
`show version` it already read) and every port with status, speed, duplex and
description (`show interfaces status`), shown under **From the last crawl** in the
inspector. Model, serial and firmware were already read.
**Written against captured output** from the lab WS-C2960CX (IOS 15.2(7)E),
2026-09-16; verified by a live crawl of it (12 ports, uptime read).
**Checked:** `uptime.rs` and `vlans.rs` tests; `inventory.test.ts`;
`e2e/crawling.mjs`. FortiOS is not asked yet: no capture of its equivalents.

### LT-277 — The lab's own subnet and two MACs out of fixtures and docs — 2026-09-16
**Source:** left over from LT-274; the operator said to carry on, 2026-09-16.
**Shipped.** Every address in the lab's own subnet in parsers' captured examples, tests, e2e
fixtures and docs is now `192.168.77.x` (same length, so column-aligned captures
still line up), including the reverse-lookup labels inside three binary DNS
fixtures, and the gateway's and one host's MACs keep their vendor OUI with
invented device bytes. **Checked:** cargo tests (probe 138, discover 362, app 137)
and vitest (878) pass; the address-shaped tests were updated with the fixtures,
not loosened. New captures from the lab get the same treatment before they are
committed.

### LT-190 — Canvas benchmark at 1k, 5k and 10k nodes — 2026-09-16
**Source:** mission 8, pulled forward because LT-188 cannot be decided without
it. **Acceptance:** a repeatable harness producing idle, pan, zoom and drag
numbers at each size, with invented diagrams, runnable on this machine.
**Progress, 2026-09-16.** `e2e/bench-canvas.mjs` exists: invented grid diagrams,
open time, then idle, pan, zoom and drag measured separately as frame intervals,
with a per-scenario time budget so a slow build reports how far it got. Run it
against a **production** build — the dev server's React checks dominated the
first profile and would mislead: `npx vite build --outDir <dir>`, then
`npx vite preview --outDir <dir> --port 4174`, then
`CV_URL=http://localhost:4174/ SIZES=1000,5000,10000 node e2e/bench-canvas.mjs`.
Single runs are noisy (pan varied 42–84 ms between identical builds), so a
decision takes repeated runs. 5,000 has been run (see LT-188). A single frame
can outlast the per-scenario budget — culling's zoom froze for 209 s — so a
scenario's wall time can exceed `BUDGET_MS`. **Still to do:** a 10,000 run.
**Done.** The last run, 10,000 devices, was LT-275; all three sizes are now in
LT-189's table from production builds, and the harness runs to the end at each.

### LT-198 — Cable schedule from link data — 2026-09-16
**Source:** mission 1.4. **Acceptance:** a schedule of port A, port B, cable
type (LT-167), length and label, exported as CSV and included in reports.
**Shipped.** A link's inspector takes a **Cable length** (free text, `3 m`,
`10 ft`). **Export → Cable schedule as CSV** lists every link between devices on
every page — page, device and port at each end, cable type (LT-167), length and
label — in natural port order, with formula-guarded cells; leader lines and
links to notes are left out. The validation report gains a **Cable schedule**
section with the same rows (`src/lib/cableSchedule.ts`).
**Checked:** `cableSchedule.test.ts` (3); `e2e/racks.mjs` — the length is kept,
the CSV is exactly the expected rows in port order, and the report carries the
table.

### LT-197 — Front and rear rack views — 2026-09-16
**Source:** mission 1.4. **Acceptance:** a toggle between front and rear, with
depth-aware devices shown on the side they occupy.
**Shipped.** Front and Rear toggle. Each device is mounted on a face and is full
depth unless made half depth. A full-depth box blocks its U on both faces and is
drawn hatched from the other face; a half-depth one is only on its own face, so
another half-depth box can share its U on the other side. Changing a placed
device's face or depth is refused when it would collide. The SVG export draws
the chosen face the same way.
**Checked:** `rack.test.ts`; `e2e/racks.mjs` — full depth shows from behind,
half depth is absent from the other face, mounting rear moves it to the rear
view, a full-depth box cannot share a rear half-depth one's U and a front
half-depth one can.

### LT-196 — Rack elevation from logical devices — 2026-09-16
**Source:** mission 1.4. **Acceptance:** generate an elevation from devices
that carry a rack and rack-unit height, without moving the logical diagram.
**Shipped.** **Build racks from devices** makes a rack for every rack name the
devices carry (42U, or taller if what is in it needs more, up to 60U) and places
every device with a height and no valid U from the top down, keeping valid
positions and naming anything that does not fit. Only device data changes: the
logical diagram does not move. Zero-U devices are listed under the rack.
**Checked:** `rack.test.ts`; `e2e/racks.mjs` — the rack is made, devices land
at U42, U40–41 and U39, positions on the canvas are unchanged, and the zero-U
PDU is listed apart.

### LT-195 — Rack elevation editor — 2026-09-16
**Source:** mission 1.4. **Acceptance:** racks with a U height; devices placed
by U position; U placement always snaps (D-013 amendment); overlap refused.
**Shipped.** A **Racks** tab in the bottom panel. Racks are project-wide
(`doc.racks`: name and height in U); a device is in one when its existing
**Rack / room** field names it, at its `rackU`. Devices with a height wait in a
filterable list beside the racks and are dragged in; boxes are dragged within
and between racks or moved a U at a time with the arrow keys. Placement is
always a whole U — there is no setting to turn it off (the D-013 amendment) — and
a move into space something else holds, off the rail, or a rack shrunk below a
device, is refused with what is in the way. Racks are added, renamed (their
devices follow) and removed (devices keep their rack and U). The elevation
exports as SVG. A pasted or duplicated device keeps its rack but not its U, and
a clash that exists anyway is outlined rather than hidden (`src/lib/rack.ts`).
Found on the way and fixed first: LT-276.
**Checked:** `rack.test.ts` (16), `rackSvg.test.ts` (3), paste and duplicate
tests; `e2e/racks.mjs` — drag to a U, refused overlap, bottom U, arrows and undo,
adding, duplicate name, renaming, refused shrink, SVG export, pasted copy.

### LT-187 — Templates — 2026-09-16
**Source:** mission 1.2. **Acceptance:** blank, branch office, data-centre
spine-leaf, campus three-tier, DMZ, SD-WAN overlay, MPLS L3VPN, wireless survey
and rack elevation — every name and address invented, RFC 5737/3849 ranges only
(D-027).
**Shipped.** **New project** has a **Start from** choice: Blank, Branch office,
Data centre spine-leaf, Campus three-tier, DMZ, SD-WAN overlay, MPLS L3VPN,
Wireless survey and Rack elevation (`src/lib/templates.ts`). Each is a drawing,
not a sample: sections as boundaries (subnet, security zone, BGP AS), port and
cable labels, callouts where a word helps, and no probes — nothing is monitored
until the engineer adds it. Every name is invented; addresses are RFC 5737 and
RFC 3849 only, AS numbers RFC 5398 only. The rack template also fills two racks
front and rear. Every template was looked at on the canvas and two were re-spaced.
**Checked:** `templates.test.ts` (64) holds every template to documentation
addresses and AS numbers, no probes, links to devices that exist, no device on
another, valid boundary ids, rack placements clear of each other, and the
standard views; `e2e/pages.mjs` creates a project from a template through the
dialog and from Blank.

### LT-276 — Reopening a project dropped its captured shapes and grid snap — 2026-09-16
**Source:** found while adding racks (LT-195), which would have been dropped the
same way. **Bug:** opening a project runs `migrateDocument`, which rebuilt the
document from only its pages, active page and probes — so every other
project-wide field was lost on every open: shapes captured into the project
(LT-104), the grid snap setting (LT-175), and racks.
**Reproduced:** `migrate.test.ts` — a paged document and a pre-pages one, each
carrying those fields, came back without them (2 failing).
**Fixed:** migration carries every project-level field over as it is and only
replaces the ones it owns. Both tests pass.

### LT-186 — Paste in place — 2026-09-16
**Source:** mission 1.2. **Today:** copy, paste and duplicate exist.
**Acceptance:** paste at the original coordinates, including onto another page.
**Shipped.** `Ctrl+Shift+V`, or **Paste in place** in the canvas menu, pastes the
last copy at the coordinates it was copied from, onto whichever page is open —
so the same block lands in the same place on another page. The copy as taken is
kept apart from the clipboard ordinary pastes step along, so paste in place
still goes back to the original spot after any number of `Ctrl+V`s. Links
between copied objects come too; one undo removes it. The menu item is greyed
out until something is copied.
**Checked:** `e2e/pages.mjs` — an ordinary paste still offsets, paste in place
after it lands on the original coordinates with the link, selected alone, one
undo removes it, and the menu item pastes onto another page at the same place.

### LT-184 — Layers with lock and print toggles — 2026-09-16
**Source:** mission 1.2. **Today:** layers with visibility exist.
**Acceptance:** per-layer lock and print/export toggles; a new project offers
Physical, Logical, Overlay and Annotations layers.
**Shipped.** Locking a view already worked — its objects cannot be dragged or
edited — and is now checked through the app. New: each view has a ⎙ toggle;
a view set not to print stays on the canvas but is left out of every diagram
export (SVG, PNG, PDF, Visio, sheets) and off the paper when printing — the
canvas drops it for the print job and puts it back after (`isPrinted`,
`printing` in the store). An object on several views goes out if any of them
prints; an object on none is on all of them, as before. A new project starts
with Physical, Logical, Overlay and Annotations, all empty so nothing changes
until something is put on one; an older page is offered **Add …** for whichever
are missing, which replaces an untouched Base view and keeps any other.
**Checked:** `layers.test.ts` (8 new); `e2e/pages.mjs` — locked view refuses a
drag and unlocking allows it, the toggle is remembered, the SVG export leaves
the view out, a stubbed print sees it gone and the canvas has it back after, the
offer adds only the missing views, and a new project has the four.

### LT-183 — Page navigator — 2026-09-16
**Source:** mission 1.2. **Today:** multi-page diagrams exist.
**Acceptance:** a navigator listing pages with thumbnails, reorder, rename and
keyboard switching.
**Shipped.** The ☰ button at the start of the tab strip opens a list of every
page, each with a sketch of what is on it — device outlines, sections as
outlines, a line per link, fitted to the thumbnail and capped at 1,500 devices
(`src/lib/pageThumb.ts`) — and a count of objects and links. A click or the
arrow keys switch page; a double-click or F2 renames in place (blank keeps the
old name); dragging a row or Alt+Up/Down moves the page. Esc, Enter or a press
outside closes it. Ctrl+PageUp/PageDown switch pages from anywhere. Keys the
navigator handles stop there, so the arrows do not also nudge the selection.
**Checked:** `pageThumb.test.ts` (5); `e2e/pages.mjs` — 21 checks through the
real app: keys, sketch contents and fit, click, arrows, Alt+Up, F2, blank name,
drag, closing, and nothing on the canvas moving.

### LT-182 — Free text boxes and annotations — 2026-09-16
**Source:** mission 1.2. **Today:** text and callout shapes exist.
**Acceptance:** any gap between them and a free text box with the rich
formatting of LT-181 is closed.
**Shipped.** The gap was line breaks. Text and callout shapes already took
LT-181's styling (their text is a label); a free text box needs more than one line.
Their text now keeps its line breaks on the canvas, is edited in place in a box
where Enter finishes and Shift+Enter starts a line, is a multi-line field in the
inspector, and is written line by line in the export.
**Checked:** `diagram.test.ts` (each line its own evenly spaced row);
`e2e/arrange.mjs` — double-click empty canvas, type two lines with Shift+Enter,
finish with Enter, and the stored text and the drawn box both hold two lines;
`interact.mjs` (303) still passes.

### LT-181 — Rich text on labels — 2026-09-16
**Source:** mission 1.2. **Acceptance:** bold, italic, size, colour,
background and alignment on device, port and link labels, identical in export.
**Shipped.** Bold, italic, size (8–48), colour and background on a device's name
(and alignment, which a name has room for), a link's centre label and its port
labels — set in the inspector, drawn on the canvas as CSS and in the export as
the same SVG attributes (`src/lib/textStyle.ts`). Only `#rrggbb` colours and a
clamped size ever reach a stylesheet or an exported file. Clearing every choice
removes the style. Link labels take no alignment: each is a single chip centred
on its point. The controls sit in a closed section (open when the label is already
styled): open by default, they put two rows of pickers above a link's own colour —
`interact.mjs` caught it by finding the wrong picker first.
**Checked:** `textStyle.test.ts` (CSS and SVG from one style, sanitising,
alignment); `diagram.test.ts` (styled name, label and port label in both node
styles, unstyled ones unchanged, left alignment); `e2e/arrange.mjs` — bold and
size on a name and italic on a link label through the real inspector, and
clearing the last choice clearing the style.

### LT-180 — Arrowheads and line styles, per link — 2026-09-16
**Source:** mission 1.2. **Today:** caps, dashed, colour and width exist.
**Acceptance:** dotted added where missing; arrowhead style settable per link
direction and per link type; every combination survives export.
**Shipped.** Dotted and dash-dot line styles, six arrowhead shapes at either end,
and per-link colour and width were all already there. What was missing: the
saved default look carried no arrowheads, so new links could not be born with
chosen ones and "reset to default" cleared them. The default style now carries a
link's own start and end caps (`linkDefaults.ts`), and reset restores the saved
ones. "Per link type" is taken as the page's default look — the style every new
link on it gets.
**Checked:** `linkDefaults.test.ts`; `diagram.test.ts` draws all thirty-six
start/end cap pairs and every line style in the export.

### LT-178 — Orthogonal routing that avoids devices — 2026-09-16
**Source:** mission 1.2. **Today:** straight, step, smooth step and bezier.
**Acceptance:** an orthogonal mode and an avoid-devices mode that routes round
devices in the way, on canvas and in export.
**Shipped.** A fifth path type, **Around devices** (`avoid`), in the link inspector
and the cycle on the link menu (`src/lib/avoidRoute.ts`). The route is a shortest
path with a cost per turn over a grid made only of the relevant lines — every
device's edges pushed out by a margin — searched with Dijkstra, then drawn with
rounded corners and a halfway label point. Obstacles are the devices and shapes
near the link, its own two ends included so it never cuts through its own
device, capped at sixty; sections, text and notes are not in the way. A device
lying over an end is ignored, since the link starts inside it. With no way
through at all it falls back to a step path. Only a link of this type subscribes
to the page's devices, so ordinary links are unaffected. The export uses the same
function.
**Differs from the acceptance:** "an orthogonal mode and an avoid-devices mode" is
one mode — every route it draws is orthogonal; a plain orthogonal link without
avoidance is the existing **Step**.
**Found by testing:** the first obstacle list left out the link's own ends (it
could cut through its target to reach its far side) and treated a device lying
over an end as "no route"; both fixed, each with a test.
**Checked:** `avoidRoute.test.ts` (straight when clear, round one and several
devices, fewest turns, never through its own device, an overlapping device
ignored, no route when walled in, rounded corners); `diagram.test.ts` (the export
goes round); `e2e/arrange.mjs` — the drawn path clears a box between the ends; a
screenshot looked at.

### LT-177 — Auto-layout: hierarchical, radial, force-directed, orthogonal — 2026-09-16
**Source:** mission 1.2; allowed by D-029. **Today:** LT-145's tier layout
exists. **Acceptance:** four layouts on an explicit button, applied to the page
or the selection, one undo restores every position, locked devices do not move.
**Shipped.** Beside the existing hierarchical **Arrange top to bottom** (LT-145),
three more on the canvas menu (`src/lib/autoLayout.ts`), each on the selection when
two or more devices are selected, otherwise the page; one undo step; locked
devices left where they are; deterministic; centred where the devices were:
- **Radial** — the device fewest hops from everything (the graph's centre, so the
  core even when an access switch has as many links) in the middle, the rest on
  rings by distance, each branch kept to its parent's angle.
- **Force-directed** — links pull, devices push, locked devices hold still, from
  the current positions. Refused above 1,500 devices, with a message to select
  part of the diagram: it compares every pair on every pass.
- **Orthogonal** — a strict grid built as a tree of blocks: the centre at the top,
  what hangs off each device under it, a switch's hosts wrapped into a compact
  block rather than one long row.
**Found by looking:** the first radial took an access switch with as many links as
the core for the centre, and the first grid laid hosts out in one twenty-wide
row; both were rendered, seen, redesigned and given tests that fail on the old
behaviour.
**Checked:** `autoLayout.test.ts` (11 — centre, rings, branches kept together,
no overlaps, linked closer than unlinked, blocks under parents, locked devices,
determinism); `e2e/arrange.mjs` — each layout from the real menu moves the page,
leaves a locked box, and one undo restores every position; a selection lays out
only itself.

### LT-179 — More connection points — 2026-09-16
**Source:** mission 1.2. **Today:** four side handles plus LT-107 bearings.
**Acceptance:** a centre point and points along each edge on every shape.
**Shipped.** Thirteen connection points on every shape — a quarter, halfway and
three quarters along each side, and the centre (`CONNECTION_POINTS` in
`src/lib/floatingAnchor.ts`) — used by LT-176's snapping. They are anchors like
any other, so the export draws a link to one exactly as the canvas does. A link
fixed to a centre starts from the middle of the shape, which is what wiring a hub
from its centre means.
**Checked:** as LT-176.

### LT-176 — Snap to node and to connector — 2026-09-16
**Source:** mission 1.2. **Acceptance:** a dragged device snaps to another
device's centre and edges and a dragged link end to a connection point, with
the same guide display; guides still win over the grid.
**Shipped.** A dragged device already snapped to other devices' edges and centre
lines — that is what the alignment guides do (D-013), so nothing
was added there. What was missing was the connector half: a dragged link end now
snaps to the nearest connection point (LT-179) within ten screen pixels, on the
device under the pointer or, off every device, its own; a ring shows the point
before release; the end is fixed there, and dropped on another device's point it
moves there at that point (LT-157's reconnect now keeps the anchor).
**Checked:** `floatingAnchor.test.ts`; `e2e/arrange.mjs` — the ring, an exact
landing on a side's middle, a move to another device's centre, and no snap
between points when zoomed in; `canvasfix.mjs` (LT-157's end moves) still passes.

### LT-175 — Grid snap, as amended into D-013 — 2026-09-16
**Source:** mission 1.2 and the D-013 amendment. **Acceptance:** exactly the
amendment — per-project toggle always visible in the toolbar and in
Preferences, Ctrl/Cmd+Shift+G, guides win, Alt/Option inverts for one drag, off
by default on freeform views, always on for rack U placement, on for port and
patch-panel views.
**Shipped.** A project setting (`gridSnap`, off by default — the freeform default
of the amendment), always visible as **Grid snap on/off** in the toolbar, flipped
with Ctrl/Cmd+Shift+G or the canvas menu. On a single-object drag, an axis an edge
guide or equal-gap rhythm took stays where the guide put it; only an axis nothing
took snaps to the page's 12-unit minor grid (`src/lib/gridSnap.ts`). Alt refuses
the guides, as before, and inverts grid snap for that drag.
**Differs from the amendment:** there is no Preferences screen in the app — the
launcher's settings are app-wide folder paths, and this is a project setting — so
the toolbar and the canvas menu are where it lives. Rack elevation's always-on U
snap and the port view's default come with those views (LT-195), which do not
exist yet.
**Checked:** `gridSnap.test.ts` (guides win per axis, edge and rhythm);
`e2e/arrange.mjs` — the toolbar state, Ctrl+Shift+G, a drag landing on the grid,
Alt dropping it off, the toolbar button turning it off and a drag landing free.

### LT-173 — Lasso select — 2026-09-16
**Source:** mission 1.2. **Today:** marquee and Shift-click multi-select exist.
**Acceptance:** a freehand lasso selects what its outline encloses, with a
modifier to add to the selection.
**Shipped.** Alt+drag on empty canvas draws a freehand outline instead of a box
and selects what it goes round, judged by each object's middle as sections judge
membership (D-012); Alt+Shift adds to the selection; an outline round nothing
clears it. React Flow's box never starts. The geometry is pure
(`src/lib/lasso.ts`): even-odd point-in-polygon, concave outlines included, and a
slow drag thinned to points four pixels apart.
**Checked:** `lasso.test.ts`; `e2e/arrange.mjs` draws real outlines with the mouse
— outline shown, no box, exactly the two boxes gone round, a third added with
Shift, cleared by an empty lasso.

### LT-174 — Z-order, and the arrange gaps — 2026-09-16
**Source:** mission 1.2. **Today:** align, distribute, group, ungroup and lock
exist. **Acceptance:** bring forward, send backward, bring to front, send to
back, through undo and preserved in save and export; any gap found in the
existing arrange tools is its own item.
**Shipped.** Bring to front and Send to back beside the existing Bring forward and
Send backward (LT-101), on the object menu and as Ctrl+Shift+] / Ctrl+Shift+[
and Ctrl+] / Ctrl+[. On a selection they move the whole selection as a block,
keeping its own order (`src/lib/zOrder.ts`); each is one undo step, and a move
that changes nothing takes none. The export draws in the same order.
**Arrange gaps:** none found beyond these — align, distribute, group, ungroup
and lock were each already on a shortcut or menu and covered by `interact.mjs`.
**Checked:** `zOrder.test.ts`; `e2e/arrange.mjs` — each shortcut, the drawn
z-index, undo, a selection moving as a block, the menu on one object.

### LT-185 — Undo history of 200 steps that survives reload — 2026-09-16
**Source:** mission 1.2. **Today:** 60 steps, in memory only.
**Acceptance:** at least 200 steps, persisted locally with the project and
restored on reopen; the file format is unchanged or migrated.
**Shipped.** Two hundred steps (`HISTORY_LIMIT`), kept after closing.
- **Cheap to hold:** an undo step used to be a deep JSON copy of the whole
  document; it now shares every unchanged object with the document, which only
  ever replaces what it changes. In development every step is deep-frozen, so an
  in-place edit anywhere would throw in the harnesses — `interact.mjs` (303),
  canvasfix, glyphjumps, shapes, viewing and groups all ran with it and raised
  none.
- **Kept locally:** after each save the history is written to the webview's
  IndexedDB (`src/lib/historyStore.ts`), each shared device, link and page stored
  once. Never in the project file or an export — history holds what was deleted.
- **Only for that save:** it is stamped with the save's time and restored on
  opening only if the project still carries that stamp and needed no migration,
  so an undo never steps into another version's past. Deleting a project deletes
  its history. The project file format is unchanged.
**Checked:** `historyStore.test.ts` (sharing survives packing); `e2e/history.mjs`
— 205 edits keep 200 steps, a save and reopen keep them with undo and redo
continuing, a project changed since opens with none.

### LT-275 — Canvas benchmark at 10,000 devices — 2026-09-16
**Source:** LT-190's outstanding run, listed as a quick item 2026-09-16.
**Acceptance:** one production-build run at 10,000 devices recorded beside the
1,000 and 5,000 figures.
**Recorded** in LT-189's table: open 18.8 s, idle at the frame floor, pan 205 ms,
zoom 66 ms, drag 861 ms (production build, far-zoom detail in place). The harness
needed one fix to get there: a 10,000-device project is past the browser's
localStorage quota, so the fixture no longer depends on it.

### LT-189 — Memoised nodes and edges, fine-grained selectors — 2026-09-16
**Source:** mission 1.3; also LT-188's baseline. **Acceptance:** every custom
node and edge memoised, store reads narrowed so a change to one device does not
re-render the others — shown by a render count, not asserted.
**Progress, 2026-09-16 — measured, not finished.** The first benchmark (LT-190)
found dragging **one** device at 1,000 devices ran at a mean frame of 357 ms on
a production build — about three frames a second. Profiled, the causes were
ours, and four of them quadratic:
- every device and link asked the store for its status, and each lookup
  flattened and searched every page — now cached indexes per document
  (`nodeById`, `edgeById`, `pageNodeById`, cached `allNodes`/`allEdges`);
- every link subscribed to the whole document and searched the page for its
  two ends — now it reads its own two ends only;
- the canvas handed React Flow a new object for every node on every change —
  unchanged nodes now keep theirs;
- every link re-ranked its port chips by walking every other path whenever any
  path changed — now one index per registry version, and only for links that
  have chips; a label's drag start is measured on press, not on every render;
- the status panel rebuilt and re-rendered every row, finding each link's end
  names by search, on every frame — rows now rebuild only when a name, type,
  link, probe or status changes, and the table body is memoised;
- a drag wrote every frame's position into the document, waking some twenty
  thousand selectors — positions in flight now live in a drag overlay
  (`src/state/dragOverlay.ts`) and the document is written once on release, the
  same final write as before, so groups and sections land exactly where they did.
**Measured at 1,000 devices, production build, mean drag frame:** 357 → 241 →
202 → 168 → 153 → 94 ms. A DOM mutation count during a ten-step drag shows one
device and two links changing. What remains is Chrome's own paint, compositing
and hit-testing of ~77,000 DOM elements (a trace: paint ~1.0 s, layerize ~0.75 s,
hit-test ~0.5 s per ten steps); a dragged-layer and containment CSS experiment
did not move it. That cost scales with what is rendered, which is LT-188's
question. **At 5,000 devices (LT-188's runs, culling off):** idle at the frame floor, pan
~316 ms, zoom ~120 ms, drag ~650 ms a frame. **Pan is the next target** — it
costs the same with culling, so it is not the devices being drawn.
**Pan at 5,000, profiled.** JavaScript is ~1 s of a ten-step pan; the rest is
Chrome — layerize ~6 s, raster ~3.6 s, paint ~2.7 s, hit-test ~2 s. Chrome keeps
only 9 compositor layers and the diagram paints into the root layer, so every
pan step repaints and re-layerizes the whole diagram. Ruled out by measurement,
each changing nothing that matters: hiding the minimap, hiding the page grid or
the whole page sheet, flattening every device's z-index, and putting the
viewport or the minimap on its own layer (the viewport layer cuts raster to
~1.3 s but leaves layerize at ~5.8 s). What is left is the size of the DOM —
~77 elements per device-and-link pair — so the remedies are structural: fewer
elements per device and link, or a simpler drawing when zoomed out. Not started;
that is a design change to agree first.
**Found along the way and fixed:** pointing at a link fades every other link.
The fade was an opacity each link computed, so every hover re-rendered all of
them, and a pan started on a link left the whole diagram faded — and flickering
— for the whole pan. The fade is now one stylesheet rule (`TraceFade`), and any
button press ends tracing. `e2e/canvasfix.mjs` checks that pointing traces, a
press ends it and a held pan does not re-trace; `interact.mjs`'s fade checks
still pass.
**Still to do:** the DOM-size design above; the render counts this item's
acceptance asks for.
**Operator, 2026-09-16:** "go ahead continue one by one" — the DOM-size work
(fewer elements per device and link; a simpler drawing when zoomed out) goes
ahead, followed by the rest of Phase 1. Nothing is committed or pushed until all
of it is done: "dont commit or build in github until you all the work is done".
**Closed 2026-09-16.** The last piece: zoomed below 40% on a page of 500 or more
objects, the canvas draws devices and links without their detail — names, status lines, badges, handles, link hit
bands and labels — by one class on the canvas, which changes only when the zoom
crosses the line, so nothing re-renders. A trace had shown that detail to be most
of what Chrome repainted and re-layerized on every pan frame. Devices keep their
grab area and stay draggable. First built for every page, it hid the hit bands of
an ordinary twenty-device diagram fitted to the window — the interaction harness
caught it — so it is held to the same 500-object line culling was (D-010).
**Where it ends, production build, mean frame:**

| | 1,000 | 5,000 | 10,000 |
| --- | --- | --- | --- |
| Pan | 43 ms | 308 → **96 ms** | 205 ms |
| Zoom | 10 ms | 122 → **32 ms** | 66 ms |
| Drag | 357 → **94 ms** | 620 → **377 ms** | 861 ms |
| Open | 2.2 s | 9.6 s | 18.8 s |

**Still slow, and said plainly:** dragging at 5,000 and 10,000 devices, and a
single long frame — 2.8 s at 5,000, 6.5 s at 10,000 — when zooming in across 40%,
as every label is drawn at once. A diagram of a few hundred devices, the common
case, is unaffected by either.
**Render counts,** as the acceptance asks: a ten-step drag at 1,000 devices
changes one device and two links in the DOM (a mutation count), where before
every device and link re-rendered each frame.
**Checked:** `e2e/viewing.mjs` — detail hidden below 40%, a device still dragged
there, detail back on zooming in; `interact.mjs`, `canvasfix.mjs`; the benchmark
runs above.

### LT-274 — Old roadmap entries still name the operator's lab — 2026-09-16
**Source:** found 2026-09-16 (reported in the Phase 1 check-in). Done entries
written before D-027's scan existed name lab devices and a switch serial — the
scan checks only new lines, so they were never caught.
**Acceptance:** those names replaced with invented ones in the roadmap and any
other doc, the entries otherwise unchanged (never deleted, never renumbered),
and the scan run over the whole tree, not only the diff. Git history keeps the
old text; rewriting it is the operator's call.
**Wider than the roadmap.** Scanning the whole tracked tree, not only new lines,
found the lab's switch, firewall, access point, desktop and NAS names, three NIC
MAC addresses, three serials and the SNMPv3 user name in Rust and TypeScript
tests, e2e fixtures, code comments, an inspector placeholder, the user guide —
and inside four captured-packet fixtures, which a text scan does not read.
**Shipped.** Every one replaced with an invented name of the **same length**
(the FortiOS captures are fixed-width tables their parsers read by column; a
DNS name in a packet is length-prefixed), consistently across code, tests,
fixtures and docs. MAC addresses keep their vendor prefix — the vendor lookup
tests depend on it — with an invented device part. The certificate and TLS
fixtures were already invented. Git history keeps the old text.
**Not moved:** the lab's private `192.168.77.0/24` addresses, which identify no
one; the pattern list used for the scan is not committed, because it is itself a
list of the real names.
**Checked:** a whole-tree scan, text and binary, finds none; `cargo test` for
probe (138), discover (362) and the app (137); the affected unit tests; the
discover, join and scansettings harnesses.

### LT-273 — **bug** Moving a device cannot be undone — 2026-09-16
**Source:** found 2026-09-16 while reading how a drag reaches the document
(LT-189), and raised with the operator, who asked for it to be done.
**Symptom:** drag a device somewhere else, press Ctrl+Z — the device stays where
it was dropped, and the undo goes back past the move to whatever came before it.
Only adding and removing objects took an undo step; a move never did.
**Acceptance:** one undo after a drag puts the device — and anything that moved
with it, a group or a section's contents — back where it was; redo moves it
again; a click with no movement takes no undo step. Reproduced by a failing
interaction check before the fix (D-020).
**Reproduced first (D-020):** `e2e/canvasfix.mjs` failed with the drag taking no
undo step (2 → 2) and the one Ctrl+Z undoing the *grouping* made before the
drag instead — it only looked like the device came back because that older
snapshot held its old position.
**Cause.** Undo steps are taken explicitly, and `onNodesChange` took one only for
adding and removing. Nothing took one for a move — before or after LT-189's drag
overlay.
**Fixed.** The first in-flight position of a drag takes the step, before anything
has moved (`route` in Canvas). Groups and section contents move in that same
step, so one undo brings them all back; a click that moves nothing sends no
position and takes no step. Arrow-key nudges are unchanged.
**Checked:** canvasfix passes — a click takes no step, a drag exactly one, undo
restores the device and leaves the earlier grouping, redo moves it again, a group
member's drag carries its group and one undo brings the group back;
`interact.mjs` 303 checks pass.

### LT-194 — Print-friendly export theme — 2026-09-16
**Source:** mission 1.3. **Today:** light and dark grounds. **Acceptance:** a
print theme for export — ink-saving, legible in greyscale, statuses still
distinguishable by glyph.
**Shipped.** A **Print-friendly** box in the Export menu, for SVG, PNG, PDF and
SVG sheets (`src/lib/printTheme.ts`). The diagram is drawn on the light sheet and
every colour mapped by brightness: near-white to white, so header bands and
surfaces cost no ink; coloured and mid-grey marks to greys no lighter than 50%,
so white glyphs on status badges still read; dark ink kept. The export legend
now shows each status's glyph in its dot — in every export, since a legend of
colour alone was unreadable once printed and for anyone who cannot tell the
colours apart.
**Found by looking:** the rendered comparison showed the legend as five identical
grey dots, hence the glyphs; a test found the disabled status (already a neutral
grey) too light for its glyph, hence the ceiling on mid-greys.
**Not covered:** imported stencil artwork is an embedded picture and stays in
colour.
**Checked:** `printTheme.test.ts` (whites, ink, every status colour dark enough,
only greys in an export from either ground, glyphs in the legend);
`e2e/viewing.mjs` exports SVG from the real menu with and without the box; a
colour and a print render compared side by side.

### LT-193 — Presentation mode — 2026-09-16
**Source:** mission 1.3. **Acceptance:** chrome hidden, full screen, keyboard
page navigation; any existing presentation behaviour is checked against this
first.
**Shipped.** `F5` or **Present** in the canvas menu hides the toolbar, both panels,
the status panel, page tabs, zoom controls, minimap and legend; the canvas fills
the window. Arrows and Page Up/Down move between pages, `F` fits, `Esc` or `F5`
leaves; editing keys do nothing meanwhile. Full screen is requested and, if the
system's own exit leaves full screen, presentation ends with it. Never saved —
it is a way of looking, not part of the project.
**Not verified:** full screen itself. Headless Chromium refuses it and the
desktop webviews have not been tried; where it is refused, the chrome still goes.
**Checked:** `e2e/viewing.mjs` — chrome gone and canvas at full width, page
changes both ways, Delete doing nothing, Esc restoring the chrome; `interact.mjs`
still passes after the shortcut changes.

### LT-192 — Zoom to selection, zoom to node, saved viewpoints — 2026-09-16
**Source:** mission 1.3. **Today:** fit view exists. **Acceptance:** zoom to
selection and to a named node; viewpoints saved per page and recalled.
**Shipped.** `Shift+F` zooms to the selection (capped at 2x, as fitting is), and
says so when nothing is selected. **Save this view** in the canvas menu stores the
viewport as *View N* on the page; `Alt+1`–`9` and the menu go back to one; the
menu forgets one.
**Differs from the acceptance:** zoom to a named node was already there as
`Ctrl+F` find, which centres the device at the current zoom — kept as it is.
Views are named *View N*, not typed: renaming was not asked for.
**Checked:** `e2e/viewing.mjs` — centring and zoom after Shift+F, a saved view's
stored viewport, Alt+1 returning to it within a pixel, forgetting it.

### LT-191 — Minimap health overlay — 2026-09-16
**Source:** mission 1.3. **Today:** a minimap exists. **Acceptance:** an
optional overlay colouring devices by probe status, with a glyph cue, not colour
alone.
**Shipped.** A canvas-menu toggle, saved per page, colours the minimap's devices by
status; a down device is also outlined dashed and a warning one outlined solid.
Notes stay plain. The minimap is its own component, so probe results re-render
it and not the canvas.
**Checked:** `e2e/viewing.mjs` — plain by default, toggled from the real menu,
every device carrying its status class. Down and warning outlines are styled but
not exercised by a harness: the browser build cannot run probes.

### LT-188 — Adaptive viewport culling, measured — 2026-09-16 — measured, rejected
**Source:** mission 1.3, with the operator's protocol (D-010 stands until this
is measured).
**Protocol, in the operator's words and all required:**
1. Below ~500 nodes keep D-010's no-culling default — memoisation and tight
   selectors only. "Not negotiable."
2. Above 500 nodes, cull with a padded window: 2x the viewport bounds.
3. No culling recomputation during a node drag (drag start to drag stop): the
   last visible set renders; recompute on drag stop and on viewport idle.
4. Benchmark four scenarios separately: idle, pan, zoom, drag.
5. Accept only if idle, pan and zoom improve by at least 20% at 5k nodes **and**
   drag regresses by no more than 10% at 5k nodes. Otherwise reject culling
   entirely and open a decision that the very-large-diagram path needs a canvas
   or WebGL renderer.
6. Either way, record the outcome as a new decision that explicitly reaffirms
   or supersedes D-010. D-010 is never edited.
**Outcome: culling was built to the protocol, measured, and rejected — D-031
reaffirms D-010.** At 5,000 devices, two runs per build: idle unchanged (at the
frame floor), pan ~2% better, zoom about twelve times worse with a single
209–223 s frame, drag ~11% better. Idle, pan and zoom all failed the ≥ 20% bar.
The drag clause that would open a canvas/WebGL decision was not triggered. The
implementation, its unit tests and its harness were removed. 1,000 and 10,000
devices were not run: the 5,000 verdict was already decided, and a 10,000 zoom
under culling would sit in the freeze for many minutes.

### LT-168 — Outline and solid variants of every built-in shape — 2026-09-16
**Source:** mission 1.1, "iconic and monochrome/outline variants". Vendor-logo
style is out under D-028; the variants are Coreview's own.
**Acceptance:** each built-in shape has an outline and a solid rendering, chosen
per page and overridable per device, identical on canvas and export.
**Shipped.** `DeviceGlyph` in `icons.tsx` draws every built-in device glyph as
an outline (default) or a solid tile — the device's colour filled, the glyph in
near-black or white by the fill's brightness — and combines with the stacked
glyph. One component serves the canvas (glyph and card styles) and the export
(`glyphMarkup`), so they match. The page's choice is in the canvas's right-click
menu; a device's **Glyph** field in the inspector overrides it either way.
Imported artwork is drawn as it is and is unaffected.
**Checked:** `glyphVariant.test.ts` (ink choice, markup with no stray
`currentColor`, stacked plus solid, page and device override in export);
`e2e/shapes.mjs` flips the page from the real menu, counts solid glyphs,
overrides one device back to outline; screenshot looked at — which also caught a
stray divider after a cable tag on an unlabelled link, fixed.

### LT-167 — Cable types on links — 2026-09-16
**Source:** mission 1.1. **Acceptance:** copper, single-mode fibre, multimode
fibre, coax, wireless, WAN link and trunk as a link property, each visibly
distinct on the canvas and in exports without relying on colour alone, and
carried into the cable schedule (LT-198).
**Shipped.** `cableType` on a link — copper, single-mode fibre, multimode fibre,
coax, wireless, WAN link, trunk — chosen in the link inspector and shown as a tag
leading the centre label (`Cu`, `SMF`, `MMF`, `Coax`, `Wi-Fi`, `WAN`, `Trunk`)
on the canvas and in export, even on a link with no label.
**Differs from the acceptance:** distinct by *tag*, not by line style. The line's
dash already carries status (a down link is dashed), so a cable drawn dashed
would read as a fault; a tag is legible without colour and cannot be confused
with health. Carried into the cable schedule when LT-198 builds it.
**Checked:** `cables.test.ts`, `diagram.test.ts`; `e2e/shapes.mjs` sets single-mode
fibre in the real inspector and reads the SMF tag on the link.

### LT-166 — Logical boundaries — 2026-09-16
**Source:** mission 1.1. **Acceptance:** VLAN boundary, subnet, security zone,
VRF, BGP AS and OSPF area, drawn as boundaries (built on sections, D-012) with
the identifier — VLAN id, prefix, VRF name, AS number, area — as a field.
**Shipped.** `src/lib/boundaries.ts`: a section carries `boundaryKind` and
`boundaryId`. Six kinds in a new **Logical boundaries** palette group, each with
its own dash pattern on the canvas and in export, so kinds differ without colour;
a title chip (`VLAN 20`, `192.0.2.0/24`, `Zone DMZ`, `VRF MGMT`, `AS 64500`,
`Area 0`); identifier checks — VLAN 1–4094, IPv4/IPv6 prefix with length, VRF
name, AS plain or asdot, OSPF area number or dotted — flagged, not refused, so a
half-drawn diagram is allowed. The inspector turns any section into a boundary
and back. Membership stays geometric (D-012).
**Found while testing:** the kind check used `in`, so `toString` counted as a
kind — a document carrying it would have broken the lookup. It checks own keys
now, and the test that caught it stays.
**Checked:** `boundaries.test.ts`, `paletteDrop.test.ts`, `diagram.test.ts`;
`e2e/shapes.mjs` drops a VLAN boundary from the palette, sets 20 and reads the
chip, sets 5000 and sees it flagged with the reason; screenshot looked at.

### LT-170 — Third-party artwork warning and vendor-safe export — 2026-09-16
**Source:** D-028. **Acceptance:** exporting a project that uses imported
stencils warns that third-party artwork may be included; a vendor-safe export
option replaces each imported stencil with the built-in shape for its class.
**Shipped.** `src/lib/thirdPartyArt.ts`: a device with inlined artwork counts as
third-party unless it is Coreview's own — a shape captured from a built-in glyph
(LT-104) is now marked `own`, and a device dropped from it `ownArtwork`. Older
projects' pictures count, on the side of warning. The Export menu shows how many
devices use imported stencils, the distinct licence statements, and how many
have none; every diagram and package export says so again in the status line.
**Vendor-safe export** replaces imported artwork with the class's built-in shape
(a bare custom image becomes generic) in SVG, PNG, PDF, SVG sheets and the
project package — every page of the package, and captured shapes that are not
Coreview's own are dropped from it. Vendor, model and the rest are kept.
**Differs from the acceptance:** printing is not vendor-safe — it prints the live
canvas — and the menu says so when the box is ticked. The Visio export carries no
artwork at all, so it needs nothing.
**Checked:** `thirdPartyArt.test.ts`; `e2e/shapes.mjs` reads the warning and
licence in the real menu, exports SVG with and without the box, and finds the
artwork in one and not the other.

### LT-172 — BRAND_AND_LICENSING.md and CONTRIBUTING.md — 2026-09-16
**Source:** D-028. **Acceptance:** `docs/BRAND_AND_LICENSING.md` explains
self-drawn shapes versus vendor-as-data and user-sourced stencils;
`CONTRIBUTING.md` exists and points at it; ARCHITECTURE.md and the manifest
schema reference D-028. Depends on Q-009 for the licence it names.
**Shipped.** `docs/BRAND_AND_LICENSING.md` (the split, why, user stencils,
rules for contributors) and `CONTRIBUTING.md` pointing at it first;
ARCHITECTURE.md has a Shapes and stencils section citing D-028; the manifest
module's documentation cites D-028.
**Differs from the acceptance:** it names no licence, because the repository has
none — Q-009 is open, and the document says so where the licence will go.

### LT-169 — Documented stencil manifest and SVG import — 2026-09-16
**Source:** mission 1.1 and D-028. **Acceptance:** a versioned manifest schema
(file, name, class, vendor, model, ports, rack units, licence note) that the
importer validates and rejects clearly; documented in the user guide with the
statement that the user owns the licensing of what they import and that
Coreview ships, fetches and updates no vendor packs.
**Shipped.** `coreview-stencils.json` at a library folder's root, version 1,
validated in Rust (`src-tauri/src/stencil_manifest.rs`): unknown fields refused
at every level, a required licence statement, file names confined to the folder
and required to exist, classes checked against a list a TypeScript test keeps
identical to the device types, ports ≤ 1024, rack units ≤ 60, port naming must
contain `{n}`, no control characters. A refused manifest is reported in the
library's skipped list naming the shape and field; the shapes still load,
undescribed. A described icon drops as its class with that class's defaults
overlaid by the manifest's vendor, model, ports, naming and rack units, and
carries the licence statement for LT-170. Documented in the user guide, with the
user's licensing responsibility stated. No new IPC command — the metadata is a
field on the icon entries the existing commands return.
**Checked:** 12 Rust unit tests on the manifest rules and one scan test
(described, undescribed, refused); `shapeCatalog.test.ts` (class lists
identical across Rust and TypeScript); `paletteDrop.test.ts`; `e2e/shapes.mjs`
drops a described stencil through the real palette.

### LT-162 — **pre-release blocker** Vendor artwork out of the repository and installer — 2026-09-16
**Source:** D-028, 2026-09-16 — "If any Cisco artwork is currently bundled, flag
it as a pre-release blocker and remove it before v1.0."
**Today:** `stencils/cisco/` (219 files, 2.1 MB) is committed and bundled as a
Tauri resource (D-022). `src-tauri/fixtures/tripp-lite-racks.vss` is a vendor
stencil used as a test fixture; `scripts/fetch-modern-shapes.mjs` fetches
Simple Icons, which are brand logos.
**Acceptance:** no vendor artwork in the tree or the installer; the built-in
palette is served by LT-163–166 before the Cisco set goes, so it is never
empty; tests that used vendor files use invented SVG/VSS fixtures; the script
no longer fetches logos. Git history still holds the old files — rewriting it is
the operator's call, not part of this item.
**Shipped.**
- `stencils/cisco/` (219 files) is out of the repository and therefore out of
  the installer. `stencils/` keeps only a README explaining D-028, because the
  installer still bundles the folder as a resource and the pack mechanism
  (LT-103) reads it; it now ships empty. `.gitignore` refuses anything else
  there.
- `the_shipped_stencils_scan_into_a_full_palette` encoded D-022, which D-028
  supersedes. It is replaced by `the_shipped_stencils_folder_carries_no_artwork`,
  which fails if the shipped folder holds anything but its README. It was run
  with a stray SVG dropped in and failed, naming it.
- `sample.emf` was an icon exported from someone's asset pack ("Asset
  289-SECURITY"), so its provenance was unknown. It is replaced by an invented
  drawing exported through Inkscape; the EMF test passes against it.
- `tripp-lite-racks.vss` is out. No tool here writes `.vss`, so it has no
  invented twin: its test reads the operator's own copy from
  `COREVIEW_VSS_FIXTURE` with every assertion unchanged, and skips without it.
  It never ran in CI, which has no libvisio, so CI loses nothing. Passed locally
  against the file.
- `fetch-modern-shapes.mjs` fetches Tabler only; the Simple Icons brand marks
  and Tabler's one brand icon are gone. `import-pptx-stencils.mjs` says its
  output is never committed.
- The interaction harness's staged library uses invented names instead of
  vendor model names. README, palette, IPC and command comments no longer say
  "Cisco today".
- The operator's copies were kept, checked complete (219/219, `.vss`
  byte-identical), in `~/coreview-local/` outside the repository, so the icon
  library can still be pointed at them for his own use.
**Not done, and not this item's to do:** the files remain in git history.
Rewriting history is the operator's call.
**Checked:** `cargo test -p coreview icons::` — 35 passed, the `.vss` test run
against the local file.

### LT-171 — Shape metadata — 2026-09-16
**Source:** mission 1.1. **Acceptance:** vendor, model, default port count,
default port labels, management IP field and rack-unit height on a shape
definition, applied to a device when it is dropped and editable afterwards.
**Shipped.** `src/lib/shapeCatalog.ts`: per class a port count, a port naming
with `{n}`, a rack-unit height (0 for a zero-U PDU) and whether it starts with an
empty Management address — applied when the device is dropped, all editable in
the inspector (Ports, Port naming, Rack units). A link's port-label fields offer
the port names of the device at each end.
**Differs from the acceptance:** built-in shapes carry no vendor or model
default. They are vendor-neutral by D-028; vendor and model remain free-text
fields on the device, and the manifest (LT-169) is where an imported stencil
brings its own.
**Checked:** `shapeCatalog.test.ts`; `e2e/shapes.mjs` drops an L2 switch and
reads 24 ports, 1 U and an empty management address off it, edits the ports,
and reads the offered names on a link between a switch and a patch panel.

### LT-165 — Own shapes for physical kit — 2026-09-16
**Source:** mission 1.1. **Acceptance:** rack, patch panel, PDU, UPS, server,
VM host and storage array.
**Shipped.** Rack, patch panel, PDU, UPS and VM host, in a new **Physical**
palette group (VM host sits with compute); server and storage existed.
**Checked:** as LT-163, rendered on one sheet and looked at.

### LT-164 — Own shapes for WAN and services — 2026-09-16
**Source:** mission 1.1. **Acceptance:** cloud, internet, MPLS cloud, VPN
tunnel, load balancer and WAF available as shapes; the ones that exist are
reused rather than drawn twice.
**Shipped.** MPLS cloud, drawn as a cloud with a small mesh so it does not read
as the internet or a private cloud. Internet, cloud and VPN tunnel existed and
are reused; load balancer and WAF came with LT-163.
**Checked:** as LT-163.

### LT-163 — Own shapes for network device classes — 2026-09-16
**Source:** mission 1.1. **Today:** 20 self-drawn device glyphs.
**Acceptance:** original outline shapes for router, L3 switch, L2 switch,
firewall, wireless controller, access point, IP phone, blade chassis, load
balancer and WAF. The vendor list in the mission (Cisco ISR/ASR/Cat/Nexus/ASA,
Juniper, Arista, Palo Alto, Fortinet, F5, Check Point, Ubiquiti, MikroTik) is
served as vendor/model metadata (LT-171), not artwork (D-028).
**Shipped.** Six new self-drawn classes beside the existing router, firewall,
wireless controller and access point: L3 switch (arrows in and out of the box),
L2 switch (an arrow across it), IP phone, blade chassis, load balancer and WAF.
Each has a label, a palette place, a tint on both grounds and a layout tier;
the Visio import preview offers them. No vendor names anywhere (D-028).
**Checked:** `shapeCatalog.test.ts` (every class has its own glyph — no two
render the same — one palette place, no vendor in any label);
`e2e/shapes.mjs` finds each in the palette and drops one.

### LT-161 — Every link path type jumps where links cross — 2026-09-13
**Source:** asked 2026-09-13, with a screenshot of two curved links crossing
flat and a picture of a line jump — "one last thing all link path types
should have the jump like the smooth step".
**The shape:** a smooth-step link draws a small hop where it crosses another
link, so which cable goes where stays readable. A bezier or straight link
crosses flat.
**Acceptance:** where two links cross, one hops over the other whatever path
type either uses — smooth step, step, straight or bezier — on the canvas and in
exports, with the same rule for which one hops as today. Built with LT-157
to LT-160 and pushed together, at the operator's instruction.
**Cause.** Hop detection read only straight `L` runs and skipped every curve,
so a bezier link — one cubic curve — had nothing to cross, and nothing hopped
over it. Straight and step links already hopped on the canvas; the export drew
no hops for any path type.
**Shipped.** A cubic curve is cut into 32 pieces for crossing detection and,
where it hops, redrawn as a fine polyline with the hop cut in by distance along
it. A crossing close to a link's own end is two links meeting at a device, not
a hop. Smooth step's small rounded corners are still skipped, as before. The
rule for which link hops is unchanged. The export hops too, through the same
functions, honouring the page's line-jump setting and sharing one piece of link
geometry between drawing and detection so the two cannot disagree. Links whose
bounding boxes cannot meet are dropped before any pieces are compared, which
keeps the cost of curves down.
**Checked:** `lineJumps.test.ts` (its old case "has nothing to say about a pure
curve" described this bug and now states the new rule), `lineJumpsCurves.test.ts`,
`diagram.test.ts`, and `e2e/glyphjumps.mjs` on two crossing bezier links.

### LT-160 — Mark a device as HA by hand — 2026-09-13
**Source:** asked 2026-09-13, with a screenshot of the device inspector — "also
we need an option or check box to enabel HA manualy if we want to".
**The shape:** discovery marks a stack or chassis pair when a device reports
one, but an HA pair or cluster it cannot see (a firewall pair, a stack not yet
crawled) has no way to be marked. A checkbox in the inspector marks the device
as HA, and it then draws the stacked glyph of LT-159.
**Acceptance:** ticking the box on a device draws it as stacked, unticking puts
the single glyph back, it survives save and reload, and discovery never
unticks one someone ticked.
**Operator's instruction, 2026-09-13:** "thats it run with these and deploy
please" / "deply and push to github" — LT-157, LT-158, LT-159 and LT-160 are
built, checked and pushed together, superseding the earlier "don't push to
github until we fix all bugs".
**Shipped.** "HA pair or cluster — draw as stacked" in the device inspector's
checkboxes, stored as `ha` on the device and drawn with LT-159's glyph.
Discovery never writes the field, so a re-crawl cannot untick it.
**Checked:** `e2e/glyphjumps.mjs` ticks it and sees the stacked glyph and
`"ha":true` in the saved project, then unticks it and sees the single glyph;
`topology.test.ts` re-crawls a diagram with it ticked and no patch touches it.

### LT-159 — A stacked switch shows a stack icon — 2026-09-13
**Source:** asked 2026-09-13, with an image of two switch glyphs overlapping
— "stack should show something like this".
**The shape:** a device the crawl found to be a stack (LT-148 puts
`stackKind` and its members on the device) is drawn today with the same glyph
as a single switch. It should read as several boxes at a glance: the switch
glyph doubled and offset, as in the image.
**Acceptance:** a device with a stack reported on it draws the stacked glyph
on the canvas and in exports, and a single switch does not. A chassis pair
that is split into two nodes (LT-140) keeps drawing as two single switches.
Built after LT-157 and LT-158 — the operator asked that bugs come first and
that nothing is pushed until they are fixed.
**Shipped.** The device's glyph drawn twice, one box behind the other, the rear
masked where the front sits (`stackedIcon` in `icons.tsx`), so every device type
has one. Used on the canvas in both node styles and in the export. `drawsStacked`
decides: a reported stack or chassis pair, or LT-160's HA box. Each half of a
split chassis pair is marked `stackSplit` and keeps the single glyph while still
listing the pair's members.
**Checked:** `stacked.test.ts`, `topology.test.ts`, `diagram.test.ts`,
`e2e/glyphjumps.mjs`. Not seen on a real stack — LT-139 still waits for the
customer's approval — but it reads only the fields LT-148 fills.

### LT-158 — **bug** Space + drag sometimes selects instead of panning — 2026-09-13
**Source:** reported 2026-09-13 with a screenshot of a selection rectangle —
"when try to move the page around I press the space bar and left click both
hold and move some times it doens't work and i get this but maybe i'm not
hitting the space bar or its just laggey".
**Acceptance:** holding space and dragging with the left button pans the page
every time, including when the drag starts the instant space goes down and
when focus was last in a panel; it never draws a selection box. Reproduced by
a failing interaction check before the fix (D-020).
**Cause.** Two ways real input beat the space key. The button went down a moment
before space, so React Flow had already begun a selection box, and space only
changed what a *new* drag would do. And focus left in a panel field kept the key
there.
**Shipped.** Space pressed while the button is already held cancels the
selection React Flow started and pans from where the button went down. Pressing
on the canvas takes focus out of a panel field.
**Checked:** `e2e/canvasfix.mjs` — failed before the fix (7 failures across this
and LT-157), all 17 checks pass after; `interact.mjs` still passes.

### LT-157 — **bug** A link cannot be moved from one device to another — 2026-09-13
**Source:** reported 2026-09-13 with a screenshot of a selected link showing
its end handles — "I can't move the link from one device to another".
**Acceptance:** dragging either end of an existing link onto another device
reattaches it there, the old attachment is gone, and one undo puts it back.
Reproduced by a failing interaction check before the fix (D-020).
**Cause.** Dropping a link's end was only ever read as moving it round the same
device (LT-098's anchor drag); the device under the drop was never looked at.
**Shipped.** An end dropped on another device reattaches there (`reconnectEdge`
in the store). That end's port label, anchor and label position are cleared,
because they described the old device; the other end keeps its own. One undo
puts it back. A drop on the link's other device makes no loop, and a drop just
beside the same device still only moves the end round it.
**Checked:** `e2e/canvasfix.mjs`, failing before the fix, passing after.

### LT-134 — SNMP that actually reads these vendors — 2026-09-13
**Source:** asked 2026-09-12 — "I think we need the mibs for unifi , cisco,
fortinet, aruba, palo, hp, dell...etc, we didn't learn much and snmp didn't
work for the fortigate and the fortiswitch and the rest of teh devices / i
think we can do better".
**What his run actually shows**, which is the place to start rather than a
shopping list of MIBs: of six devices, one was logged into (`LAB-CORE-SW1`,
a WS-C2960CX), one answered SNMP only (`LAB-ACC-SW`, reported as
`Linux UBNT 3.18.24` — a UniFi box), and four were only ever "seen by a
neighbour", including the FortiSwitch `S224ENTF00000001` and both FortiAPs.
Four more could not be reached at all.
**So the gap is not only MIBs.** A device "seen by a neighbour" was never
asked anything — the question is why it was not reached, and that is
credentials, transport or filtering rather than object identifiers.
**Wanted, in the order it is worth doing:**
- Find out per device *why* it was not reached, and say so, rather than
  leaving "Seen by a neighbour" to mean six different things.
- `sysDescr`/`sysObjectID` already give model and OS for anything answering
  SNMPv2c — establish what the FortiGate and FortiSwitch answer, if anything,
  before assuming a MIB is missing.
- Then vendor MIBs where a standard object genuinely does not carry it:
  Cisco, Fortinet, UniFi, Aruba, Palo Alto, HP, Dell.
**Read the code before buying MIBs — two of the four are not MIB problems:**

- **SNMP is only tried after SSH has been refused** (`crawl.rs`, the `Err(e)`
  arm), and only on an address the crawl actually walks into. For anything it
  never visited, no SNMP request was sent at all, so no MIB could have
  helped.
- **A crawl only walks into infrastructure by default** —
  `DeviceClass::INFRASTRUCTURE` is router, switch, firewall and wireless
  controller. An **access point is not in that list**, which is why both
  FortiAPs read "Seen by a neighbour": they were never contacted, by design.
  Same for `LABDESKTOP01`, which is class Unknown. That is a default the
  operator can override, not a fault — but nothing in the interface says so,
  and "Seen by a neighbour" is left meaning six different things.
- **SNMP is off unless configured** (`snmp_is_off_unless_asked_for`), so a
  crawl run without a community string never tries it anywhere.
- **Where it was tried, it worked:** `LAB-ACC-SW` came back as
  `Linux UBNT 3.18.24` from sysDescr alone, with the neighbour's word used
  for its role because UniFi reports `sysServices 0`.

**The one genuinely odd case** is `S224ENTF00000001`, a FortiSwitch at
`192.168.77.203` — a switch, inside the swept range, with 22 and 443 open
(the 2026-09-12 sweep proved both) — that still came back only as seen by a
neighbour. That is worth diagnosing before anything else here, and it is
probably credentials or the subnet filter rather than SNMP at all.
**So the order is:** say why each device was not reached; then confirm what
the FortiGate and FortiSwitch answer to a plain sysDescr walk; and only then
add vendor MIBs where a standard object genuinely does not carry what is
wanted.

**First step done 2026-09-12, and it answers the MIB question.** The serials
he asked for twice do not need a vendor MIB at all: **ENTITY-MIB
(`entPhysicalSerialNum`, RFC 4133) is standard**, and Cisco, Aruba, Juniper,
Dell and HP all answer it. It reports one serial per *chassis*, so a stack
gives one per member — which is exactly what an RMA is raised against.
Measured against `LAB-CORE-SW1` over SNMPv3 (SHA + AES-256, his own
credentials):

```
serials : ["FOC0000TST2"]      # matches `show version` exactly
models  : ["WS-C2960CX-8PC-L"]
```

**One thing that needed care:** the first version also returned
`LIT0000TEST`, the power supply's serial, because ENTITY-MIB lists everything
physical. A power supply is not what an RMA for the switch is raised against,
so only rows whose `entPhysicalClass` is `chassis(3)` are kept.
**And one defect caught before it shipped:** the walk first carried values out
of the response buffer with `Box::leak`, which compiles and leaks a little
memory for every row of every table on every device a crawl touches. It uses
an owned value type now.
**An SNMP-only device therefore now arrives with a real serial and a real
model** — `WS-C2960CX-8PC-L` rather than a paragraph of sysDescr — where
before the code deliberately refused to invent one, and was right to.

**What is still wanted here, and why it is not vendor MIBs either:**
- **IF-MIB** for the interface table, **LLDP-MIB** for neighbours (so a device
  reachable only by SNMP can still contribute topology), **BRIDGE-MIB** for
  MAC tables. All standard, all the same walk this now has.
- Vendor MIBs remain for stack and VSS specifics only — and the CLI already
  gives those (LT-139).
- The FortiGate and FortiSwitch still need one `snmpwalk` to establish what
  they answer. That is the only part still blocked.
**Blocked on:** the same thing as LT-131 — no working credentials for his lab
in this session, and this repo writes parsers against captured output rather
than documentation. An `snmpwalk` of the FortiGate and FortiSwitch, or
credentials, unblocks it.
**Measured 2026-09-13, from this machine:** the FortiGate (`192.168.77.1`,
the default gateway) and the FortiSwitch (`192.168.77.203`) both answer ping
and **neither answers SNMPv3 at all** — no reply within 6s with the lab's v3
user (SHA, AES-256), where the Cisco switch answers the same user. Silence
rather than an authentication report points at SNMP not being enabled or
not permitted on the interface, not at credentials or MIBs. Unblocking needs
SNMP turned on for this host on both boxes; the operator has asked exactly
how.
**Both Fortinet boxes answer, 2026-09-13, once the right pairing was used.**
The operator showed their SNMP configuration. Measured from this machine, the
host both boxes permit:
- **SNMPv2c** with the `public` community: the FortiGate and the FortiSwitch
  both answer. Standard ENTITY-MIB gives each one's model and chassis serial,
  and each classifies correctly (firewall, switch) — no vendor MIB was needed
  for identity.
- **SNMPv3** with the lab user: both accept **SHA-1 + AES-128** and nothing
  else. `examples/snmp_v3_combos.rs` tried every pairing. The earlier
  "silence" was the wrong privacy algorithm (AES-256): a device that cannot
  decrypt a request drops it rather than saying so, which is why it looked
  like SNMP being off.
Serials and addresses are not written here (D-027 spirit: the operator's
own equipment stays on his machine). This unblocks the rest of this item:
the IF-MIB, LLDP-MIB and BRIDGE-MIB walks can now be written against real
answers from these two boxes and the Cisco switch.
**The app's own SNMP path, live, 2026-09-13.** The operator asked that the
SNMP credential rows he set in the app (security level, auth, privacy)
simply work. So a real crawl was run through the same code the app uses:
seeded at the Cisco switch over SSH, with two v3 rows in the order the panel
sends them — SHA + AES-256, then SHA + AES — and no v2c community. The
FortiSwitch was **reached over SNMP and identified as a switch with its
model** from the second row, and the UniFi switch was reached over SNMP too.
The panel's `aes` / `aes 192` / `aes 256` choices map to AES-128/192/256
(`PrivKind::parse`), and every row is tried per device until one answers —
both confirmed in the code.
**The FortiGate was not reached, and that is not SNMP.** It is the switch's
default-route next hop but no switch reports it as a CDP or LLDP neighbour,
so the crawl never visits its address and no credential is ever tried.
Raised as LT-156.
**Second half started 2026-09-13 (after LT-124, in the operator's order):
interfaces, neighbours and MAC tables over SNMP.** Today a device reached only
over SNMP (`identify_over_snmp`) is drawn with no neighbours, no attached
hosts and no port channels — a box with no links. That is the gap.
**Table shapes measured before any parser, structure only (no names,
addresses or MACs recorded):**
- **FortiSwitch, v2c:** IF-MIB `ifName` 32 rows. LLDP-MIB remote table 1
  neighbour, indexed `timeMark.localPortNum.remIndex`. The management-address
  table's index is 8 parts, `…remIndex.addrSubtype.a.b.c.d`, with **no length
  byte** before the address, although the MIB defines one; a reader must
  accept both. `lldpLocPortTable` has 28 rows mapping a local port number to
  a port name. BRIDGE-MIB `dot1dBasePortIfIndex` 29 rows. **Its
  `dot1dTpFdbPort` is not the standard table**: the index is a one-part
  counter, not a six-part MAC. OIDs do advance, so it is not a looping agent,
  but read as specified it yields thousands of rows with no MAC in them. A MAC
  table reader must check the index shape and refuse what does not match,
  rather than trust the table's name. `dot1qTpFdbPort` is empty.
- **FortiGate, v2c:** `ifName` 42 rows; no LLDP or bridge tables, as expected
  for a firewall.
- **UniFi switch:** does not answer v2c `public`, only the v3 user. The
  Cisco is v3 only too. Both are read next through the Rust code, which
  speaks v3: `snmp::walk_table` and `examples/snmp_tables.rs` print shapes
  only. The shared walk now also stops at an OID that does not come after
  the last, since that is how a broken agent spins to the row limit.
**The v3 devices' tables, measured the same way (structure only),
2026-09-13**, through `examples/snmp_tables.rs`:
- **Cisco (v3 SHA + AES-256):** `ifName` 19; `lldpLocPortTable` 13. LLDP
  remote table **4 neighbours**, one with an **empty** `lldpRemSysName`, so
  a name must fall back to the chassis id. The management-address index is
  9 parts for IPv4, **with** the length byte, and 21 parts for IPv6 — against
  the FortiSwitch's 8 without one. `dot1dBasePortIfIndex` 12. `dot1dTpFdbPort`
  **standard**: 17 rows, six-part MAC index — but only the default context,
  which on Cisco is VLAN 1. Other VLANs need a per-VLAN SNMPv3 context.
- **UniFi switch (v3 SHA + AES only; AES-256 is refused):** `ifName` 8. **No
  LLDP-MIB at all**, and no `dot1dBasePortIfIndex`. `dot1dTpFdbPort`
  **standard**, 37 rows; `dot1qTpFdbPort` 16 rows with a seven-part index
  (FDB id, then MAC).
- **FortiSwitch (v3 SHA + AES):** as over v2c — LLDP 1 neighbour, 8-part
  address index; `dot1dTpFdbPort` non-standard again (4,156 rows, one-part
  index), and finite, so the walk ends by itself.
**What a reader has to do**, taken from those shapes: accept a management
address with or without its length byte, and IPv6; name a neighbour by its
chassis id when its system name is empty; read `dot1qTpFdbPort` where
`dot1dTpFdbPort` is sparse; refuse a forwarding row whose index is not a MAC;
and say plainly that a Cisco's MAC table over SNMP covers VLAN 1 only.
**Decoder facts, measured 2026-09-13** (numbers and bitmaps only, nothing
identifying), which set how the tables are read:
- **LLDP subtypes.** Cisco: chassis ids are MAC (4) ×3 and local (7) ×1;
  remote port ids are MAC (3) ×2, interface name (5) ×1 and local (7) ×1.
  FortiSwitch: chassis MAC (4), port interface name (5). So a remote port id
  is rendered by its subtype — a name only when subtype 5 — never assumed to
  be one.
- **Capabilities enabled** came back as `20` (bridge), `00`, `30` (bridge +
  WLAN AP) and `28` (bridge + router), in the RFC 2922 bit order, most
  significant first. These map to the capability words the CLI classifier
  already reads.
- **Local port names.** The local LLDP port id (subtype 5) equals an
  `ifName` for 12 of 13 ports on the Cisco and 28 of 28 on the FortiSwitch,
  so a local port number is named through `lldpLocPortId`.
- **Forwarding ports.** On the Cisco the FDB's port numbers are all bridge
  ports and only 2 of 5 are also ifIndexes, so they must go through
  `dot1dBasePortIfIndex`. The UniFi has no such map, and all 4 of its port
  numbers are ifIndexes. So without a map, a port number is read as an
  ifIndex only when every one of them is a known interface; otherwise the
  table is not guessed at.
**Second half built and proven live, 2026-09-13; this item is done.** A device
reached only over SNMP now brings its links and what is plugged into it,
where before it was a box with no links.
**What shipped:** `crates/coreview-discover/src/snmp_topology.rs`.
- `lldp_neighbors` builds `Neighbor` records from LLDP-MIB the way
  `lldp::parse_lldp_detail` builds them from the CLI: the name from
  `lldpRemSysName`, else the chassis id; a port id rendered by its subtype;
  the port description preferred; the capability bits turned into the words
  `classify` already reads; IPv4 management addresses with or without the
  length byte (IPv6 ignored, as the CLI parser ignores it); and local port
  numbers named through `lldpLocPortId`.
- `fdb_entries` reads `dot1qTpFdbPort` (with its VLAN) and
  `dot1dTpFdbPort`. Port numbers go through `dot1dBasePortIfIndex`, or are
  taken as ifIndexes only when every one of them names a known interface.
  Rows whose index is not a unicast MAC are refused, and so are entries whose
  status is not *learned* and port 0.
- `attached_devices` builds attached hosts as the SSH path does: uplink ports
  (those with an LLDP neighbour) skipped, population per port, and the maker
  from the MAC.
- `read_topology` reads every column over one session with the credential
  that identified the device. In the crawl, `identify_over_snmp` fills
  `neighbors` and `attached`, taking addresses from the same device's ARP
  table. Those neighbours are followed like any other device's, within the
  hop limit and filter. `snmp::walk_table` and `examples/snmp_tables.rs`
  remain for measuring the next vendor's tables the same way.
**Live, from the Cisco over SSH with the operator's two v3 SNMP rows:** 4
reached, 0 failed. The **FortiSwitch, reached over SNMP, reported its LLDP
neighbour** — the Cisco, on its port24 — which is the cable from the
FortiSwitch's own side, never visible before. The **UniFi switch reported
about 36 learned MACs** on four ports, each with its maker, several with an
address from its ARP table. It exposes no LLDP-MIB, so it reports no
neighbours. The FortiGate adds nothing, as a firewall with no such tables.
**How the diagram treats it**, checked in `attached.ts` and `topology.ts`
rather than assumed: nothing attached is drawn unless the operator filters
for it; a MAC seen by two switches is drawn once, on the first sighting,
which is the switch nearest the seed; and *single port only*
(`maxPerPort: 1`) leaves out a crowded port such as the UniFi's uplink.
**Limits, stated rather than guessed around:**
- Over SNMP a Cisco's forwarding table is VLAN 1 only; the others live in
  per-VLAN SNMPv3 contexts, which this does not open. Its SSH path reads
  every VLAN, so this matters only for a Cisco reachable by SNMP alone.
- The FortiSwitch's `dot1dTpFdbPort` is not the standard table and is
  refused, so it contributes neighbours but no attached hosts over SNMP.
- A switch that advertises no LLDP, like the UniFi, cannot have its uplink
  told apart. A MAC seen only by it on a crowded uplink is drawn on that port
  unless *single port only* is ticked. That is the same as for a switch
  reached over SSH that advertises no neighbour.
**Evidence:** 9 tests in `snmp_topology.rs`, built from invented rows in the
measured shapes: a named neighbour linked, classified and addressed; an empty
name falling back to the chassis id; a management address without its length
byte; capability bits; management-address shapes, including IPv6 refused; a
Cisco-style table through the bridge-port map with self, multicast and port-0
rows dropped; the UniFi-style table without a map, with a table that has an
unknown port refused as a whole; a FortiSwitch-style non-MAC index refused;
attached hosts skipping an uplink and counting each port. Plus 2 walk tests
for the advance guard. discover library tests (334) and clippy `-D warnings`
are clean.

### LT-124 — The credential-free identity sources the sweep still does not use — 2026-09-13
**Source:** asked 2026-09-12, checking what LT-121 actually covered —
"did you also use LLMNR (Link-Local Multicast Name Resolution) and following
fallback name-resolution and fingerprinting protocols to ensure 100% asset
tracking without relying on standard DNS".
**Answered plainly at the time:** LT-121 shipped mDNS, NetBIOS, OUI lookup
(MA-L, MA-M and MA-S), this machine's ARP cache and a TCP port scan. It did
not ship the rest. These are the ones that need no credentials:

- **LLMNR — built 2026-09-12, shipped with LT-121.** Tested before it was
  written: unicast to a host's own port 5355 gets nothing from anything,
  including a Windows host; sent to the multicast group `224.0.0.252:5355`
  that same host answers a reverse PTR with `LabDesktop01`. It is preferred
  over NetBIOS, which calls the same machine `LABDESKTOP01` — LLMNR keeps the
  real capitals and is not capped at 15 characters. Only a reply whose source
  is the address being asked about is believed, because on a multicast group
  any machine can answer for any other. Capture committed as a fixture.
- **HTTP banner and TLS certificate scraping.** Ports 80 and 443 are already
  known to be open by the time this would run; the certificate's Common Name
  is often the only name a managed switch or firewall will give up.
- **DHCP option fingerprinting.** Option 55's parameter request list is close
  to unique per OS. Needs to watch for DHCP traffic rather than ask for it,
  which is a different shape from everything else here.
- **The gateway's ARP table, not just this machine's.** LT-121 reads the
  local neighbour table, which only ever holds this segment. Pulling ARP from
  the gateway would name hosts on subnets the sweep is routed to.

**Acceptance:** each one either ships, or says in this entry why it does not,
with the evidence. Nothing is claimed that has not been run against his
network.
**Open:** the HTTP/TLS, DHCP and gateway-ARP thirds. LLMNR is done.
**Picked up 2026-09-13, in the order the operator set (after LT-125).**
**What the lab's devices actually present on 443**, captured read-only
before building anything, with names and serials kept off this page:
- **The Cisco switch** presents a self-signed certificate whose CN is its
  full hostname and whose subject carries its **chassis serial**
  (`serialNumber` attribute), and it negotiates **TLS 1.0 only**.
- **The FortiSwitch** presents Fortinet's factory certificate: CN is its
  **serial**, O is `Fortinet`, OU is `FortiSwitch`, over TLS 1.3.
- **The FortiGate** does not answer HTTPS on 443 from this segment.
**What that changes in the design:**
- A certificate is not only a name. Depending on the vendor it gives a
  hostname, a serial or a product family, so each is kept as what it is:
  a CN that is plainly a serial is not shown as a hostname.
- **rustls cannot talk to the Cisco** — it has never supported TLS 1.0/1.1.
  In TLS 1.0 to 1.2 the server's Certificate message is sent in the clear,
  so for those the certificate is read straight from the handshake after a
  ClientHello, with nothing completed or sent afterwards. TLS 1.3 encrypts
  it, so that path uses the rustls connector the probe crate already has.
- The subject is read from DER by a small reader written for the attributes
  that matter (CN, O, OU, serialNumber, and subjectAltName DNS names), tested
  against **generated certificates in the same shapes with invented names**
  (D-027), not against the lab's real ones.
- HTTP banners, DHCP fingerprinting and the gateway's ARP table are the other
  thirds of this item and come after the certificate path.
**Certificate names built and proven live, 2026-09-13** — the first of this
item's three remaining parts. Not the whole item: HTTP banners, DHCP
fingerprinting and the gateway's ARP table are still open, so this stays
in Now.
**What shipped:**
- `crates/coreview-probe/src/cert.rs` reads a certificate's subject (CN, O,
  OU, serialNumber) and subjectAltName DNS names from DER. `host_name()`
  refuses a CN that reads as a serial, an address or `localhost`;
  `device_serial()` returns the serialNumber attribute, else a serial-shaped
  CN.
- `crates/coreview-probe/src/certfetch.rs` fetches the certificate two ways:
  rustls first (TLS 1.2/1.3, reusing the probe crate's accept-any verifier),
  else a ClientHello whose reply is read in the clear as far as the
  Certificate message (TLS 1.0–1.2), which is what rustls cannot do.
- The sweep reads it only for a host whose port scan found 443 or 8443
  open, within 1.5s. A name from it is used only when DNS, LLMNR, NetBIOS
  and mDNS gave none (new `NameSource::Certificate`). Each result carries
  `serial` and `product` (organisation and unit, OpenSSL placeholder
  organisations ignored).
- The sweep table shows the source in the name tooltip, and the product in
  Model when the diagram has no model. Adding a host writes its serial;
  re-sweeping fills a serial only where there is none (`sweepPatch`).
**Live, from this machine, with the real sweep code:** the Cisco switch, which
had no name in any earlier sweep, is now **named from its certificate and
carries its chassis serial**. It was read over TLS 1.0 through the in-the-clear
path. The FortiSwitch carries **its serial and `Fortinet FortiSwitch`**, read
over TLS 1.3 through rustls, and correctly gets no hostname because its CN is
the serial. The FortiGate serves no HTTPS on 443 here and is unchanged.
**Evidence:** 6 tests in `cert.rs`, against generated certificates in the two
lab shapes with invented identities, including every truncation of one never
panicking. 7 in `certfetch.rs`: TLS 1.0 and 1.2 flights captured from local
OpenSSL servers presenting an invented certificate; a flight arriving in
pieces never yields a partial certificate; alerts; the ClientHello's shape.
There is also a test that reads a real captured flight only when
`COREVIEW_TLS_FLIGHT` points at one. It passed against the Cisco's
handshake, which stays on this machine and is not committed (D-027). The
fixtures were scanned for real names, serials, domains and addresses before
being added; none. The sweep's wire-format tests cover `serial`, `product`
and the `certificate` name source. `e2e/discover.mjs` grew 4 checks, 33 in
all, all passing, and `e2e/join.mjs` passes. probe crate tests (121), vitest
(649), tsc and eslint are clean. Clippy twice rejected the BMP-string pairing
(`is_multiple_of`, then `as_chunks`), both needing a newer compiler than the
workspace targets; it now steps through the bytes, and `examples/sweep_subnet`
prints serial and product.
**HTTP banners built and proven live, 2026-09-13** — the second part. The
gateway's ARP table and DHCP fingerprinting remain, so this item stays in
Now.
**Measured first, and the measurement set the scope.** Every lab host
serving plain HTTP was asked for `/`, printing only the status line, header
names, the `Server` value and whether a `<title>` existed. Of six, **none
named itself**: a Cisco switch sent `401` with `Server: cisco-IOS`, a Windows
host `Microsoft-IIS/10.0` over its default "IIS Windows" page, three reverse
proxies `Caddy` with a redirect to HTTPS, and a NAS a blank `Server:` header
with no title. All were HTTP/1.1, and header names came in mixed case. So a
banner is reported for what it is — the web server's software — and is
**never used as a device name**.
**What shipped:** `crates/coreview-probe/src/banner.rs` parses the `Server`
header, case-insensitive, with a blank value treated as none, and a page title
only when it is not a web server's default page (a short list: IIS, nginx,
Apache, bare status pages). Values are collapsed, stripped of control
characters and capped. The sweep reads it for a host whose scan found 80 or
8080 open (not 8006, whose port already says Proxmox), **at the same time as**
the certificate read, so neither adds to the other's wait. Each result carries
`webServer` and `webTitle`. The sweep table shows them in the tooltip on the
80/8080 port chip, not in Name or Model, where `cisco-IOS` would pass for
something it is not. `http.rs` shares `request_line` and `read_capped` rather
than a second HTTP reader being written.
**Live, same run:** the Cisco switch reported `cisco-IOS`; the Windows host
`Microsoft-IIS/10.0`, its default title dropped; the three proxies `Caddy`;
the NAS nothing — exactly what the captures showed.
**Evidence:** 7 tests in `banner.rs` on the observed shapes rebuilt with no lab
identities (a 401 with a Server header; a default title dropped; a blank
Server and no title giving no banner; a real title kept and decoded;
non-HTTP refused; a reply cut off mid-headers; capping and control
characters). The wire-format tests cover the two new fields;
`e2e/discover.mjs` grew 3 checks, 36 in all, all passing (the web chip
names the software, other chips do not, and the Name cell never carries
it), and `e2e/join.mjs` passes. probe crate tests (128), vitest (649), tsc
and eslint are clean. Clippy's `large_enum_variant` on `SweepEvent` is
allowed with its reason recorded at the enum: events are sent singly and
never stored in bulk.
**Operator's decisions on the last two parts, 2026-09-13**, asked with a
recommendation each:
- **The gateway's ARP table: build it as an optional step.** Off unless
  an SNMP credential is picked; after a sweep it reads only the default
  gateway's ARP table over SNMP, with credentials already saved, and fills
  MAC and manufacturer for routed hosts. The sweep itself stays
  credential-free: `coreview-probe` gains no credentials and no dependency on
  `coreview-discover`, which owns SNMP and the vault.
- **DHCP fingerprinting: not built.** Declined on the recommendation, for
  these reasons: it is passive capture, which needs elevated rights or a
  packet-capture driver (on Windows, both); it sees only devices that happen
  to renew a lease while it listens, so an on-demand sweep would mostly
  catch nothing; and the certificate, banner and ARP paths already cover the
  switches, firewalls and routed hosts it would have been for. This is
  recorded as not shipping, per this item's own acceptance: "each one either
  ships, or says in this entry why it does not".
**Gateway ARP built and proven live, 2026-09-13 — the last part; this item is
done.** Certificates, banners and the gateway's ARP table shipped, and DHCP
fingerprinting was declined by the operator with the reasons above.
**What shipped:** `snmp::arp_table` in `coreview-discover` walks
ipNetToMediaPhysAddress (RFC 1213), the table a live walk of the lab FortiGate
showed populated (`ifIndex.a.b.c.d`, 6-byte MACs; its RFC 4293 table was
empty), with a row limit of its own (16,384) because a router's table is
larger than ENTITY-MIB's. The first request is made directly, so a wrong v3
user or algorithm is reported rather than read as an empty table. Session setup
moved out of `identify` into `open_session`, shared by both, and walked values
keep raw bytes so a binary MAC survives. The Tauri command `read_gateway_arp`
takes a saved SNMP credential's id, never a password, and adds the
manufacturer. In the ping sweep panel, **MAC addresses behind a router** does
nothing until a saved SNMP credential is picked and the button pressed. Its
gateway starts as the swept subnet's first address, because nothing reads the
machine's own routes and a per-OS route parser could not be captured here.
Hosts with no MAC get the gateway's, with the source in the tooltip; a MAC the
sweep had is never replaced. `coreview-probe` gained no credentials and no
dependency on `coreview-discover`.
**Live:** the FortiGate's table read over v2c and over v3 (SHA + AES) through
the new function — every row a valid IPv4 address and MAC — and the Cisco's
over v3 with AES-256.
**A stack overflow found on the way, and its real cause.** After the session
refactor, identifying the Cisco over v3 AES-256 crashed with a stack overflow.
It was measured rather than guessed, with an app-like runner (the work spawned
as a task on a tokio worker with a set stack, which is how a Tauri command
runs):
- **Release builds, as the installers are, were fine** on a 2 MiB worker, so
  nothing shipped was at risk.
- **The code before the refactor overflowed too**, on a 2 MiB worker in a
  debug build. So this predated LT-124: `tauri dev` would have crashed the
  first time a crawl used SNMP. The refactor only made it reach the larger main
  thread as well.
- **The cause is in `snmp2`:** unless its `heap_buffers` feature is on, every
  session carries its receive buffer and its send PDU buffer inline, 65,507
  bytes each (about 131 KB), and a debug build copies futures holding that
  around the stack. The feature moves both to the heap. With it, identification
  and ARP reads over v2c and v3 pass on a 2 MiB **and a 1 MiB** debug worker.
  The session-setup future is also boxed, which keeps callers' futures small.
The first try at the runner (block_on on a small thread) was stricter than the
app and was replaced before any conclusion was drawn from it.
**Real serials removed from source (D-027 spirit).** The pre-commit scan caught
the lab switches' real serials in a new test. A wider search then found the
Cisco's chassis serial in older front-end tests and a doc comment, the
FortiSwitch's in a captured FortiOS fixture and an ARP test, and a power supply
serial in an SNMP doc comment. All were replaced with invented same-length
values (`FOC0000TEST`, `S000TESTSERIAL00`), and every affected test still
asserts the same thing.
**Evidence:** 3 ARP-row tests (they caught a parser that accepted a non-numeric
interface index; the parser was fixed, not the test); 2 gateway-guess tests;
`e2e/discover.mjs` grew 8 checks, 44 in all, all passing (only SNMP
credentials offered, gateway prefilled, nothing sent until a credential is
chosen, the exact arguments, a routed host gaining MAC and manufacturer, a
known MAC untouched, the summary). The first run caught a duplicated variable
name in the harness. discover library tests (323), vitest (651), tsc, eslint
and clippy `-D warnings` are clean.

### LT-156 — The crawl never visits the default gateway — 2026-09-13
**Source:** found 2026-09-13 in a live crawl run to prove the operator's SNMP
rows work — "for SNMP the app is setup right we set the security levels, I
like for that to work please".
**What happens.** The crawl walks from the seed into whatever CDP and LLDP
report. A firewall that speaks neither — the FortiGate at the edge of his lab
— is never reported, so it is never visited: no SSH attempt, no SNMP attempt,
not even a "seen but not visited" line. Yet the crawl already *knows* the
address: LT-131 reads the switch's default route, and it printed
`default route -> <gateway>` in the same run. The device at the top of the
diagram is the one discovery misses.
**Wanted:** a device's default-route next hop is visited like a neighbour
when it is inside the subnets the crawl is allowed into, so the gateway is
tried over SSH and then over each SNMP row, like everything else.
**Acceptance:** crawl the lab from the Cisco switch with the operator's SNMP
rows and the FortiGate is reached and identified. It is not added when it
falls outside the allowed subnets. Built after LT-125, ahead of LT-124, at
the operator's request that SNMP work.
**Done 2026-09-13.** A reached device's default-route next hop is queued
like a neighbour. `gateway_to_visit` in `crawl.rs` decides: within the hop
limit, not already tried, and allowed by the new
`DiscoveryFilter::allows_address`. That applies the same subnet rules as a
neighbour, with an excluded subnet always winning and no class check,
because a default gateway is infrastructure by definition. The gateway is
then tried like everything else: SSH, then each SNMP credential in turn.
**Live, against the operator's lab:** the same crawl that missed it — seeded
at the Cisco switch over SSH, with his two v3 SNMP rows in order
(SHA + AES-256, then SHA + AES) and no v2c — now reports **4 reached, 0
failed**. The FortiGate is **reached over SNMP and identified as a firewall
with its model**, alongside the FortiSwitch and the UniFi switch, also over
SNMP. That is the operator's request, "for SNMP the app is setup right we
set the security levels, I like for that to work", met end to end through
the app's own crawl code.
**How it was tested, including what did not work:** a fake-network
integration test was written first, with a switch whose default route pointed
at an unadvertised fake device. It could not work. Fake devices must listen
on 127.0.0.x, and `parse_default_route` deliberately rejects a loopback next
hop, a rule with its own test that is right for real networks and was not
loosened to suit a fixture. The test failed at its guard ("the switch's
default route was read", `None`), and its companion passed without testing
anything, so both were removed rather than kept. The decision is covered
instead by 4 unit tests in `crawl.rs` (queued like a neighbour; no route;
outside or excluded subnets; hop limit and visited set) and 1 in `filter.rs`,
plus the live run above. The 11 existing fake-network crawl tests are
unchanged and still find exactly three devices. cargo test (320 in the crate
library) and clippy `-D warnings` are clean; clippy first caught a test that
set a field after `Default::default()`, since rewritten as a struct literal.

### LT-155 — **bug** A sweep overwrites what the crawl recorded about a device — 2026-09-13
**Source:** found 2026-09-13 while starting LT-125, not reported.
**What happens.** When a swept host is already on the diagram,
`DiscoverPanel.addPicked` writes `discoveredVia: 'Ping sweep'` over whatever
was there. A switch the crawl logged into then reads "Ping sweep" in the
inspector and the CSV, and the record of *how it was really found* — the
provenance LT-146 added so an operator can judge which fields to trust — is
gone. It also writes the sweep's `hostname` over one the device reported
itself, replacing a name from an SSH login with a weaker one from mDNS or
NetBIOS.
**Acceptance:** sweeping a device the crawl already drew leaves its
`discoveredVia` and its hostname as the crawl wrote them, and still adds what
the sweep newly proved (open ports, and a MAC or manufacturer it lacked).
Reproduced by a check that fails before the fix (D-020).
**Fixed 2026-09-13.** `sweepPatch` in `src/lib/sweepKnown.ts` decides what a
sweep writes onto a device that is already drawn. It always writes the open
ports it proved, fills a MAC, manufacturer or hostname only where the device
has none, and claims `discoveredVia` only for a device nothing else has
claimed.
**Reproduced first (D-020):** `e2e/discover.mjs` seeds a switch the crawl
recorded as "SSH login", adds it from a sweep, and reads it back. Before the
fix it came back `"via":"Ping sweep"`; after it, "SSH login", with its label,
model and hostname intact and the sweep's open ports added. 4 unit tests
cover the rule: provenance and device-given name kept; only gaps filled; an
unclaimed device claimed; existing ports untouched when a sweep found none.

### LT-125 — Name a swept host from what the crawler already knows — 2026-09-13
**Source:** the same 2026-09-12 message, the credentialed half of the list —
SNMP `sysName`, WMI/WinRM/SSH agentless hostname checks, and "LLDP / CDP
Table Parsing: Read core switch port maps to resolve adjacent device
identities".
**Why this is its own item:** all three need credentials, and all three are
already implemented in `crates/coreview-discover` for the crawler. The work
is not new protocol code — it is that a ping sweep and a crawl currently know
nothing about each other, so a host the crawler can name is still a dash in
the sweep's table.
**Acceptance:** where a crawl has run, a sweep of the same network shows the
names, models and ports the crawl learned, rather than re-deriving them.
**Done 2026-09-13.** The ping sweep's results table now shows what the
diagram — and so any crawl that drew it — already knows about each host. It
looks every row up with the same multi-key identity the crawl uses
(`findDrawnNode`: MAC, then address, then name), across **every page**.
- **Name:** where the network gave no name, the diagram's name is shown,
  and its tooltip says it came from the diagram and how the crawl found the
  device ("found by SSH login"). Where the network did name it and the
  diagram calls it something else, both show: `LabDesktop01 · on diagram as
  DESK-PC-1`.
- **Model** and **Switch port**, new columns, from the crawl. The model's
  tooltip carries the serial and software version. A host the crawl never saw
  shows dashes, not guesses.
What differs from the wording, and why: **the source is the diagram, not the
crawl panel.** Crawl results live only in that panel's memory and are gone
after a restart or a tab change, while what was drawn is saved with the
project, so the diagram is the only place a sweep next week can learn from.
The acceptance's "where a crawl has run" therefore reads as "where a crawl
drew it".
Built as `src/lib/sweepKnown.ts` (`knownOnDiagram`) and wired into
`DiscoverPanel.tsx`.
**Evidence:** 3 unit tests (found by address with the crawl's fields; found by
MAC under another label with its switch port; nothing for an undrawn host);
`e2e/discover.mjs` grew 13 checks, 29 in all, all passing, against the real
captured sweep rows plus a seeded crawled switch and a MAC-matched desktop.
All 9 new checks failed before the change. One older check compared the
whole Name cell to `LabDesktop01`; it now compares the name part exactly,
because the cell legitimately carries the diagram label after it.
`e2e/join.mjs` still passes. vitest (648), tsc, eslint and clippy are clean.

### LT-110 — Import a Visio drawing as a topology, not as pictures — 2026-09-13
**Source:** asked 2026-09-08 — "do I have the option to import .vsdx
diagrams? would it be possible to import and fully utilize the already on
the diagrams line ip address, ports devices names and fill that on coreview
fileds? how do we make that working at 100% I have enought digrams to import
and test."
**Where it stands today:** no. Import accepts `.coreview`/`.json` and `.csv`
only. A Visio file *can* be read, but only through `shapeconv`'s libvisio
path, which renders it to SVG — the drawing arrives as **artwork for the
shape library**, with every device, address and port flattened into a
picture. Nothing reads a `.vsdx` into devices and links.
**Why it is tractable:** `.vsdx` is OPC — plain XML in a ZIP, and `zip` is
already a dependency. Confirmed by unpacking `fixtures/blue-box.vsdx`:
`visio/pages/page1.xml` holds `<Shape ID=…>` with `<Cell N='PinX'…>`
geometry in readable XML. More to the point, this app's own Visio *exporter*
already writes the exact structure an importer has to read — `<Text>` on
shapes for the device name, `<Text>` on connectors for the port label, and a
`<Connects>` section gluing `FromSheet`/`ToSheet` — with tests asserting all
three. The importer is close to the inverse of code that already exists.
**Where the real work is — mapping text to fields.** The structure gives
devices and which-connects-to-what; it does not say which string is an
address and which is an interface. Planned in order of reliability:
1. **Shape Data** (`<Section N='Property'>`) — if the diagrams carry
   properties, this is exact rather than guessed, and is the first thing to
   look for in the operator's real files.
2. **IPv4 regex** — reliable.
3. **Interface names** (`Gi1/0/1`, `Te1/0/48`, `Po10`, `xe-0/0/0`) — the app
   already recognises these in `coreview-discover` for LLDP/CDP, so the
   knowledge exists and should be reused rather than rewritten.
4. **Whatever is left** → device name.
**Why "100%" is not a promise anyone can make**, and what it depends on:
- **Glued vs drawn-near connectors.** A glued connector produces a
  `<Connect>` entry and the link is certain. A line merely lying near two
  shapes produces nothing, and the link has to be inferred from geometry —
  a guess, and one that should be shown as a guess rather than asserted.
- **`.vsdx` vs `.vsd`.** `.vsdx` is XML and fully parseable. `.vsd` is the
  pre-2013 binary format; libvisio can only render it to SVG, which loses
  exactly the structure this needs. Old drawings may have to be re-saved.
- **House style.** How a team writes an address next to a port is a
  convention, not a standard.
So the honest target is not "100% of any Visio file" but "100% of the
operator's own diagrams, whose conventions can be read off real examples and
fitted" — with anything uncertain surfaced for review rather than quietly
drawn, the same rule `ChangeReport` already applies to a re-crawl.
**Real drawings were made available to develop against 2026-09-08**, and a
throwaway prototype run over them. They are not kept in this repository and
nothing identifying is recorded here — not a filename, not a device name, not
an address. What they taught us about the *format* is what matters, and that
is all that follows.

Four families showed up, spanning roughly 60 to 1400 shapes each: a
Lucidchart export with **zero** `<Connect>` entries, a Visio-native drawing
with custom connector Shape Data across eighteen pages, a Visio-native
drawing built from Cisco stencils, and one whose page XML is UTF-16.

Five findings that change the design:

1. **Not all page XML is UTF-8.** One producer writes UTF-16, with no BOM
   assumptions worth making. A reader that assumes UTF-8 sees an empty
   document and reports "0 shapes" — which is exactly what the first pass of
   this analysis did, silently. Encoding must be detected, not assumed.
2. **Lucidchart exports do not glue anything.** They use `com.lucidchart.*`
   masters with `com.lucidchart.Line`, and zero `<Connect>` entries — so
   there is no authoritative link data at all and endpoints have to be
   inferred from line geometry. This is the hard family.
3. **Where Shape Data exists it is better than any heuristic.** One drawing
   carries `Port_A_Port_Name`, `Port_B_Port_Name`, `Port_A_IP_Address` and
   `Port_B_CableID` on the connector — that is Coreview's link model already
   filled in. Another carries device inventory: Manufacturer, Part Number,
   Product Description, Room.
4. **The master name is the device type, and often the model.** `ASA 5500`,
   `Workgroup switch`, `N9K-C93180YC-EX Front`, `WS-C4500X-16SFP+ Front`,
   `C9500-48Y4C Front`, `L3 Switch` — Visio stencil names, not anybody's
   equipment. That maps onto `deviceType` and fills `model` for free.
5. **The caption is usually a separate shape, not the icon's own text.** An
   icon with no `<Text>` sits next to a text block holding something of the
   form `_ACCESS_SW01 192.0.2.20`. So association is geometric — and the
   first naive attempt grabbed the *port* label instead, because a port label
   is often nearer. Classifying text (an interface name is not a device name)
   before choosing fixed it.

**Prototype result, one rough pass, no tuning:** between 0 and 77 links per
drawing, 46–100% of them with both ends named, 37–85% of devices with an
address, and **0–16% with a port**. Ports read near zero only because port
labels are separate shapes near the connector's ends and the prototype only
looked at connector text — the same proximity trick that fixed captions
applies, it just was not written yet. The drawing with zero links is the
Lucidchart one, which carries no link data to find.
**Acceptance, restated honestly:** near-complete for glued Visio-native
drawings; best-effort with everything uncertain flagged for review for
Lucidchart exports, which carry no link data to be complete *from*.
**Built 2026-09-08 — glued Visio-native path, end to end.**
`src-tauri/src/visio_import.rs` reads the ZIP directly with `roxmltree`
(already in the tree, so no new download), an `import_visio` command wraps
it, and a **From Visio** tab beside From CSV previews the result before
anything is drawn — the same rule the crawl follows, since an import that
quietly gets an address wrong is worse than one that says what it is unsure
about. Adding puts one Coreview page per Visio page, converts Visio's
bottom-left inches to top-left pixels, and optionally creates a check per
addressed device. Shape Data is carried across: Manufacturer to vendor,
Room to rack, the rest to notes.
**Measured against a real drawing, in the running app:** 34 devices and 54
links, 28 named, 18 with an address, **51 of 54 links with a port** (from 7
before the pair-label matching was written), and device types and models read
straight off the Visio masters.
**Two decisions worth keeping:**
- *Port pairs are matched by distance to the connector's line, not to its
  midpoint.* The label belongs to the run, and a long connector can carry
  its label near one end. This one change took ports from 40/54 to 51/54.
- *An address jammed against a name is not read.* A caption of the form
  `vpn01192.0.2.50` is ambiguous — `vpn01`+`192.0.2.50` and
  `vpn011`+`92.0.2.50` are both readings, and nothing decides between them.
  An imported address becomes a monitoring target, so a wrong one is far
  worse than a missing one: it would check the wrong host and report green
  for a device that is down. A test asserts nothing is taken.
**Rebuilt 2026-09-08 after the operator tested it on a real drawing.** The
verdict was blunt and correct: "the names are incorrect! and missing info /
the diagram doesn't look the same as the visio / it needs a lot more work to
make it useful." Five defects, each found by measuring against a real file
rather than by reading the code:

1. **A port-pair caption was being used as a device name.** `could_be_a_name`
   now rejects anything reading as a port or a port pair, so a router keeps
   its own name instead of arriving called `Gi0/0/2 <> Gi1/0/13`.
2. **Connectors glued at only one end were dropped.** In the drawing tested,
   two thirds are glued at one end and four at neither. Each end now resolves
   independently — glue where it exists, nearest device where it does not —
   which recovered the carrier uplinks that had gone missing, with the
   router's interface on the router and the switch's on the switch.
3. **Rack-mounted equipment was being read as lines.** This was the big one.
   Cisco's rack-unit stencils are *1-D shapes* — a `N9K-C93180YC-EX Front`
   carries `BeginX`/`EndX` so it snaps into a rack frame, exactly as a
   connector does. Asking only "does it have begin/end?" threw away fourteen
   devices: all four Nexus 9000s, both Catalyst 4500Xs, both N2K fabric
   extenders, the UCS chassis, the HyperFlex node, both fabric interconnects
   and two storage arrays. What actually separates them is what the box
   *means*: on a connector Visio writes `Width` as the formula
   `GUARD(EndX-BeginX)`, so the box **is** the run. That plus a master named
   "connector" identifies all seventy connectors and misses none of the
   thirty-seven devices. Glue is a third signal but needs care — a `6324 FI`
   is glued into its own chassis at both ends, so only glue joining two
   *different* shapes counts.
4. **Devices that were never a connector endpoint were not imported at all.**
   Any shape from a named master that is not a connector and not a text block
   is now a device, joined or not.
5. **One caption could name two devices.** Assigning per device in id order
   let a device take a caption that belonged to its neighbour. Every
   candidate pairing is now ordered by distance and taken shortest-first, and
   distance is measured to the shape's *box* rather than its centre — a rack
   unit is two inches wide, so its own caption is nowhere near its middle.

**Measured on the same drawing, before → after:** 34 devices → **37**, which
is exactly how many device shapes the file contains; 54 links → **70**,
exactly how many `Dynamic connector` shapes it contains; 51 → **62** with a
port. The core switches, the distribution pair and the storage and compute
nodes all arrive now and did not before.

**Layout fidelity**, the other half of "doesn't look the same"
(`src/lib/visioLayout.ts`): Visio's pin is the shape's *centre*, not its
top-left, and shapes are not all one size. Placement now uses the centre and
the drawing's own width and height, and the scale is taken from the drawing
rather than fixed at 96 px to the inch — enough that its flattest shape stays
legible, so four switches stacked 0.185in apart in a rack come out stacked
rather than piled.

**Three things the operator asked for while this was being built,** all
built: the preview is now **editable** — rename a device, correct an address,
change its type, fix which devices a link joins, correct a port, remove what
does not belong, add what the drawing left out — because a preview you can
only accept or reject is not much of a decision, and some of what is read out
of a picture will be wrong however carefully it is read. **Line colours are
imported**: the drawing tested uses six, and an operator who drew the carrier
circuits orange meant something by it. And the port pair is written on the
line as a **centre label** (`Gi0/1 <> Eth1/4`) as well as being split across
the two ends.

**Verified live, end to end:** imported into a clean project in the running
app — 37 devices, 70 links, 107 monitored objects, coloured lines, port
labels at each end and the pair on the line, and the rack at the foot of the
drawing sitting where the drawing puts it.

**Still open:** the Lucidchart/geometric path (no `<Connect>` data at all);
a device the drawing never captions still falls back to its master name (in
the drawing tested, eight of thirty-seven); and a run-together address is
still left unread, for the reason above. Both are correctable in the preview.
**On test data:** no real drawing is kept in this repository and nothing
identifying one is written down — not a filename, not a device name, not an
address. The test that reads a real file takes a folder from
`COREVIEW_VISIO_DIR`, asserts only what must hold for *any* drawing, prints
counts rather than names, and skips everywhere that variable is unset,
including CI. Everything else is synthetic XML using documentation addresses
(RFC 5737).
**Closed 2026-09-13; the Lucidchart path is declined.** The operator, on the
remaining work: "LT-110: Lucidchart-exported Visio files, which have no glued
connectors. don't do it we don't want this". What shipped stays: glued
Visio-native drawings import as devices and links, with an editable preview.
**Not being built:** inferring links from line geometry for Lucidchart
exports, which carry no `<Connect>` data. Uncaptioned devices falling back to
their master name, and run-together addresses left unread, remain as they are
and are correctable in the preview. Reopen under a new ID if that changes;
this one is not renumbered.

### LT-148 — A stack is visible in the app, ready to test on hardware — 2026-09-12
**Source:** asked 2026-09-12 — "Also 136 and 139 deployed them ans push them i
will test them when we have a the test environment".
**What is already there and what is not.** LT-139 built the parsers and wired
them into the crawl, so `CrawledDevice.stack` is populated; LT-140 splits a
chassis pair into two nodes with the inter-switch link between them. **But
nothing shows any of it.** A stack's members, their serials, their roles and
the `unverified` flag all arrive and are dropped on the floor — so when he
points this at a real stack there is nothing to look at and no way to tell
whether the parser got it right.
**That makes this the deploy step**, not a new feature: carry what is already
collected through to somewhere a person can see it.
**Wanted:**
- The member list on the device — each member's number, role and **serial**,
  which is what an RMA is keyed on and the reason he asked for serials twice.
- The kind, said plainly: a stack, or a chassis pair, and how many members.
- **The `unverified` flag surfaced**, because every one of these parsers was
  written from vendor documentation (D-026) and has met no hardware. The
  interface must not present a guess as a fact.
- In the CSV, so a stack can be profiled like anything else (LT-147).
**Acceptance:** crawl a stack and the device shows its members and their
serials, says which technology holds them together, and says the reading is
unverified until a parser has met real hardware.
**Done 2026-09-12.** Three fields on a device — `stackKind`, `stackMembers`
(one line per member: number, role, serial) and `stackUnverified`. The crawl
writes them, the inspector shows them in a section that only appears for a
device that reported one, and the CSV carries them so a stack profiles like
anything else.
**The unverified flag is shown as a hint on the field**, not buried: every one
of these parsers was written from vendor documentation (D-026) and has met no
hardware, so the panel says "read by a parser that has not yet met this
hardware — check it against the device" rather than presenting a guess as a
fact. That is what makes this testable the moment he has a stack in front of
him.
**Six tests**, including that a device which is one box — most of them — gets
no stack fields at all, because an empty badge on every switch would be worse
than no badge.
*Moved from Now to Done 2026-09-13: it was finished on 2026-09-12 and left in
the wrong section.*

### LT-138 — An upgrade must not touch what is on the machine — 2026-09-13
**Source:** asked 2026-09-12 — "well when I download the installer it should
have no saved creds , but if I put my creds I want it saved on my machine
where the app is installed even after upgrade it shouldn't get wiped and all
my data should remin on my local machine app directory and db".
**Where it stood.** There is one store and it is in the right place:
`%LOCALAPPDATA%\Coreview\coreview.db` on Windows, the XDG data directory
elsewhere. Projects, settings **and the credential vault** are all tables in
that one file, and it sits outside the install directory, so replacing the
program cannot replace the data. A fresh installer ships empty by definition.
Whether Tauri's NSIS uninstaller, run as part of an upgrade, leaves
`%LOCALAPPDATA%` alone is a property of the generated installer, and could
not be checked from the Linux machine this is developed on.
**Acceptance:** the data directory is pinned by a test so a refactor cannot
move it silently; and an install-upgrade-check cycle on Windows is run and the
result written down here, rather than assumed.
**Done 2026-09-13.** Both halves:
- **Pinned by tests (2026-09-12).** `the_data_directory_is_not_inside_the_program`
  asserts the store is the app's own `%LOCALAPPDATA%` folder and not under the
  running executable. `the_vault_lives_in_the_same_database` asserts
  `projects`, `app_settings`, `credentials`, `vault_header` and `host_keys`
  are all tables in that one file.
- **Confirmed on Windows by the operator, 2026-09-13**, on a real install and
  upgrade: "this is confirmed working LT-138: a Windows install-then-upgrade
  test". The run was his, not this assistant's; it is recorded here as
  his confirmation rather than as a result observed from this machine.

### LT-154 — Collect in an order, in groups — 2026-09-13
**Source:** the same planning, 2026-09-13.
**The shape:** a collection plan runs in a sequence — edge first, then the
switches behind it, then firewalls — and stops to look between groups. Backups
today are one flat selection. Ordered groups, run one after another, with the
option to pause between them.
**Acceptance:** groups run in the order given and a failure in one is visible
before the next starts.
**Done 2026-09-13.** **Collect in groups** in the Backups tab. Each group has a
name, roles and tags, and ↑/↓ reorder the groups. A selected device joins the
**first** group it matches, so no device is collected twice. Anything
unmatched goes last, in *Everything else*, and groups left empty are skipped.
The device table gains a *Group* column. Back up runs the first group; when its
finished event arrives, the next starts. **Pause between groups** and **Stop
when a group has a failure** are both on by default. Either one stops with
the reason ("Switches had 1 failure") and **Continue with …** / **Stop here**
buttons, and the failure is already in the results. A progress list shows
every group as Waiting, Running, Done (with counts) or Not run. Stop cancels
the running group and marks the rest Not run. With no groups, a backup
behaves exactly as before. Groups are one allow-listed setting,
`backupGroups`, and none ship built in.
What differs from the wording, and why:
- **Groups are defined by role and tag, not by picking devices into lists.**
  It uses the matcher command sets use (now `matchesRoleOrTag`, shared), so a
  device added to the diagram tomorrow lands in the right group by its role.
- **Every group shares the run's one stamp.** An ordered collection is still
  a single run to Before and after (LT-152) and to Checks (LT-153).
- **Stop on failure** was added beside the pause, so a collection can run
  straight through when it is clean and still stop where it is not. That is
  what makes "visible before the next starts" hold even without pausing.
- **The form is locked while paused.** The plan is a snapshot taken at Back
  up, so editing the form mid-collection would change nothing and would look
  as if it had.
No backend change beyond the setting: sequencing is in the panel, over the
`start_backup` path that is already proven live.
**Bugs found and fixed on the way (D-020: each failed its check first):**
- **A repeated finished event launched two groups at once.** The first guard
  (`inFlight`) was re-armed by launching the next group, so a duplicate got
  through. `e2e/groups.mjs` failed with calls
  `[…,["LAB-SW-A"],["LAB-RTR-B"],["LAB-FW-C"]]` where one fewer was expected.
  Now only the backend's own *started* event arms a group, and `run_backups`
  always sends it before *finished*, so a stray finished is ignored — without
  unlocking the form under the group that is running.
- **The backup listener could leak.** If the panel unmounted before `listen`
  resolved, the listener was never removed, and every later event arrived
  twice. That is exactly the duplicate above, and it predates this item. The
  cleanup now removes a late-resolving listener.
**Evidence:** `src/lib/collectionGroups.test.ts`, 6 tests (no groups is one
step; list order then everything else, with empty groups dropped; first match
wins; reordering; the stored setting; an empty new group); `commandSets` tests
still 7/7 after the matcher moved. `e2e/groups.mjs`, 32 checks, all passing.
They cover: only the first group starts; the pause and its reason; the failure
visible in results before anything else starts; Stop here runs nothing more;
every group sharing one stamp; a reorder changing what runs first; running
straight through without pausing; a duplicate finished ignored; Stop mid-group;
the groups remembered in order; a backend refusal stopping cleanly. The
showcommands, beforeafter and checks harnesses still pass; vitest (641), tsc,
eslint and clippy are clean. **Not run against the switch:** the sequencing
drives the same `start_backup` that LT-149 to LT-151 exercised live, and a
headless browser cannot open SSH.
**Confirmed by the operator in the app, 2026-09-13:** "The new Backups tab
features. tested good".

### LT-153 — Checks that say pass or fail against captured output — 2026-09-13
**Source:** the same planning, 2026-09-13.
**The shape:** a checklist asks questions of the output — is this route
present, is this neighbour up, does this value match the documented one. Today
a person reads the file. A **check** is a command plus an expectation (contains,
does not contain, matches) that turns a capture into pass/fail with the line
that decided it.
**Acceptance:** a check run against a capture reports pass or fail and quotes
the evidence. No check ships pre-filled from any real project (D-027).
**Done 2026-09-13.** **Checks** in the Backups tab. Each check has a name, a
command, an expectation (*contains*, *does not contain*, *matches*, *does not
match*), the text or pattern, and *ignore case*. Pick a run with show
commands and **Run checks**. Every device with a show-command capture in that
run gets a row per check: **Pass**, **Fail**, **Not accepted** (the device
refused the command) or **Not captured** (the command is not in that capture).
The row gives the reason and quotes the line that decided it, with its line
number. Failures are listed first; *Only what did not pass* hides the rest.
The checks are one allow-listed setting, `backupChecks`, and none ship built in.
What differs from the wording, and why:
- **Two more outcomes than pass and fail.** A command missing from a capture
  is a gap in the collection, not an answer from the network, so it is *not
  captured* rather than a failure. A command the device refused is *not
  accepted*. Folding either into *fail* would send someone to chase a fault
  that is not there.
- ***Does not match*** was added beside the three asked for, as the natural
  pair of *matches*.
- **Contains is literal.** `0.0.0.0/0` means those characters, not a regex
  where each dot matches anything — tested.
- **Checks run against a run, not a single file**, so one click answers the
  question for every device in the window.
- **Evaluated in Rust** (`crates/coreview-discover/src/checks.rs`), not in the
  browser. The `regex` crate matches in linear time and takes a compiled-size
  limit, so a pasted pattern cannot hang on a long `show` output; a JavaScript
  RegExp can backtrack for ever. `regex` was already in the lock file through
  other crates, so adding it as a direct dependency brought in no new crate.
  Patterns are line-anchored and capped at 1,000 characters. Every check
  compiles before any file is read, so a bad pattern is refused by name. The
  library's several-line caret diagram is reduced to its last line
  (`unclosed group`), because the panel shows one line.
- **UI in its own component**, `BackupChecks.tsx`, because the Backups panel
  already carries capture, browsing and before-and-after.
The command name is matched with case and spacing ignored, like the rest of
the show-command code. `compare.rs` now shares its run and folder helpers and
`valid_stamp` within the crate, so checks and comparison refuse the same
non-stamps. `examples/run_checks.rs` runs checks from the terminal.
**Evidence:** 8 tests in `checks.rs` (quoted evidence and line number, literal
contains, does-not-contain failing on the offending line, case, line anchors,
bad patterns refused by name on one line, including an oversized `\w{1000}{1000}`,
a two-device run with pass, fail, not captured, not accepted and a config-only
device left out, and non-stamps refused); 4 in `checks.test.ts`;
`e2e/checks.mjs`, 21 checks, all passing. While writing that harness, one of
its checks was found to be vacuous (it passed if either device came first) and
was made exact before it was run. **Live**, against the two real captures from
the lab switch: a regex on `show clock` passed, quoting line 1; *contains
`uptime is`* passed and *does not contain `uptime`* failed on that same line;
`SHOW   CLOCK` still found `show clock` and failed *contains `UTC`* with "no
line has"; `show ip route` came back *not captured*; `(unclosed` was refused.
The disk filled up (28G of build cache) partway through this item's build.
The link errors it caused were cleared with `cargo clean --profile dev`, not
by changing code, and everything was re-run from a clean build: cargo test
(315 in the crate library), vitest (635), tsc, eslint, clippy `-D warnings`,
and the showcommands and beforeafter harnesses.
**Confirmed by the operator in the app, 2026-09-13:** "The new Backups tab
features. tested good".

### LT-152 — Before and after: capture, change, capture, compare — 2026-09-13
**Source:** the same planning, 2026-09-13.
**The shape:** a maintenance window is judged by comparing what the network
said before against what it says after. Captures exist (LT-149) and a config
diff viewer exists; what is missing is a *pair* — tag a run as "before", run
again as "after", and see per device and per command what changed.
**Acceptance:** two runs tagged before/after show a per-command diff for every
device in both.
**Done 2026-09-13.** **Before and after** at the foot of the Backups tab: pick
two runs (they default to the newest two), choose Compare runs, and every
device and capture in either run is listed. Show-command captures are
compared **one command at a time**; configurations are compared whole. Each
changed part shows its removed and added lines, and *Only what changed* is on
by default.
What differs from the wording, and why:
- **No tagging.** Every device in one run already shares a stamp, so a run
  has an identity. "Before" and "after" are simply the two runs picked, and
  nothing new is stored. Tagging would have been a second name for a thing
  that already has one.
- **Every device in *either* run** is listed, not only devices in both. A
  device or command present in one run only is marked *only in the before/after
  run*, because a switch backed up before a window and not after is what a
  review needs to see.
- **Bounds.** At most 400 changed lines are returned per part, and the counts
  stay complete. When the line-by-line diff's table would pass 4M cells (a
  full routing table against another is hundreds of megabytes), the lines are
  compared as sets and the part says so.
Built as `crates/coreview-discover/src/compare.rs`: `list_runs` and
`compare_runs`, with no Tauri in it. `showcmd::sections` reads a capture back
into its commands, sharing the refusal marker with `render` so the two cannot
drift. The Tauri commands `list_backup_runs` and `compare_backup_runs` take
stamps, never paths, and a stamp that is not the shape of one is refused
before anything is read. `examples/compare_runs.rs` runs the same comparison
from the terminal.
**Evidence:** 6 tests in `compare.rs` (runs listed newest first; a per-command
diff with changed, same and only-after commands and the header ignored;
configs, plus devices in only one run; non-stamps such as `../../etc` refused;
the set fallback; the line cap); 2 in `showcmd.rs` (render and read back
round-trip including a refusal and an empty output; no headings; a bare
heading); 1 in `fileNames.test.ts`. `e2e/beforeafter.mjs`, 21 checks, all
passing. One check first failed because of the test itself: it searched the
whole section for the hidden device's name, which a changed line in the
fixture legitimately mentioned. It now checks the device headings. **Live:**
`compare_runs` over the two pattern-named captures taken from the lab switch
for LT-151 found both runs. It reported `show clock` changed (−1 +1, the two
real timestamps) and `show version | include uptime` unchanged, and refused
`../../etc` as a run. Rust tests (307 in the crate library), vitest (631),
tsc, eslint and clippy `-D warnings` are clean.
**Confirmed by the operator in the app, 2026-09-13:** "The new Backups tab
features. tested good".

### LT-151 — Capture filenames built from the device's own fields — 2026-09-13
**Source:** the same planning, 2026-09-13.
**The shape:** a change record usually wants a filename that says site, device
and date. Backups today are `<device>/<stamp>-<kind>.txt`. A pattern with
tokens — `{site}`, `{device}`, `{date}`, `{kind}` — filled from the device
record, sanitised by the same `safe_component` rule that already stops a
hostile device name escaping the folder.
**Acceptance:** a pattern set once produces those names; nothing it produces
can land outside the backup folder.
**Done 2026-09-13.** A **File names** field in the Backups tab, with a live
preview for the first selected device. Tokens: `{stamp}`, `{kind}`,
`{device}`, `{address}`, `{site}` (the device's Site, else the project's) and
`{date}`. Blank keeps the old names byte for byte. The pattern is saved as the
allow-listed setting `backupFilePattern`. `backup::render_filename` is
authoritative and `src/lib/fileNames.ts` mirrors it for the preview; a test in
each pins the same case to the same bytes.
What differs from the wording, and why:
- **`{stamp}` and `{kind}` are required.** Without the stamp a second run
  overwrites the first; without the kind, one run's running and startup
  configurations overwrite each other. A pattern missing either, or with an
  unknown token such as `{sit}`, is flagged as it is typed, keeps Back up off,
  and is refused again by `start_backup` before anything connects.
- **The pattern names the file, never the folder.** It stays
  `<root>/<device>/`, so the capture browser, Compare with previous and the
  unchanged check needed no new model. Every token is sanitised on its own and
  the whole name again, so the result is always one component: separators in
  the pattern or in a device name become dashes (`../../{stamp}-{kind}` and a
  site of `../../etc` both stay in the device folder — tested).
- **Length.** A name is capped at 92 characters before `.txt`, because the
  diff command re-sanitises the filename it is handed and would otherwise cut
  a longer one short and open a different file. Device-supplied tokens are
  shortened until the name fits, so a long hostname still gets its backup;
  only a pattern whose own text is too long is refused. The first attempt
  divided a budget and failed its own test by two characters, because
  separators beside empty tokens are trimmed; the shipped version shortens a
  character at a time.
- **Ordering** is now by the stamp found anywhere in the name
  (`backup::stamp_in`), not by the filename, so `{site}_…` does not sort by
  site. `latest_capture` matches the kind anywhere in the name.
  `describeCapture` moved into `fileNames.ts` and reads date and kind wherever
  the pattern put them.
**Evidence:** 8 new tests in `backup.rs` (default unchanged, every token,
escape attempts, required tokens, bad tokens, long names, over-long pattern,
stamp finding); 2 in `capture.rs` (pattern-named captures list newest first
across differing sites, unchanged still detected, a bad pattern writes
nothing); 6 in `fileNames.test.ts`; `e2e/showcommands.mjs` grew 11 checks, 45
in all, all passing. **Live on the lab switch** via
`examples/show_capture.rs` with `CV_PATTERN='{site}_{device}_{date}_{stamp}_{kind}'`
and a site of `Lab Bench`: two runs produced
`<switch>/Lab-Bench_<switch>_2026-09-13_20260913-212740_show-commands.txt`
and `…-212743…`, mode 0600, with no paging markers. The example now stamps
the way the app does; it had used `run-<secs>`, which left `{date}` empty on
the first live try. cargo test (discover crate), vitest (630), tsc, eslint and
clippy `-D warnings` are clean.
**Confirmed by the operator in the app, 2026-09-13:** "The new Backups tab
features. tested good".

### LT-150 — Command sets by role, not retyped per device — 2026-09-13
**Source:** planned 2026-09-13 from the operator's own change-planning
checklist (kept on his machine, never in this repository) — "lets use it to
plan more features like the show commands and etc"; picked up on "continue
please".
**The shape:** that kind of checklist groups devices by what they are — edge
routers, core switches, firewalls — and gives each group its own command list.
Per-device lists (LT-149) do not scale to that. A **named command set** applied
by device role or tag does.
**Acceptance:** a set is created once, applied to every device with a role or
tag, and edited in one place. Ships with **no** built-in sets derived from any
real project (D-027).
**Done 2026-09-13.** *Command sets by role or tag* in the Backups tab's show
commands: each set has a name, roles, tags (comma separated) and commands.
A device matches on its Role field or any tag, ignoring case and spacing. Its
list is the global one, then every matching set in list order, then its own,
with repeats run once. The table's *Own commands* column became *Commands* and
names the sets each device picked up. The sets are kept as one allow-listed
setting, `backupCommandSets`, on the operator's machine. A set with no role and
no tag applies to nothing, on purpose: the global list is the one for
everything.
What differs from the wording: sets are **global to the machine, not per
project**, because a role's commands follow the engineer from job to job. The
backend is unchanged — sets resolve into each target's `commands` in the
front end, so the same read-only guard (D-027, LT-149) checks every command a
set contributes before a connection opens.
**Evidence:** `src/lib/commandSets.test.ts` (7 tests: role and tag matching,
order and dedupe, malformed settings dropped, empty new set);
`e2e/showcommands.mjs` grew 12 checks, 34 in all, all passing. They cover a set
matched by role in another case, a set matched by tag merged with the device's
own list, the exact commands handed to `start_backup`, the setting saved
without the credential, both sets restored after a restart, and a removed set
taking its commands off. tsc, eslint, vitest (624) and clippy `-D warnings`
are clean. Not run against the switch: a set changes only which commands
reach the path LT-149 proved live, not how they are sent.
**Confirmed by the operator in the app, 2026-09-13:** "The new Backups tab
features. tested good".

### LT-149 — Run show commands and file the output like a backup — 2026-09-13
**Source:** asked 2026-09-13, with a screenshot of the Backups tab — "I need
one more option here to run show commands and store the output to the backup
folder just like how the backup is setup! the show commands would be something
I put with the option of per device or global show commands", and on paging:
"sometimes we need to do terminal length 0 and sometimes paging off and other
check for me out with a select button if needed or we just add to the show
commnds".
**Where it stands.** The Backups tab takes exactly two captures, running and
startup config, and `write_capture` refuses anything that does not look like a
configuration — correctly for a config, and it would reject every show output.
Paging is half-handled: SSH always sends `terminal length 0` and answers
`--More--`, which covers Cisco IOS and NX-OS and nothing else.
**Wanted:**
- A **show commands** capture beside running and startup config, filed in the
  same backup folder, one timestamped file per device per run, every command's
  output under its own heading.
- **Global** commands for every selected device, plus **per-device** commands
  added for that device only.
- A **paging** choice: automatic, or the vendor's own command — Cisco IOS/NX-OS,
  ASA/FTD, Palo Alto, FortiOS, Aruba/HP, Juniper, Huawei/H3C — or none.
**A guard this needs, because the tool is going to strangers:** the list is for
*reading*. A command that is not a show/display/get, or a show piped into
`redirect`, `tee` or `append` (which write files on the device), is refused
before anything is sent. One pasted `reload` must not become an outage.
**Acceptance:** tick show commands, give a global list and a per-device list,
pick a paging mode, and each selected device gets one file of outputs in its
backup folder. Proven against a real switch.
**Done 2026-09-13.** A **Show commands** option beside running and startup
config in the Backups tab: a global list for every selected device, each
device's own list set in its inspector and run after it, and a paging choice.
One file per device per run, `<device>/<stamp>-show-commands.txt`, owner-only
permissions, every command under its own heading.
**The guard, in two places.** `showcmd::check_read_only` allows `show`,
`display`, `get` and the session-only paging commands, and refuses anything
else plus any show piped into `redirect`/`tee`/`append`/`save` or sent to a
file with `>`. The Tauri command refuses the whole run before a connection
opens and names the command; the capture loop checks again, because
`run_backups` is public and the promise has to hold for any caller.
**Paging** presets are each vendor's own session-only command. FortiOS is
deliberately empty: its only pager switch is a saved configuration change, and
a reading tool must not make one, so its `--More--` prompts are answered.
**Two behaviours worth knowing:** a command the device rejects is kept and
marked rather than dropped, since "this platform has no such command" is
evidence; and a device that refuses enable still has its show commands run —
most need no privilege — where its configuration backup rightly fails.
**No presets ship (D-027).** The list starts empty and the per-device field has
no placeholder; nothing from any real project is in the app.
**Verified:**
- **Live, against the lab switch at `192.168.77.7`:** five commands, one file
  of 5,369 bytes with 0600 permissions, `show running-config | include
  hostname` answered under privilege 15, an invalid command marked, no prompt
  or echo in the file, and no `--More--` left in a 64-line `show version`.
  The capture stayed on the machine.
- `tests/backup_a_fake_device.rs`, over a real SSH session: the file and its
  ordering, the vendor pager sent *before* the first command, a device stuck
  in user mode still yielding show output — and a `reload` and a `| redirect`
  that the switch's own command log proves were **never sent**.
- 10 unit tests on the guard, paging and file format; `e2e/showcommands.mjs`,
  22 checks in the real panel: off until ticked, list sent trimmed and
  deduplicated, per-device lists only when ticked, list and paging remembered
  across a restart, no credential in settings, and a refusal shown in the
  backend's own words.
**Confirmed by the operator in the app, 2026-09-13:** "The new Backups tab
features. tested good".

### LT-131 — Direction of flow from the devices, not from guesswork — 2026-09-12
**Source:** asked 2026-09-12 — "traffic flow should come from cef or
forwarding table or ports data if its too much and laggy then we can skip it
as long we build an acurate topolgy thats all that matters direction is large,
unfi and auvik and many other products do it right we can do it right too but
if you can't then skip it."
**His priority, in his words:** an accurate topology first; direction is
wanted but skippable if it costs too much.
**The cheap accurate answer is not CEF.** A full forwarding table is large and
slow to pull, and almost all of it is irrelevant to a diagram. What actually
answers "which way is the internet" is the **default route**: one line per
device (`show ip route 0.0.0.0` on IOS, the FortiOS equivalent), giving a next
hop. Resolve that next hop to a device already crawled and every link gets a
direction, and the chain of them is the path — host, access, distribution,
core, firewall, ISP. That is one extra command per device against a crawl that
is already logging in, rather than a table walk.
**Two signals already collected that help and cost nothing:**
`AttachedDevice.port_population` — one address on a port means a device is
plugged into it, many means it leads to another switch — and the hop distance
the crawl already records.
**Was blocked on a device to write the parser against; unblocked the same day**
when the operator supplied credentials for his Catalyst. Both IOS forms were
captured from `LAB-CORE-SW1` and the parser written against those bytes, so
this one follows the standing rule rather than D-026. The FortiOS wording is
still only shaped, not captured — noted in the test that exercises it.
**Acceptance:** links carry a direction that came from a device's own
forwarding decision, and the diagram orders tiers by it. Where no default
route was learned, the link stays undirected rather than being guessed at.
**Done 2026-09-12, against captured output.** `defaultroute.rs` reads both
IOS forms — the `Gateway of last resort is 192.168.77.1` line and the
descriptor block under `show ip route 0.0.0.0` — captured byte for byte from
`LAB-CORE-SW1` the same day, so this one follows the standing rule rather
than D-026. The crawl asks one command per device and stops at the first
answer, which is the whole reason CEF was not used: a forwarding table is
large and slow and almost none of it is about the diagram.
**The trap, and it has its own test:** every one of these outputs contains
`0.0.0.0` as the *destination*. A parser that took the first address on the
line would report that every switch forwards to nothing, and point every
arrow on the diagram at it.
**Drawn:** where a device's next hop is an address another drawn device owns,
that link gets an arrow in that direction. Where it is not — the estate's
gateway usually is not something a crawl reached — the link stays undirected,
because a guessed arrow reads as fact.
**Proven live:** a crawl of 192.168.77.0/24 reports
`LAB-CORE-SW1  default route -> 192.168.77.1`.
**This is the other half of LT-126**, which shipped the joining and
deliberately left the ordering alone.

### LT-126 — After a crawl, the diagram shows where each host actually connects — 2026-09-12
**Source:** asked 2026-09-12 — "when we run network discovery and ssh to the
switches to build the network topology and we have ran ping sweep befor and
added devices to the topology, then right when we ran the cdp/lldp and SNMP
crowler we must update the diagram to show exactly where the hosts are
connected and the flow of the data path from host to switch to distro to core
to firewall to ISP to internet... etc".
**Two halves, and the second is the harder one.**

- **Where a host hangs.** The crawler reads MAC address tables. A host the
  sweep found has a MAC (LT-121). Matching one to the other says which switch
  and which port it is on — so a device the sweep dropped on the canvas as a
  loose box becomes a device cabled to an access port.
- **The path.** Access to distribution to core to firewall to the ISP is a
  *role* ordering, and the crawler does not currently assign roles. It has
  the raw material — CDP/LLDP adjacency, which way the default route points,
  which device holds the uplink — but turning that into a tiered drawing is
  its own piece of thinking.

**Said again, more sharply, the same day:** "the cdp/lldp crowler and the
sweep don't really build the diagram like they are disconnected / Auvik kinda
stick everything toghether and give us really good diagrma same as Domotz and
prtg, we got to get that working".
**That names the real defect, and it is not the layout.** Sweep and crawl are
two features that each produce their own output and never meet. A sweep drops
loose boxes on the canvas; a crawl learns adjacency and roles; nothing joins
them, so the operator is left doing by hand the one thing he bought the tool
to avoid. What Auvik, Domotz and PRTG actually do is keep a single model of
the network that every source of evidence writes into, and draw *that* — the
drawing is a view of the model, not the product of whichever scan ran last.
**So this wants a joining step, not a better layout algorithm:** one identity
per device, keyed on something stable (MAC first, then serial, then
management address), that a sweep hit, a crawl result, a CDP/LLDP neighbour
and a MAC-table entry all merge into. LT-125 is the same seam seen from the
naming side.
**Acceptance:** run a sweep, add hosts, then run the crawler, and the hosts
move to the switch ports they are really on, with the links drawn; the
diagram reads top to bottom in the order the traffic actually takes; and
running either scan again updates that one diagram rather than adding a
second set of boxes beside it.

**Built 2026-09-12 — the joining half, which was the reported fault.**
A device is now recognised by *every* identifier it carries rather than by one
canonical string, strongest first: MAC, then each address, then the name. That
is what lets the two halves meet — the sweep reads a MAC out of the ARP table,
the switch learned the same MAC on a port, and they are the same twelve hex
digits however each side spells them (`7456.3c00.0001`, `74:56:3c:00:00:01`,
`74-56-3C-00-00-01`).

- The sweep records the MAC on the device it places (`DeviceNodeData.mac`).
  Without that the two halves had nothing in common to match on at all.
- An attached device the crawl finds on a port is looked up before it is
  drawn. Already on the diagram: it keeps its node, its position and the name
  it was given, gains the VLAN and the MAC, and **is cabled to the port the
  switch learned it on**. Not on the diagram: drawn as before, now carrying
  its MAC so the next crawl recognises it.
- A re-crawl does not stack a second cable on the one already drawn — the
  attached links are deduplicated the way the discovered links already were.

**Two things this exposed that were wrong on their own:**

- `CrawlPanel` only drew a link when *both* ends were nodes that run had just
  created. The moment a host could be an existing node, that silently dropped
  exactly the cable being asked for. An end is now drawable if it was placed
  now **or** is already on the page.
- Attached links were never checked against what was already drawn, so a
  re-crawl restacked every one of them.

**Verified** by `e2e/join.mjs`, which sweeps a host, crawls a switch that
reports that host's MAC on `Gi1/0/11`, and checks the diagram ends with two
devices rather than three, the same node kept, and a cable on the right port.
Three of the six unit tests in `src/lib/topology.test.ts` were confirmed to
fail with the join disabled.

**The ordering half was closed by LT-145 on 2026-09-12**, so this item is
complete. What follows was written while it was still open: the *ordering* —
access to distribution to core to firewall to ISP. The crawler does not assign roles.
It has the raw material (CDP/LLDP adjacency, which way the default route
points, which port holds the uplink) but turning that into a tiered drawing is
its own piece of work, and layering by hop distance from the seed — which is
what happens today — is not the same thing. LT-125 is the same seam seen from
the naming side and is also still open.
**Note:** LT-114 already made an imported diagram run top to bottom, and
auto-layout is declined (D-023) — so this arranges what discovery *proved*,
rather than guessing a layout.

### LT-119 — Port labels take the full ink of the ground — 2026-09-12
**Source:** asked 2026-09-09 — "need the ports to be bright light please when
the background is dark, and black text when the backgroud is white."
**Built.** `.cv-edge-port` used `--ink-muted`, which is a mid grey on both
grounds — legible enough on neither, and these are the smallest and most-read
text on a diagram. It now uses `--ink`, which the white-background ground
remaps, so the label follows whichever is in use without knowing which it is,
and carries a little more weight at 10px. Measured: luminance 0.90 on the dark
canvas, 0.10 on the white one. Both are checked in `e2e/interact.mjs`, which
switches the ground through the store rather than hunting for the toolbar
button.

### LT-118 — **bug** Imported devices arrived as unusable shapes — 2026-09-12
**Source:** two reports on 2026-09-09 — "some of the imported diagrams they get
locked shaped I can't adjust their boarders", with a screenshot of a device
drawn as a vast flat ellipse, and "for me to move the link I have to extend and
make it long to make room to move the link".
**One cause, three symptoms.** LT-110 gave an imported device the *drawing's*
box. A Cisco rack unit is 2.06in by 0.185in, which at the import scale is a
node 357px by 32px — eleven to one. From that:

- A device glyph's selection ring is a circle (`border-radius: 50%`), and on an
  eleven-to-one box that draws an enormous flat ellipse around a small icon.
  That is the screenshot.
- Two rack units stacked as the drawing stacks them leave a link with no
  grabbable length between them — hence having to stretch one out first.
- **And it did not survive being reopened.** `migrateDocument` squares any
  device glyph whose sides differ by more than 12px, on every load (LT-053: a
  glyph's bounds are square so its ring and resize corners sit on the drawn
  symbol). An imported diagram therefore changed shape and moved between
  sessions. LT-110 was fighting a rule the app already had, and losing.

**Fixed.** An imported device is square, sized by the geometric mean of the
drawing's box — which keeps what was worth keeping, a cloud still arriving
larger than an access switch — clamped to a usable range. Positions still come
from the drawing, which is the part that makes it look like the original.
**Squares that would collide are pushed apart**, because they must be: a rack
unit is drawn thinner than the gap between two of them, so as squares they
overlap at *every* scale. Scaling cannot fix that — it moves the gap and the
size together — which took one wrong attempt to see. Each device is settled
against those already placed, in the drawing's own order, so a rack comes back
stacked and in order rather than shuffled.

### LT-117 — **bug** "Save this style as the default" only saved it for one page — 2026-09-12
**Source:** reported 2026-09-09 — "save link stile as the default doesn't
really save it."
**Reproduced, and it does save — for the page you are looking at.** The action
called `setCanvas`, and the canvas has been per page since LT-094. Save the
style, add a page, and links drawn there come out in the built-in grey. Not an
edge case: importing a multi-page Visio drawing creates a page per Visio page,
so the style is set on the first and missing from every other.
**Fixed.** The default look of a link is a property of the diagram, not of one
of its canvases. `setDefaultLinkStyle` writes it to every page, and a page
added later inherits it from the one in front of you.
**Worth recording:** the first version of this check "failed" because my own
harness re-seeded its fixture on every navigation, including the reload it was
using to prove persistence — it overwrote the value it then reported missing.
The app was briefly accused of a bug it did not have.

### LT-116 — **bug** Removing a stencil pack did nothing, and said nothing — 2026-09-12
**Source:** reported 2026-09-09 with a screenshot of the confirm dialog —
"remove doesn't do anything, you delete this tripp-lite stencil pack and I
don't want it."
**Diagnosed.** The button deleted the pack's folder from the app's own
resources. An app installed where the person running it cannot write —
`/Applications`, `Program Files` — cannot do that, and on macOS editing a
signed bundle would break its signature. The delete failed, and the dialog
swallowed the error with `.catch(() => undefined)`, closed itself, and left the
pack where it was. Reproduced by making a directory read-only and watching
`remove_dir_all` refuse.
**Fixed.** Removal is a decision rather than a fact about the disk: the pack is
recorded in settings, and both the pack list and the icon scan skip it, so its
shapes leave the palette whether or not the files can be deleted. The files are
still deleted where that is possible, and the outcome says which happened —
"freed the space it used", or "its files could not be deleted, so the space is
still used". The dialog no longer swallows anything.
**Note on the pack itself:** `stencils/` in this repository ships `cisco` only.
The Tripp Lite pack was removed from the repo under LT-100, so an install that
still shows it predates that; removing it now takes it out of the palette for
good.

### LT-115 — A stack is one device with several serials — 2026-09-12
**Source:** asked 2026-09-09 — "Address the crawl's serial when we have cluster
of switches. There should be a comma separator."
**Correct, and it was a real hole.** LT-114 shipped `serial` as a single value
and took the first one it found. A StackWise stack, a VSS pair or a chassis
with two supervisors is one hostname, one management address and one node on a
diagram — and four boxes that can each be RMA'd separately. Naming one of them
and dropping the rest is worse than useless on the one field a support case is
raised against, because it looks complete while being wrong.
**Built.**

- **`serials_in_version`** reads every chassis serial out of `show version`,
  which the crawl already runs — so no extra round trip per device, which
  matters on a large crawl. IOS prints a `System Serial Number` per stack
  member; a lone unit that prints no serial line at all is caught by
  `Processor board ID`. The motherboard serial is skipped deliberately: it is a
  different part and not what a support contract is keyed on. Deduplicated,
  because the first member appears both in the summary and in its own block.
  `show inventory` is the fuller answer — it reaches line cards and optics —
  but that is another round trip, and optics serials are not what was asked
  for.
- **Merging is a union, not first-wins.** This is the subtle half. The same
  stack can reach the crawl twice from two different neighbours, each
  advertising a *different* member's serial in its CDP device id, and both are
  true. `src/lib/serials.ts` merges them, keeping discovery order so the member
  reported first — the master — stays first. A re-crawl adds a member rather
  than replacing the one already recorded.
- **The field is edited by hand**, so it reads commas, semicolons, slashes and
  runs of spaces, normalises case, and drops repeats. It says how many chassis
  it names: an operator expecting four members and seeing three has found
  something.
- **The comma survives the CSV**, which is the one thing that format is worst
  at. The writer already quoted a cell containing one; a test now pins the
  round trip rather than trusting it.

**Verified:** eight parser tests against the real `show version` shapes, eleven
on merging, three on the CSV round trip, and live in the harness — a three-
serial stack is kept whole on one device and described as a stack, and a single
switch is not.
**Still honest about the limit:** no device here to crawl, so the parsing is
tested against captured output shapes rather than live hardware, and VSS pairs
and Nexus chassis that report their members through `show module` rather than
`show version` will still give one serial until that is read too.

### LT-112 — **bug** A link close to its devices cannot be clicked — 2026-09-12
**Source:** reported 2026-09-08 with a screenshot of a router and the links
meeting it — "I can't select the link to move it, if i select it will select
the router not the link to move it."
**Reproduced and measured before changing anything.** The wide transparent
path that makes a thin line practical to click lives in React Flow's edge
layer, which is drawn *below* the node layer. A device's box is square and
76px across whatever shape is drawn inside it, so near a device the box
covers the line. Sampling 21 points along a link between two devices and
asking what the pointer would actually land on:

| Distance between centres | Points that reached the link |
| --- | --- |
| 260px | 20 of 21 |
| 130px | 13 of 21 |
| 110px | 10 of 21 |
| 95px | 2 of 21 |
| 85px | **0 of 21** |

At 85px — nine pixels of clear gap between two 76px boxes — there was no
point on the line that could be clicked at all, which is exactly what the
operator hit: an imported drawing places devices where the drawing put them,
not on a comfortable grid.
**Built.** A second, narrow hit band (12px, six either side of the line) is
rendered in the edge-label layer, which the endpoint handles already use to
get above the nodes, and selects the link on pointer-down. The visible line
stays in the layer below the nodes, because a cable passing behind a device
is what a diagram should look like. z-index 2: above a resting node, still
below the one being dragged or selected, and below everything on a link that
can be grabbed — labels, waypoints, endpoint handles — or the band would
swallow those drags. Afterwards: 21 of 21 at every spacing down to 80px,
with node clicks and node drags unaffected.
**One thing it cost, and what replaced it.** Tracing — pointing at a link to
fade the rest — was pure CSS (`.react-flow__edges:has(.react-flow__edge:hover)`)
and could not survive this: the band is in a different part of the tree from
the line it belongs to, so the line is never `:hover` and no selector joins
them back up. `src/components/edges/traced.ts` holds the id instead and each
link fades itself. Deliberately outside the app store, so a hover does not
enter the undo history or every save. A side benefit: a *selected* link now
stays bright while the pointer wanders, which the CSS version could not do.
**A limit that was there and is now not (LT-113).** The band's width is a
stroke, so it first shrank with the zoom like everything else on the canvas —
under two pixels wide at 0.14 zoom, measured, so a link stopped being
clickable well before it stopped being visible. `vector-effect:
non-scaling-stroke` makes those twelve pixels *screen* pixels, and hit
testing follows the rendered stroke, so it holds all the way down: every
sampled point on a link still reaches it at 0.06 zoom. The harness checks the
zoomed-out case alongside the ordinary one.
**Also in this change, asked for at the same time:** an imported link now
arrives as a **bezier** rather than a smooth step. An imported drawing puts
devices where the drawing put them rather than on a grid, and an orthogonal
route between two of them takes a long way round and reads as routing that
was meant, when it is only routing that was computed.
**Verified** in the Chromium interaction harness (`e2e/interact.mjs`), which
is this repo's stated method for canvas interaction — synthetic X11 input
does not produce the pointer sequence React Flow needs, so those cases were
already run against the browser build. Three checks added there: a link
between two touching devices is clickable along its length, clicking it
selects it and offers its endpoint handles, and clicking or dragging a device
still does what it did. Not additionally hand-verified in WebKitGTK: the
Xvfb session would not hold a zoom level long enough to aim at a line. The
two CSS properties involved are long-standing and the rest is engine-neutral
DOM logic, but that is reasoning rather than a measurement, and is recorded
as such.
**Found while doing it, and fixed:** `e2e/interact.mjs` had been dying a
third of the way through since LT-094 landed — a right-click aimed at the
canvas hit the new page-tab strip, and 35 places still read `doc.nodes` on a
document that now holds pages. Roughly half the harness had not run since.
It runs end to end again.

### LT-145 — The diagram lays out by role, not by distance from the seed — 2026-09-12
**Source:** asked 2026-09-12 — "also is what we built good for discovery and
auto diagram tool?" — and the honest answer is that discovery is strong and
the drawing is not. It is the same gap LT-126 left open and the ordering he
asked for in LT-131's source: "host to switch to distro to core to firewall to
ISP".
**Why the current picture is wrong.** Layout is hop distance from the crawl
seed. Seed a crawl at an access switch and the access switch is the top of the
diagram. Distance from wherever someone started is not a property of the
network.
**Nothing new needs collecting** — every signal is already on `CrawledDevice`:
- **`default_next_hop`** (LT-131). Follow the chain; the device whose next hop
  is *not* a crawled device is the edge, and distance back from it is the tier.
- **`DeviceClass`** — firewall, router, switch, access point, endpoint.
- **`AttachedDevice.port_population`** — one MAC on a port is an access port,
  many means it leads to another switch. Already collected, already documented
  as meaning exactly that.
- **Infrastructure neighbour count** — a core has many, an access switch few.
**Tier order:** internet → firewall → core → distribution → access → endpoints.
**Runs on a button, never on its own** (his decision, 2026-09-12): "Re-arrange
on an explicit button". Discovery never moves a device someone placed; a
"Tidy into tiers" action re-lays the page when asked, through `store.commit()`
so one undo puts it back.
**Corrected 2026-09-12, after reading the code rather than assuming.** Most of
this already exists and the item overstated the work. `hierarchyLayout.ts`
(LT-114) already tiers by what a device *is* — internet, router, firewall,
core, distribution, access, endpoint — then places anything untyped one below
the highest thing it connects to, reduces crossings by the median rule, and is
already on a button: **Arrange top to bottom**. The layout is not the gap.
**The gap is that it ignores the one piece of ground truth there now is.** Its
three rules are the glyph, the cabling, and a fallback — none of which is the
device's own forwarding decision. Since LT-131 a link carries a *proven*
direction wherever a crawl read a default route, and that is not a guess about
what a box looks like: it is the device saying which way it sends traffic it
has no other route for. Nothing reads it.
**So the work is one rule, not an engine:** a proven direction is a constraint
— the upstream end sits above the downstream end — applied after the existing
rules and beating them where they disagree, because a glyph is a guess and a
default route is evidence. Bounded iteration, so bad data cannot spin it.
**Acceptance:** a crawl of a real network draws the firewall above the core
above the access switches, whatever device the crawl was seeded at; pressing
the button re-tiers; undo restores what was there.
**Done 2026-09-12, and smaller than this item first claimed** — because most
of it already existed and the item was written before the code was read.
**What was added is one rule and one piece of evidence:**
- **Rule 4 in `tiersFor`:** a proven direction is a constraint — the end
  traffic leaves by sits above the end it leaves from — applied after the
  three existing rules and beating them where they disagree. A glyph is a
  guess about what a box looks like; a default route is the box saying where
  it sends traffic it cannot otherwise place. Bounded iteration, so a ring of
  contradictory directions cannot spin it.
- **`switchPort` as hierarchy evidence** (LT-146): a device that names the
  switch it hangs off belongs below it. That comes from a MAC table, so it is
  proof — and it is fed to the layout without drawing an arrow, because
  nobody wants one on every access port.
**Two faults this exposed, both fixed:** the crawl never wrote the hostname it
learned, so a switch the sweep drew as `192.168.77.7` had the crawl's name
nowhere while the hosts hanging off it named it `ACC-SW1` — the two could
never meet. And matching on the drawn label alone was fragile for the same
reason; it now matches on label *and* hostname.
**Verified:** seven unit tests, four of which were confirmed to fail with the
rule disabled; and `e2e/join.mjs` sweeps, crawls, arranges, and checks the
switch ends up above the host it feeds and that undo puts every device back.

### LT-127 — CI builds the Windows NSIS installer and nothing else — 2026-09-12
**Source:** asked 2026-09-12, right after LT-123 — "next we only do windows
NSIS to save time and github", following "reminder not to build the off line
installer it takes very long lets skip it for now".
**What stops being built.** This goes further than LT-123, and it is worth
being plain about what it costs, because some of it was wanted recently:

- the Windows **MSI** (kept alongside NSIS until now)
- the Linux **.deb** and **AppImage**
- the **universal macOS .dmg** — LT-106 shipped this and he confirmed it ran
  on his own MacBook Pro
- the **AppImage smoke test**, which has nothing left to test

**What stays:** the NSIS installer, and the `test` job on both Ubuntu and
Windows. The tests are not bundles and they are the cheap half — LT-044 was a
Windows-only bug that only the Windows runner could ever have caught — so
dropping them would save little and cost the thing CI is for.
**Acceptance:** a push to main produces one artifact, the NSIS `.exe`, and the
run has no macOS or Linux bundle job in it.
**Reversible:** the jobs are in git history; putting macOS or Linux back is a
revert, not a rewrite. Say so when he wants a Mac build again.
**Superseded 2026-09-12 by LT-143.** It did what it was asked — the
NSIS installer alone — and then he asked for macOS, Linux and the MSI
back. The air-gapped installer stays off, which is the part of this
item that still holds.

### LT-044 — **bug** Windows CI red: CRLF checkout breaks the stencil-test import — 2026-09-12
**Source:** operator screenshot, 2026-08-30 — every run since #88 red on
`test (windows-latest)` / Frontend tests, `SyntaxError: Invalid or unexpected
token` at import-pptx-stencils.test.mjs:7:31 (previously pptxStencils.test.ts:7:31 —
moving the file did not cure it, which was the tell that the position was a lie).
**Root cause (reproduced locally):** the Windows runner checks out with
autocrlf, so `import-pptx-stencils.mjs` arrives CRLF; vite strips its shebang
but leaves the carriage return behind, V8 rejects the transformed module, and
vitest attributes the error to the file that imported it. Bisected to line 1
alone: shebang+CR fails, CRLF everywhere else passes.
**Fix:** `.gitattributes` pins `eol=lf` for text files so every checkout —
runner or laptop — sees the bytes the tests were written against.
**Acceptance:** a test that fails without the pin; Windows CI green.

### LT-056 — **bug** The installer's app is blocked on the second machine — resolved 2026-08-30 — 2026-09-12
Reported with a screenshot ("Windows cannot access the specified device,
path, or file"), and withdrawn by the operator the same hour: the block was
that machine's own policy, and the same installer runs fine on another
Windows machine. Nothing to change in Coreview; kept because the symptom and
its reading (Windows application control refusing a binary whose internal CA
the machine does not trust) will recur on any locked-down host — that is
LT-011's public-CA half.

### LT-137 — **bug, security** A real passphrase was a test fixture in the repo — 2026-09-12
**Source:** found 2026-09-12, immediately after he supplied his SNMP v3
credentials and restated the standing rule — "i just don't want any secrit I
type in my app or provide you here gets pushed to the github".
**What was there.** `crates/coreview-discover/src/vault.rs` used one literal
string five times as the sample secret in its seal/open tests, and that string
is the live auth and privacy passphrase on his SNMPv3 user, which most of his
estate shares. It is deliberately not repeated here: writing it into this file
would put it straight back into the repository, which is the whole fault. It has been in the repository since
`0d20949` ("Credential vault: encrypted at rest, revealed on request") and
appears in four commits.
**How it got there:** someone — an earlier session of this assistant, on the
evidence of the commit — reached for a realistic-looking password when
writing a test instead of an obviously fake one, and reached for the one in
front of it.
**Fixed now:** the fixture is `not-a-real-secret-fixture`, which cannot be
mistaken for anything. Tests still pass; what the vault does with a string
does not depend on which string.
**Not fixed, and the operator's call:** it remains in git history, and that
history is now on a public GitHub repository. Removing it means rewriting
history and force-pushing, which is destructive and is not something to do
unasked. **The safe assumption is that this passphrase is compromised and
should be rotated on every device that uses it.** Rotating is cheaper and
more certain than trying to erase it.
**Standing rule, restated because it was broken:** a test fixture is never a
plausible credential. Fake strings only, and obviously fake — the point of
`not-a-real-secret-fixture` is that nobody can mistake it for a password
worth trying.
**Closed by the operator's decision, 2026-09-13.** In his words: "these
removed from the github its testing lab so we should be okay as well but
youre right deleting is good". The credentials belong to a test lab, and he
accepts the history as it stands. Checked the same day with a read-only
`git fetch` and `git log -S`, printing counts rather than values: neither
value is in the current tree on GitHub, **but both remain in its history**
(one in 2 commits, the other in 5). Local `main` and `origin/main` were
identical, so no rewrite had been pushed. Recorded plainly so nobody later
reads "removed" as "scrubbed from history". Rotating on the lab devices is
still the advice, and the fixture rule above stands.

### LT-141 — **bug** The sweep adds devices that are already on the diagram — 2026-09-12
**Source:** reported 2026-09-12 with a screenshot — "ping sweep doesn't
compari to whats already on the diagram for example check this out". The
picture shows the same hosts drawn three times over: `192.168.77.7` as a bare
box in two separate blocks while `LAB-CORE-SW1` at that address sits in the
crawled tree above; `LABAP431F0002.local`, `host.docker.internal`,
`fabricforge.local`, `NAS000001`, `.22`, `.25`, `.112`, `.203`, `.206`, `.215`
each drawn twice.
**Cause.** LT-126 and LT-133 taught the *crawl* to recognise what is already
drawn. The sweep never learned: `DiscoverPanel.addPicked` calls
`makeDeviceNode` and `store.addNode` for every ticked row without looking at
the page at all. So a second sweep — or a sweep after a crawl — lays a fresh
block of boxes over the network that is already there.
**Fix:** the sweep uses the same multi-key identity the topology builder
does — MAC, then address, then name. A host already on the diagram is updated
in place, keeps its position, and is reported as updated rather than added.
**Acceptance:** sweep, add, sweep again, add again — the diagram has one node
per host and says how many it updated rather than how many it added. A test
that fails without the fix.
**Fixed 2026-09-12.** `findDrawnNode` is lifted out of the topology builder
and used by the sweep, so both halves of discovery ask the same question and
answer it the same way. A host already drawn keeps its node and its position;
only the MAC, manufacturer and name the sweep newly learned are written, and
the label is left alone because a name corrected by hand should survive a
re-scan.
**The message says what happened** — "Added 3 devices, updated 12 already on
the diagram" rather than "Added 15". Reporting everything as added is how this
went unnoticed for as long as it did.
**Reproduced first:** `e2e/join.mjs` sweeps, adds, sweeps again and adds
again. Before the fix it went 2 nodes to 4, with `LabDesktop01` and
`192.168.77.7` each drawn twice — his screenshot in miniature.

### LT-142 — Several SNMP credentials, v2c and v3 together — 2026-09-12
**Source:** asked 2026-09-12 — "I need to add multiple SNMP credentials and
both 2 and v3 if I want to so make it granular", with a screenshot of the
single-credential SNMP row.
**Where it stands.** The panel takes exactly one SNMP credential: one version,
one community *or* one v3 user. A real estate is not like that — the Cisco
answers v3 with SHA and AES-256, older kit answers v2c with a community, and
some of it answers a different community again. One credential means a crawl
that identifies a third of what it could.
**Note:** SSH already does this — `startCrawl` takes `fallbackCredentials`
tried in order. SNMP takes one and no more, so this is the same idea applied
to the other protocol rather than a new one.
**Acceptance:** several SNMP credentials can be listed, v2c and v3 mixed, each
saved to the vault or typed for the run; a device is tried against each in
turn until one answers. Nothing secret persisted outside the vault (D-006).
**Done 2026-09-12.** `CrawlOptions.snmp` is a `Vec<SnmpAuth>` rather than an
`Option`, and `identify_over_snmp` tries each in turn — which it has to,
because SNMPv3 reports a wrong password and a wrong algorithm identically, so
"not this credential" cannot be told from "not SNMP" except by trying. Saved
credentials are resolved first, then typed ones: a reference picked from a
list is a deliberate choice where a form left filled in from last time is not.
**What persists is the shape, never the secret.** The four `scanSnmp*` keys
became one `scanSnmpRows` JSON holding the version, the v3 user name and the
two algorithm choices — no community string, no passphrase. Six unit tests
cover that rule directly, and `e2e/scansettings.mjs` still asserts that five
distinctive secrets, the community among them, reach the settings table
nowhere.

### LT-146 — What discovery learns fills the device in — 2026-09-12
**Source:** asked 2026-09-12 — "whatever we disover and add to the diagram
must auto fill the devices option such as mac, vendor, serial number thats
true for discovery and ping sweep any info that helps should populate".
**Where it stands.** Some of this already happens and it is uneven, which is
worse than none of it happening: a swept host arrives with its name, vendor
and MAC (LT-121/LT-126); a crawled device arrives with its model and serial;
an attached device gets its VLAN. But `DeviceNodeData` has fields nobody
fills — `model`, `role`, `site`, `rack`, `assetTag` — and the crawl knows
things it never writes: the platform string, the OS version, the reached-by
transport, the open ports the sweep found, the switch and port a host hangs
off.
**The rule this needs, stated once:** anything discovery *proves* is written
to the device; anything a person typed is never overwritten by a later scan.
That second half is what makes it safe to re-run, and it is already the rule
for labels — it should be the rule for every field.
**Acceptance:** after a sweep and a crawl, opening a device shows its MAC,
manufacturer, model, serial, OS version and the ports it answers on, without
anything being typed. Re-running discovery updates what it proved and leaves
hand-typed values alone.
**Done 2026-09-12.** Four fields added to a device — `osVersion`, `openPorts`,
`switchPort` and `discoveredVia` — because discovery already knew all four and
had nowhere to put them. The sweep writes the MAC, manufacturer, name and the
ports that answered; the crawl writes the model, serial, software and how it
was reached; an attached device writes the switch and port it hangs off. All
six appear in the inspector beside the serial, **and all six stay editable** —
a value someone corrects by hand is theirs.
**One fault found and fixed on the way:** the switch and port used to be
written into `notes`, which clobbered anything a person had typed there, on
every re-crawl. They have their own field now, and `notes` is only written
when it is empty.

### LT-147 — Export every device on the diagram, with everything known about it — 2026-09-12
**Source:** the same 2026-09-12 message — "I also need to export to csv whats
been discoved to include all the info we disover like mac, name , ip, vendor
... ect ... the export button should also inlcude all the devices info on the
diagram very usefull for profiling purposes".
**Where it stands.** There is already a "Devices and links as CSV" export. It
carries what a diagram needs rather than what a profile needs — the new fields
from LT-121 and LT-139 (MAC, manufacturer, open ports, stack members and
their serials, the switch port a host hangs off, VLAN) are not in it.
**Two things wanted, and they are the same data at different moments:** the
sweep's own results as a list, and everything on the diagram as a profile.
Both are "one row per device, every column we know".
**Acceptance:** one CSV with a row per device and a column for each thing
discovery can know — address, name, where the name came from, MAC,
manufacturer, model, serial, OS version, class, VLAN, open ports, the switch
and port it connects to, and how it was reached. Opens in Excel, and a device
with nothing known still gets a row rather than being dropped.
**Done 2026-09-12.** Ten columns added to the device CSV — hostname, MAC,
VLAN, software, connects-to, open ports, found-by, site, rack, role — on the
end, so a spreadsheet built against the old columns still lines up and the
header-driven importer reads either file.
**Two things the tests pin:** a value containing a comma (an IOS version
string is full of them) is quoted rather than shifting every column after it;
and a device nothing is known about still gets its own row, because a profile
with holes is useful and one that silently drops hosts is not.

### LT-144 — The crawl says *why* a device was not reached — 2026-09-12
**Source:** asked 2026-09-12 — "192.168.77.114 could not be reached — did not
answer within 8s is this time okay for normal devices?"
**Measured before answering**, on his own subnet: the Cisco at `.7` and the
FortiSwitch at `.203` answer every open port in **0.00s**; `.114` and `.141`
answer nothing on 22, 23, 80 or 443 — every packet silently dropped. Both are
FortiGate-managed FortiAPs that expose no SSH to the LAN. **So 8 seconds is
generous, not tight.** A reachable LAN device is instant; one that has not
answered in 8s is not slow, it is dropping packets. An invariant test already
pins the connect timeout at ≤10s ("a dead device must fail fast").
**The fault is the sentence, not the number.** "did not answer within 8s"
reads as *too slow, try longer*. And the app cannot say better, because
`CrawlFailure` is `{ address, reason: String }` — the structured `SshError` is
flattened with `e.to_string()` and the frontend does string surgery on the
result.
**The gap that matters: "up but not SSH" has no representation.** A host with
port 22 filtered and a host that is switched off produce the identical
message — even though the ping sweep already knows one of them answers ICMP.
**Fix:** a `kind` discriminant on `CrawlFailure` mapped from the `SshError`
variants that already exist; and one ping before recording a failure, which
splits the ambiguous case into "reachable, but not over SSH" and "nothing at
this address answered at all". One extra ping per *failed* device; a
successful crawl pays nothing.
**Also:** the doc comment on the SNMP fallback says it is for a device that
*refuses* SSH. The code applies it to every failure, which is better — the
comment should say what the code does.
**Acceptance:** a crawl of his subnet reports `.114` and `.141` as reachable
but not answering SSH, rather than as timeouts.
**Done 2026-09-12.** `FailureKind` is mapped from the `SshError` variants, and
the ambiguous ones — a timeout, or a connect error that is not a refusal —
are settled with one ping on the failure path only, so a crawl that succeeds
pays nothing. Each kind carries a line of advice, and a test asserts none of
them tells the operator the device was merely *slow*, which is the reading the
old message invited. `CrawlPanel` groups the list by kind: four
controller-managed access points now read as one explained group rather than
four identical timeouts.
**What the measurement actually found about `.114` and `.141`.** They answer
nothing at all from this machine — no SSH, no HTTP, no ICMP — so they classify
as **unreachable** rather than "up without SSH", and the advice is the right
one for them: *may be off, or on a network this machine cannot reach*. They
are FortiGate-managed FortiAPs, almost certainly on a management VLAN. The
switch can see them over CDP; this machine cannot reach them. Both statements
are true and the diagram now says the second one honestly.

### LT-143 — Build macOS, Linux and the Windows MSI again — 2026-09-12
**Source:** asked 2026-09-12 — "lastly build the mac, the linux and the
windows msi. but don't build the airgapped installer that large 500 mig until
i finish testing and I will tell you when to build it".
**What changes:** LT-127 cut CI to the Windows NSIS installer alone. This puts
back the Windows MSI, the Linux `.deb` and AppImage, and the universal macOS
`.dmg` — everything except the offline/air-gapped Windows installer, which
stays off until he asks (LT-123).
**Acceptance:** a push to main produces NSIS, MSI, deb, AppImage and dmg, and
no `coreview-windows-offline` artifact.
**Done 2026-09-12** by restoring the pre-LT-127 jobs rather than rewriting
them: the `bundle` matrix is back to Linux and Windows, `bundle-macos` builds
the universal `.dmg` again, and `appimage-smoke` again proves the AppImage
carries its own WebKit. Four jobs. The air-gapped installer stays out, with a
comment in the workflow saying why and whose call it is.

### LT-140 — A chassis pair draws as two chassis and a link — 2026-09-12
**Source:** asked 2026-09-12 — "The drawing half of chassis pairs. The model
knows a VSX/VSS/SVL pair is two chassis; the topology builder doesn't yet
split one into two nodes with an ISL. That's real work, not a tidy-up ... and
finish it".
**Two different jobs, and conflating them would get both wrong:**

- **StackWise Virtual and VSS have one management plane.** A crawl logs into
  one address, gets one hostname, and sees one device — so the *builder* has
  to split it into two nodes and draw the SVL between them.
- **VSX and a FortiSwitch MCLAG pair have two management planes.** Each half
  is its own SSH target, so a crawl already reaches them as two devices. They
  need no splitting; what is missing is the ISL *between* the two nodes that
  are already there.

**Which half a downstream link lands on** is the part that is not guesswork:
Cisco numbers ports by member, so `HundredGigE1/0/25` is on chassis 1 and
`Te2/0/1` is on chassis 2. That is read from the interface name, which the
crawl already records at both ends of every link. A link whose port gives no
member number stays on the first chassis rather than being placed at random.
**Acceptance:** a crawl of a StackWise Virtual pair draws two switches joined
by the SVL, with each downstream link on the chassis whose port it is really
on; a VSX pair keeps its two nodes and gains the ISL. Tested against the
documented output shapes, and marked unverified until real hardware confirms
it — the parsers behind it are still D-026 hypotheses.
**Done 2026-09-12.** A StackWise Virtual or VSS device is split after layout:
the node already drawn becomes member 1 and keeps its position, each further
member gets its own node, and the SVL is drawn between them labelled with the
link the device named.
**Three decisions worth knowing about:**
- **The second chassis gets no address.** The pair answers on one, and giving
  both the same one would put two probes on one box and report a dead chassis
  as healthy. It carries its own serial instead, which is what an RMA needs.
- **A downstream link lands on the chassis its port names.** `chassisOfPort`
  reads the member out of `HundredGigE1/0/25` or `Te2/0/1`. A port with no
  member number in it — `Port 4`, `lag1` — stays on the first chassis rather
  than being placed at random, and that is a stated rule rather than an
  accident.
- **VSX and FortiSwitch MCLAG are deliberately not split**, because each half
  is its own SSH target and a crawl has already reached them as two devices.
  Splitting those would invent two more switches. A test pins that.
6 tests. Still unverified against hardware, like everything else under
LT-139.

### LT-120 — **bug, fixed** A device blocked the links around it — 2026-09-12
**Source:** reported three times on 2026-09-09, most clearly with a screenshot
of a device ringed by its selection circle and links running under it — "I
still can't move all the lines / do you see this big circular its blocking me."
**Diagnosed, not fixed.** The circle is the glyph selection ring, and it is not
what intercepts: it takes no pointer events. What intercepts is the device's
own square node box. LT-112's clickable band sits at z-index 2, chosen from a
two-node fixture where React Flow gave each node z-index 1. Measured on a real
diagram it gives a resting node **4** and a selected node **1004**, so the band
loses in both cases and a link crossing the device you are working on cannot be
clicked at all.
**What was tried and backed out.** Raising the band above the nodes (1100) does
make those links clickable — measured, every sampled point, including while a
neighbour is selected. But above the nodes it also covers their *connection
handles*, and the harness caught the consequence immediately: a new link could
no longer be drawn from a callout, because neither the handle it starts at nor
the device it is dropped on could receive the pointer. Trimming the band's ends
so the last pixels belong to the device fixes that for links of ordinary
length, and cannot for short ones — there is nothing left to trim. Stepping the
band aside while a connection is in progress does not help either, because the
drag never starts.
**Where the fix actually is:** the node's hit area, not this z-index. A device
glyph is a symbol drawn inside a square box, and the box captures the pointer
across its whole area including the parts that are empty. A hit area that
follows what is drawn would let a link pass behind a device and stay clickable
without taking anything from the device's own handles. That is a change to how
every device is hit-tested and wants its own careful pass rather than being
squeezed in behind a link fix.
**Fixed 2026-09-09, in the hit area rather than the z-index.** A glyph device
is a symbol drawn inside a square box, and an HTML element is a hit target
across the whole of its box whether or not anything is painted there. So the
square took every link that passed behind it. The device's hit area is now
round — `.cv-glyph-hit`, matching the ring that marks it as selected, so what
can be clicked is what looks like the device — and the empty corners fall
through to whatever is underneath, which is the link.

Two things this needed that were not obvious:

- **React Flow writes `pointer-events` inline on every node** from its own
  selectable/draggable state, and nothing but `!important` beats an inline
  style. Scoped with `:has(> .cv-glyph-node)` so it reaches glyph devices only:
  a note, a zone or a card-style device is a box, and a box should be clickable
  everywhere.
- **Events still reach the node.** Hit testing skips the wrapper, but an event
  that starts on the hit area inside it bubbles through, which is what keeps
  dragging, selecting and resizing working.

**Measured, with a device selected**, on a dense diagram of the shape an import
produces — thirty devices on a tight grid with links running across it, so
plenty of links pass behind devices they are not attached to: **73% → 82%** of
every link reachable. On a sparse six-device diagram the difference is 2
points, because there the links barely cross anything; the dense case is the
one that was reported.

The first measurement of this said 25/78, which was wrong: it counted a link's
own port and centre labels as blocking it, when those *are* that link and are
draggable. Corrected, it is 65/78 → 67/78 sparse.

**What still wins over a link, and should:** the circle where the device is
drawn, and a device's own name. A link passing exactly under an icon leaves the
icon clickable, which is the right way round.
**What was tried first and backed out** — raising the band above the nodes —
is described above; it made those links clickable and cost the ability to draw
a new one, because above the nodes the band also covers their connection
handles.

### LT-114 — The serial on the device, and a diagram that runs top to bottom — 2026-09-12
**Source:** asked 2026-09-08 — "some engineer asked on reddit if anyone knows a
tool to fully digram a network and map it with real links and real data flow
plus note the devices serial numbers on the devices options. We have most of it
but when i click the device to show its options i don't see the the SN its
useful plus real flow digram and top to bottom is something helpful."
**Built.**

**The serial, everywhere it should be.** `serial` and `assetTag` on a device —
two fields, not one, because the serial is the vendor's number and the asset
tag is the organisation's, and reconciling them is the job. The serial is what
an RMA, a support contract and a licence are all keyed on, and the one piece of
inventory that cannot be worked out from anything else on the diagram. It is
typed in the inspector, exported to and imported from the device CSV (added at
the end of the columns, and the importer is header-driven, so an older sheet
still lines up), read from a Visio drawing's Shape Data under any of the names
a drawing uses for it, and **filled in by a crawl**: CDP advertises it in
brackets after the device id — `N9K-2(FDO12345678)` — where the name parser had
always had to strip it to avoid duplicate devices and simply threw it away.
Only a plausible serial is taken, since a wrong one is worse than none: it is
the field a support case is raised against.

**A top-to-bottom flow layout** (`src/lib/hierarchyLayout.ts`), offered on the
canvas menu beside Tidy. The two are opposites and both are wanted: Tidy fixes
the spacing of an arrangement somebody made by hand and must not move anything
else; this replaces the arrangement, which is what a crawled or imported
topology needs and a hand-drawn one does not. Tiers come from **what the device
is** first — a firewall sits above a core switch and below the internet
whatever the cabling says, and that is the part a generic graph layout cannot
know and most of why those produce diagrams nobody recognises. A device whose
type says nothing takes a tier below the highest thing it is plugged into,
repeatedly, so a chain of unknowns resolves; an isolated unknown goes to the
bottom rather than somewhere arbitrary in the middle. Empty bands are closed
up, so a topology with no firewalls has no gap where the firewalls would have
been. Within a tier, order is the median of each node's neighbours in the tier
above — the standard cure for crossings — over two sweeps, because a layout
that keeps shuffling is one an operator cannot predict. Locked devices are left
where they are and reported.

**Also found and fixed while doing this: deleting a project left its history.**
A project's event timeline carries each device's *name* and the address it was
checked at. `ON DELETE CASCADE` and the `foreign_keys` pragma already handled
new deletions correctly — but nothing pinned that, and a database written
before those constraints existed still held the rows. This machine's had six.
`purge_orphans` now sweeps them at startup, and two tests hold the behaviour:
one that a delete really does take the history, so a dropped pragma cannot
break it silently, and one that a pre-constraint database is swept clean.

**And the e2e suite can now be run as a suite.** Three of the seven harnesses
took a project package as `argv[2]` and threw an unhandled `TypeError` with no
explanation when run without one, so "run the e2e tests" required knowing each
script's arguments. They fall back to `e2e/fixture.mjs` — a small invented
topology on documentation addresses — and `npm run e2e` runs the lot. All seven
pass.

**Verified live** in the browser harness: the serial appears on a device's
options and shows what the device carries, the canvas offers the arrangement,
and it puts the core above the access layer. Both are permanent checks in
`e2e/interact.mjs` now.

### LT-113 — Import: the enhancements that were being carried as "still open" — 2026-09-12
**Source:** asked 2026-09-08 — "all the enhancement you're talking about and
thinking of make them any other enhancements that you can think of make it",
alongside a repeat of the bezier request.
**Built, each with the check that would have caught it going wrong:**

1. **The bezier default is now a test, not a claim.** It shipped under LT-112
   but nothing asserted it, which is why it was reasonable to ask twice. Link
   and address construction moved out of the panel into
   `src/lib/visioImportModel.ts`, where `importedLinkData` states both of its
   departures from the diagram's own style — a curve rather than a smooth
   step, and a colour the drawing stated winning over the default — and ten
   tests hold them.
2. **A drawing that glues nothing now yields its links.** The Lucidchart
   family, and the failure was worse than "no links": a `com.lucidchart.Line`
   was not recognised as a connector at all, so every cable was imported as a
   *device*. A master is now read as a cable when its **last word** is
   connector/line/link — the last word, because `Catalyst 6500 Line Card` and
   `Inline power injector` are equipment that merely mention one, and
   matching any word turned the line card into a cable. The ends resolve by
   geometry and the links are marked not-glued, so they are flagged for
   review rather than asserted.
3. **Every address a caption carried is kept as an address.** The second and
   later ones used to be flattened into the notes as text, which is where an
   address goes to be forgotten. They are real addresses, the model already
   holds as many as you like, and a check can be aimed at one later.
4. **A `.vsd` is named rather than merely refused.** The pre-2013 binary
   format is an OLE compound file with a fixed signature, so it is recognised
   and the error says what to do about it, instead of "this does not look
   like a .vsdx file" when the fix is one Save As away.
5. **LT-108 fixed** — see that entry. One list, used by both canvas and
   export.
6. **The zoom limit under LT-112 removed** — see that entry.

**Not done, and why:** the Lucidchart drawings are no longer on this machine,
so item 2 is covered by a synthetic fixture and by reasoning about the
format, not by a measurement against a real file. Said plainly rather than
implied. The drawing that *is* available still reads 37 devices, 70 links and
62 with a port — unchanged, which is the point of re-measuring it.

### LT-107 — **bug** Links still leave a shape from only 4 points — 2026-09-12
**Source:** re-reported 2026-09-08, in the same words as LT-098 and with a
screenshot of LAB-CORE-SW1 — "I need the connector to connect to the shapes
at 360 so anywhere I move the link it moves not just 4 directions we should
have more that the 4 points off connections **this is still not done**."
**Reproduced 2026-09-08** in the Branch office sample, before changing
anything: the Core switch's link to Access switch 1 — which sits down and
to the *left* — does not run diagonally. It leaves the fixed left handle
sideways, turns a right angle, and drops down. Same on the right for the
Wireless controller. Every link is funnelled through one of four points.
**What LT-098 got wrong:** it read "anywhere I move the link it moves" as
*I drag the endpoint and it stays put*, and shipped a hand-dragged fixed
anchor. Re-read against the screenshot, it means the link should attach at
the **true bearing** to the device at the other end, anywhere around the
full 360°, and keep doing so as things move — without anyone dragging
anything. The LT-098 anchor is still useful as a manual override; it was
just never the thing that was asked for.
**Acceptance:** a link leaves each shape pointing at the device it actually
goes to, at any angle, and follows as either end is moved — with no
per-link dragging.
**Fixed 2026-09-08 — deliberately still open, pending the operator's own
confirmation.** LT-098 was moved to Done on my verification alone and was
wrong; the same claim is not worth making twice. What was built: one new
pure function, `bearingAnchor` in `src/lib/floatingAnchor.ts`, giving the
point where a ray from a shape's centre towards the device at the other end
crosses its outline. Each end now resolves in three steps — a hand-placed
LT-098 anchor if there is one, then the fixed handle if the link is
`pinnedSides` (that flag has always meant "stop moving"), and otherwise the
bearing. Wired into both places an endpoint is computed, so the export
still matches the screen (D-001): `LiveEdge.tsx` and `diagram.ts`'s
`anchor()`.
**The detail that decides whether it looks right:** a glyph device is drawn
as a *round* icon — its selection ring is a literal `border-radius: 50%` —
so measured against the bounding box a diagonal link would attach at the
box's corner, visibly off the artwork and floating in the gap. `round`
shapes are met on the inscribed ellipse; cards, notes and drawn rectangles
on the box. This is also why the node's own box is the right thing to
measure at all: `.cv-glyph-art` is `width/height: 100%` — "the artwork owns
every pixel of the node" since LT-053 — so the label underneath overflows
rather than inflating the box.
**Verified, live, before and after:** reproduced first in the Branch office
sample (the Core switch leaving sideways out of its left handle and turning
a corner to reach a device that is down and to the left), then confirmed
the links now leave the lower-left and lower-right at the true angle. Then
dragged Access switch 1 up above the switch and watched that link's
attachment travel round the icon from lower-left to upper-left — the
"anywhere I move the link it moves" half, which no static screenshot of the
end state would have shown. 520 tests pass, 10 of them new: 7 on the
geometry (including that it lands *on* the outline, that a non-square box
does not distort the bearing, and that concentric shapes do not divide by
zero) and 3 on the export.
**Confirmed on his own diagram by the operator, 2026-09-13:** "LT-107 and
LT-108: confimed".

### LT-109 — The ping sweep should resolve names, like `ping -a` — 2026-09-12
**Source:** reported 2026-09-08 — "ping sweep is not setup correctly, it needs
ping -a to try to resolve the names as well!", with a transcript showing
`ping -a 10.10.10.24` returning `Pinging sw1.corp.root [10.10.10.24]`.
**Confirmed by reading the code:** `SweepHit` is `{ ip, rtt_ms }` — the sweep
does no name resolution at all. Worse than it first looks:
`DiscoverPanel.tsx:95` sets `data.label = h.ip`, so adding swept hosts to the
diagram produces a page of devices named `10.10.10.24`, which is exactly the
labelling work the sweep was supposed to save.
**How, and why not literally `-a`:** `-a` is a Windows `ping` flag. On Linux
and macOS `-a` means *audible* ping, so passing it there would be wrong, and
on Windows the name would have to be scraped out of `Pinging <name> [ip]` —
a localized string that says something else on a non-English Windows. What
`-a` actually does is a reverse (PTR) lookup, so the portable equivalent is
to do that lookup directly and get a structured answer on all three
platforms.
**Acceptance:** a sweep shows the hostname beside each address that has one,
and adding hosts to the diagram labels them with the name, falling back to
the IP where there is no PTR record. A slow or missing reverse lookup must
not stall or fail the sweep.
**Built:** `SweepHit` gained `hostname: Option<String>`, filled by a reverse
lookup that runs only for addresses that *answered* — a /24 is 254 PTR
queries if you ask for everything, almost all of them for hosts that are not
there. It runs inside the existing per-host task, under the same concurrency
permit as the ping, so it adds no second pass. One new dependency,
`dns-lookup` (which added no transitive crates of its own), for the
`getnameinfo` call Rust's std does not expose. The results table gained a
**Name** column, and `DiscoverPanel` now labels an added device
`hostname ?? ip`, keeping the address as the probe target either way.
**The trap, and the test for it — corrected 2026-09-08 after being asked how
the name is resolved without `-a`:** the claim first written here was that
`getnameinfo` returns the numeric form instead of failing when there is no
PTR record, and that `usable_name()` was what stopped every device being
labelled with its own address. Reading the crate rather than assuming:
`dns_lookup::lookup_addr` passes `NI_NAMEREQD`, which makes `getnameinfo`
error instead of falling back, so that case was already handled a layer
down. The guard is real but defensive — it earns its place on the
trailing-root-dot form (`host.example.com.`), on empty answers, and against
that flag changing — not as the thing holding the line. The
decision is split into a pure `usable_name()` so it could be tested without
depending on what a given machine's resolver answers — including that a name
which merely *contains* the address (`10-0-0-5.static.example.net`, common on
ISP reverse zones) is kept, and only an exact match is discarded.
**Verified live, end to end:** swept `127.0.0.1/32` in the running app, which
has a PTR record on this machine. The Name column showed `localhost`, and
"Add 1 to diagram" produced a device labelled **localhost** with `127.0.0.1`
kept as its address — not a device called `127.0.0.1`. 974 tests pass, 7 of
them new. The test device was removed from the sample afterwards.

### LT-108 — **bug** The canvas and the export disagree about `callout` — 2026-09-12
**Source:** found while doing LT-107, not reported. `DeviceNode.tsx` and
`diagram.ts` each keep their own copy of the "drawn as a plain shape rather
than a device glyph" list, and the copies differ: the canvas includes
`callout`, the export does not. So a callout is drawn as a shape on screen
and as a device glyph in an exported SVG or PDF — the export does not show
what the canvas shows, which is the one thing an export has to do (D-001).
**Not fixed here.** LT-107 needed the same list and added one shared
definition — `SHAPE_DEVICE_TYPES` in `src/types/domain.ts`, matching the
canvas — but both old copies were deliberately left where they are:
changing the export's list changes exported output for callout nodes, and
that wants its own before-and-after check rather than being smuggled in
under a link-routing fix.
**Acceptance:** one list, used by both, and a callout exports as the shape
it is drawn as.
**Done 2026-09-08 (under LT-113).** Both copies deleted; `diagram.ts` and
`DeviceNode.tsx` now read `SHAPE_DEVICE_TYPES`. A test renders a callout and
an access switch in glyph mode and asserts the callout keeps its node-sized
box while the switch does not — not just "contains a rect", since the switch
symbol is itself drawn out of them.
**Confirmed on his own diagram by the operator, 2026-09-13:** "LT-107 and
LT-108: confimed".

### LT-031 — **bug** Three CSS variables that were never defined — 2026-08-30
**Source:** found while doing LT-001, not reported.
**Was:** `.cv-muted`, `.cv-warn` and `.cv-link` read `var(--cv-text-dim, …)`,
`var(--cv-warn, …)` and `var(--cv-accent, …)`. No such variables exist anywhere
in the project and never have, so all three always fell through to the
hardcoded fallback — which meant three pieces of the interface ignored the
ground entirely and stayed dark-theme coloured on a white page.
**Fixed:** they read `--text-dim`, `--warning` and `--accent`, which are the
variables that were meant.

### LT-004 — **bug** A selected shape is outlined by its own outline — 2026-08-30
The square box round the circular router glyph was the NodeResizer's line
rectangle. Every shape already draws its own highlight — the ring on a
glyph, the stroked outline on a cloud, the radius-following shadow on a
circle or diamond — so the resizer's line keeps its edge-drag hit area and
loses its paint, and the corner handles stay, which the item allows. One
specificity fight recorded: React Flow's own `.react-flow__resize-control.line`
rule outweighs a single class, which is why the first fix changed nothing.
Verified by measurement in the harness and by eye.

### LT-005 — **bug** Clearing the icon library — 2026-08-30
"clear" now sits next to "reload": it empties the palette section, forgets
the stored `iconLibraryDir` so startup stops re-indexing it, and brings the
folder input back so a different library can be chosen — without restarting
the app, and without touching anything on disk, because the icons were never
copied in. Staged and verified end-to-end through the dev store handle.

### LT-003 — **bug** Custom shape import bugs — 2026-08-30
All four, in the icon-library scan, which is the app's custom-shape door:
**The scrambling** was the sanitiser: it rebuilt the file byte-by-byte
through a Latin-1 cast, so every non-ASCII glyph in an imported SVG came out
as mojibake, and it deleted every `<image>` element wholesale, which blanked
the artwork out of any icon carrying an embedded bitmap. Text now survives
byte-faithful, and an `<image>` stays when its href is an inline
`data:image/` URI — the kind that cannot reach the network; fetching hrefs
still go. Sibling groups, paths and **nested transforms were already kept
as-written**, which is now the documented, tested choice (preserve, never
rewrite).
**Naming:** index entry, else de-slugified filename, else the filename
itself; "Untitled" only when there is genuinely nothing (`display_name`,
tested).
**Routing:** the scan now converts `.emf`/`.wmf` itself through LibreOffice —
`src-tauri/src/shapeconv.rs` is a Rust port of the PPTX pipeline's crop,
bitmap-legalising and cruft-stripping, tested against the same fixtures and
numbers, and proven end-to-end by a committed real EMF from the Cisco deck
(test gated on soffice; CI runners skip it, the soffice-missing report has
its own test). A file soffice cannot draw is skipped *by name*; a folder of
EMFs with no LibreOffice says to install libreoffice-draw instead of "N
file(s) are not SVG".
**Differs from the ask in one place:** `.lcsl` is recognised and named
("a Lucidchart stencil — its converter is not built yet") rather than
converted — the converter is LT-006, and the file it must be verified
against is no longer on this machine. Routing it lands with LT-006.

### LT-002 — Cisco PPTX stencil pipeline — 2026-08-30
Unblocked the moment the operator installed libreoffice-draw, and run for
real: 215 EMF/WMF files from the deck became 217 SVGs in 9 categories under
`stencils/cisco/`, 81% named from the caption boxes beside them (the 41
unnamed are the slide-10 third-party logos and the wireless-connector
strokes, which have no captions in the deck to take). The contact sheet was
eyeballed, which caught one last conversion bug: LibreOffice writes
EMF-wrapped bitmaps as `<image>` with a *negative height* — invalid SVG,
drawn upside down where drawn at all, and invisible to the crop, which
sliced through the three raster logos. `normalizeImages` rewrites them as
positive geometry plus an explicit mirror; test first, then the fix, then
the deck reconverted and the sheet re-checked. Committed per D-019; the app
binary still ships none of it.

### LT-045 — The icon library reads Visio files where they live — 2026-09-12
**Source:** asked 2026-08-30 — "Can I import VSS and VSSX? or point the
application to My Shapes directory and let it see my VSS and VSSX?"
**Acceptance:** pointing the icon library at a folder that holds `.vss`,
`.vssx`, `.vsd` or `.vsdx` (a Windows "My Shapes" folder) shows their shapes
in the palette next to the SVGs, converted at scan time the way EMF already
is; a stencil's masters each become their own icon, named from the master.
Files the converter cannot open are reported by name.
**Built 2026-08-30, verified as far as the files on hand allow:** the scan
routes all four extensions through libvisio (vss2xhtml / vsd2xhtml), splits
the output into one standalone SVG per master or page, crops, sanitises and
names them; a real `.vsdx` from libvisio's test suite converts end-to-end
into a named palette icon (fixture committed, test gated on the tools). The
`.vss`/`.vssx` stencil path is the same code through vss2xhtml but there is
no stencil on this machine to run it against — **awaiting one real `.vss`
and `.vssx` from the operator's My Shapes folder to verify per-master
splitting and naming before this is called Done.** Masters are currently
named "<file> 1..N"; real master names, if wanted, are a follow-up.

### LT-058 — The Cisco shapes ship in the installer — 2026-08-31
**Source:** "Change this statement you can bake into the installer please" —
overruling the D-019 rider, logged as D-022.
`stencils/` is bundled as a Tauri resource (~2 MB) and a `list_bundled_icons`
command scans it with the same scanner as a user folder; the palette grows a
built-in "Shape library" section — grouped, searchable, draggable — that
loading or clearing the operator's own folder never touches. Verified: the
repo's real stencils folder scans into 217 named, categorised icons (Rust
test); the palette section, search and clear-independence run in the
harness; the resource config passed context generation. **The last inch —
the resource actually landing inside the NSIS/MSI/AppImage — is proven by
the CI bundle jobs and then by the operator's next install: the palette
should open with the Cisco set in it, no folder to point at.**

### LT-051 — Drag a link label along its link — 2026-08-31
The centre label takes the pointer and slides: while dragging, the cursor
roams and the label takes the nearest spot on the drawn path — it cannot
leave the link — and on release the fraction is stored on the link
(`labelAt`), undoable, saved with the document. An untouched link keeps
React Flow's own midpoint, so nothing already drawn moves. One cost taken
knowingly: the label used to be transparent to the pointer so hovering the
line through it worked; a thing you drag has to take the pointer.
**Differs from the ask in one place:** the SVG/PNG export still draws the
centre label at the midpoint — the export knows the chord, not the drawn
path. Say the word and it learns.

### LT-052 — Double-click a link to write flat text on it — 2026-08-31
Double-click a spot on a link and a caret opens right there; the committed
text renders flat — no box, no border, mono ink with the canvas halo —
attached to the link at that spot, draggable along it like the centre label,
edited by double-click, removed by committing nothing (so a stray
double-click leaves no debris). Stored per-link (`texts`), undoable, saved.
Same export caveat as LT-051.

### LT-059 — **bug** The bundled Cisco shapes did not appear in the installed app — 2026-08-31
As suspected: Tauri places resources whose source lies outside `src-tauri/`
under a `_up_/` prefix in the resource directory, so
`resolve("stencils", Resource)` looked where nothing was. The map form of
`bundle.resources` pins the target path, and the proof is a locally built
.deb: 217 stencil SVGs at `usr/lib/Coreview/stencils/`, zero `_up_` paths.
Confirmed on the operator's machine once the next installer is on it.

### LT-061 — A device's check targets its address by itself — 2026-08-31
The primary check follows the primary address: a device that gains an
address gets a check aimed at it, changing the address moves the check, and
a target the operator aimed by hand is never overwritten from the address
side. Crawl-placed devices arrive monitored whether or not they were logged
into — ticking the row was the decision, and the old reached-only rule was
what left "Seen by a neighbour" devices with a target of "—". Ping-sweep and
CSV already did this. Harness-verified end to end.

### LT-062 — A new device joins a running validation — 2026-08-31
No more stop/start: the engine holds one cancellation token per probe and
can bring a running session's targets in line with the document — a check
added mid-session starts producing samples within one interval (staggered
like the rest, behind the same concurrency cap), a removed one stops, a
changed one restarts with its new settings. The store watches its own probe
list and pushes the change debounced, which covers every path — inspector
edits, discovery adds, undo, restore — without wiring each one. Proven live:
a real engine, real pings, a probe added mid-session sampled and a removed
one went silent.

### LT-009 — Draw a port-channel as one link — 2026-08-31
The operator bonded Gi1/0/11 + Gi1/0/12 between the 9300 and the 3850 as
Po1, and the whole path was built against that live LAG the same hour:
`show etherchannel summary` captured verbatim from both switches through the
crawler's own login, a parser for it (continuation lines, static bundles,
the empty table), the crawl asking every IOS device and carrying bundles to
the front, and the topology fold — a cable folds into its bundle when either
end's table says its port is aggregated, either because a crawl often
reaches only one of the two switches. Unbundled parallel cables still draw
as two links: D-014's line holds — the switch's own table, never inference.
**Found live on the way:** MACs learned across a LAG report on Po1, not on
the member port, so the uplink filter missed them and the entire far side of
the network appeared "attached" to the 9300; a bundle whose member is an
uplink is now an uplink itself.

### LT-060 — **bug** The 9300 still refused login after the kex fix — 2026-08-31
Reproduced from this machine with the crawler's own code: transport now
negotiates fine (the LT-054 fix holds — kex ecdh-sha2-nistp384, hostkey
rsa-sha2-512), and then the refused password attempt kills the session.
`ip ssh server algorithm authentication keyboard` means IOS-XE does not
merely decline a password try — it tears the connection down, and the
keyboard-interactive fallback that would have worked never got to run
("Channel send error"). The crawler now asks first: a `none` query learns
the advertised methods, password is attempted only where the server takes
passwords, and a server advertising nothing goes straight to
keyboard-interactive — whose prompt on this box is literally "Password: ",
which the existing prompt-matching answers. Proven live: the crawler's own
Device path logged into 192.168.77.20 and ran commands. The `raw_login`
diagnostic also now uses the crawler's algorithm offer instead of russh
defaults, so it diagnoses the client that actually failed.

### LT-053 — The edit corners hug the shape — 2026-08-31
**Source:** asked 2026-08-30 with a screenshot ("many times i told you the
shape should have no boarders and the edit corners should be close to the
shape not far away") — and filed only now, which broke the file-first rule;
the work itself went test-first as required.
The glyph node was an invisible 168x92 box with a 46px icon floating in it:
resize corners, connection dots and the ends of links all sat on the box,
nowhere near the drawn shape, and resizing changed nothing visible. The
node's bounds are now the art itself — the icon fills the node (resizing
finally scales it, aspect kept), the label hangs below without counting
toward the bounds, new devices drop at 76x76 square, and links terminate on
the shape's edge instead of in the air beside it. Three consequences, each
caught by the harness: the artwork owns no pointer events or it eats every
click meant for the node; the resize controls stack above the full-bleed
art; and the connection dots' positions were hardcoded to the old 46px art,
clustering all four at the node's top where a drag-grab landed in a
handle's hit area and became a connection attempt.

### LT-057 — **bug** The spacing snap could never fire on its own — 2026-08-31
Found while testing LT-053, not reported. The even-spacing rhythm competed
against the edge snap by comparing corrections — but with no edge in reach,
"stay where you are" costs zero and always won, so the rhythm only applied
when an accidental edge alignment coexisted (the old 176x96 fixture provided
one, hiding the bug). It now competes only when an alignment actually
snapped; the guide-and-land harness check fails without it.

### LT-046 — Chrome stays dark; only the diagram area follows the ground — 2026-08-31
Supersedes LT-034's light chrome, at the operator's word. The `.is-light`
block now carries nothing but the drawing surface — white page, warm
light-brown desk (#E9E2D3), its grid, inks and a `--canvas-accent` — and the
chrome tokens are simply never remapped, so the panels stay the approved
dark in both grounds. Canvas elements were moved off the chrome tokens onto
the ground set (`--ink`, `--page`, `--desk`, `--canvas-accent`): node cards,
labels, edge chips, connection dots, selection rings, the text halo. Print
forces the canvas set to paper values, which the harness caught. The desk
harness block asserts the new contract, both-ground screenshots are in
docs/checkpoints/2026-08-31-canvas-{light,dark}.png, and the dark ground is
bit-for-bit untouched.

### LT-050 — Port labels sit at the ends of a link — 2026-08-30
Chips now ride the drawn path a fixed distance from each end — beside their
own device — instead of a third of the way along the straight chord, which
was the middle of the room. The centre label is untouched. Verified by
measurement (a chip must sit far closer to its device than to the other
end) and by eye against a staged pair.

### LT-055 — **bug** Two parallel links both labelled Gi1/0/11 — 2026-08-30
Same root as LT-050: parallel cables out of one handle share the straight
chord, so their chips stacked exactly and "Gi1/0/12" sat hidden underneath
"Gi1/0/11". On the drawn path, edges sharing a start point are ranked by id
and each rank slides one chip-length further along the trunk, so every
cable's port is readable. The lab picture itself still wants a re-crawl
once a build with LT-054's kex fix reaches the 9300.

### LT-054 — **bug** The Catalyst 9300 refuses our SSH: no common kex — 2026-08-30
First live contact with the 9300 (LT-010) and the crawler could not even
shake hands: the box is locked to `ip ssh server algorithm kex
ecdh-sha2-nistp521 ecdh-sha2-nistp384` — the pair the IOS-XE hardening
guides recommend — and russh's defaults do not offer NIST ECDH at all. The
offer list now carries nistp521/384/256, biggest curve first, below the
modern curves and above the SHA-1 tail; the failing test reproduces the
box's exact offer. Keyboard-interactive auth (`authentication keyboard`, the
other half of that config) was already implemented as a fallback. Needs the
operator to rerun the crawl against 192.168.77.20 from a build with this in
it before LT-010 can be called tested.

### LT-047 — Zoom without walls — 2026-08-30
The wheel now runs 0.01x–100x — no real diagram meets either end. Fits keep
the old 2x ceiling on purpose: fitting two close devices with no ceiling
turned them into one monitor-filling glyph, which is how this item briefly
broke half the harness. Two ripples were paid for honestly: the mount-time
fit needed its own explicit cap once the provider bounds blew open, and
below the old 0.5x fit floor the harness's fixed-corner clicks could land on
a neighbour — those checks now aim at the glyph's own pixels. The recovery
writer also stopped running under automation (navigator.webdriver): an
environmental mid-run reload armed a perfectly correct banner whose 34px
shifted every measurement after it, and the harness plants its recovery
slots directly, so no coverage was lost.

### LT-048 — **bug** "Healthy" unreadable on its green chip — 2026-08-30
Three components shared the class .cv-chip, and the filter-chip rules later
in the stylesheet clobbered the status pill's ink — dim grey on bright
green, exactly "not white enough". The pill is .cv-status-chip now, painted
with --on-status as designed, and a harness check measures the painted
contrast (was 1.27:1, must clear 4.5:1). The two button-chip blocks still
share a name and fight over padding; noted, not reported, left alone.

### LT-049 — **bug** A text box draws a border — 2026-08-30
Selected text no longer wears the box selection rectangle, and a text node
offers no connection handles — a label is not something a cable plugs into
(the follow-up ask in the same message). Border was already transparent;
resize handles remain, as allowed.

### LT-133 — **bug** A crawl still duplicates hosts the sweep placed — 2026-09-12
**Source:** the same crawl, 2026-09-12, and the same complaint as LT-126 —
the diagram shows the swept hosts floating in a block at the top and the
crawled tree built separately below, joined to nothing. His change report:

```
Gone 5   192.168.77.215, LABAP431F0002.local (…24),
         host.docker.internal (…129), fabricforge.local (…213),
         NAS000001 (…221)
New 5    LAB-CORE-SW1 (…7), LAB-ACC-SW (…112), LAB_AP431F_0002 (…141),
         LABDESKTOP01 (…129), S224ENTF00000001 (…203)
```

**What LT-126 actually fixed, and what it did not.** It gave attached devices
— the MACs a switch reports on its ports — a multi-key lookup, and that half
works. It left the *crawled* devices, the ones a crawl reached or a neighbour
announced, still matching on the single `identity()` key through
`alreadyDrawn`. So `LAB-CORE-SW1` at `192.168.77.7` never recognises the
`192.168.77.7` the sweep drew, and both are kept.
**This is the report LT-126 was raised for, not a new one.** It was called
done on the strength of a test that only exercised the attached path.
**Fix:** the crawled-device path uses the same multi-key index — MAC, then
every address, then the name.
**Acceptance:** sweep a subnet, add the hosts, crawl it, and a device found
both ways is one node. Proven against the shape of his own run, not a
two-device fixture.
**Fixed 2026-09-12.** The crawled-device path uses the multi-key lookup that
LT-126 gave the attached devices: its own key, then the address, then the
name. `LAB-CORE-SW1` at `192.168.77.7` is now the `192.168.77.7` the sweep
drew, and `LABDESKTOP01` is the host at `.129` whatever the sweep called it.
**And a second fault it immediately exposed:** attached devices were anchored
by searching only the nodes *this run created*. The moment a crawled switch
could be an existing node, that anchor lookup found nothing and every port on
that switch went unlinked — the cable disappeared from the very case being
fixed. It now looks at what is already drawn as well. Caught by the harness
within a minute of the first fix, not by reading.
**Verified** in `e2e/join.mjs`, rebuilt around his run: two hosts swept — one
named, one labelled with its address because nothing named it — then a crawl
that meets both under different names. The diagram ends with two devices, not
four, and the cable on the right port.

### LT-132 — **bug** Every host labelled with an address has the same identity — 2026-09-12
**Source:** found 2026-09-12 while reading the change report from his own
crawl, which listed `host.docker.internal (192.168.77.129)` as **gone** and
`LABDESKTOP01 (192.168.77.129)` as **new** — one machine, one address, two
devices.
**Measured, not inferred.** `identity()` strips a domain suffix by cutting at
the first dot. An address has dots:

```
identity('192.168.77.7',   …) -> n:192
identity('192.168.77.129', …) -> n:192
identity('host.docker.internal', …) -> n:host
```

**So every device the sweep labelled with a bare address collapses into the
same key `n:192`** — a whole subnet is one identity — and a hostname whose
first label is generic (`host.docker.internal`) becomes `n:host`, which the
next such name collides with too. The MAC guard added for
`7456.3c00.0001` was the same class of fault, caught once and not generalised.
**Fix:** a label that parses as an address is not a name, so it keys on the
address. Cutting at the first dot is only right for a hostname.
**Acceptance:** two swept hosts on one subnet have two identities; a test that
fails without the fix.
**Fixed 2026-09-12.** A label that parses as four dotted octets keys on the
address; the domain-stripping is for hostnames, which is all it was ever for.
`192.168.77.7` and `192.168.77.129` are now two identities rather than one,
and `SW1.example.com` still folds to `n:sw1`.

### LT-135 — A scan remembers what it was told last time — 2026-09-12
**Source:** asked 2026-09-12 — "when I install the Coreview app on my computer
it doesn't save the SNMP, SSH and other credential I want it saved so I can
redo the scan over and over withough having to type over and over, i just
don't want any secrit I type in my app or provide you here gets pushed to the
github except the signing certifiate and what I put on the git hub".
**He is right, and the vault is not the missing piece — it already exists.**
`vault_commands.rs` stores and reveals both SSH and SNMP credentials,
encrypted, locally. What is missing is that nothing *reaches* for them: every
field in `CrawlPanel` is a plain `useState('')` — seed, username, password,
enable, port, community, the v3 user and its auth and privacy settings, hop
limit, subnets — and so is the picked credential's id. Close the app and
every one of them is blank again, vault or no vault.
**The split this needs, and it is the whole design:**
- **Secrets go to the vault and nowhere else** — password, enable secret,
  community, v3 auth and privacy passphrases. Already encrypted, already
  local, already has a picker.
- **Everything that is not a secret goes to settings** — the seed address,
  the subnets, the port, the hop limit, the SNMP version, the v3 user name
  and which auth and privacy algorithms — so a repeat scan is one button.
- **The chosen credential is remembered by id**, so the vault is unlocked
  once and the scan repeats without a second thought.
**Never:** a password in `settings`, in a project file, in an export (D-006)
or in the repository. The operator restated that in his own words and it is
already the standing rule.
**Acceptance:** set a scan up once, close the app, reopen it, unlock the
vault, and press scan. Nothing retyped.
**Done 2026-09-12.** Ten `scan*` keys added to the settings allow-list — seed,
subnets, port, hop limit, the SSH and SNMP credential ids, and the SNMP
version, user and algorithms. The panel restores them on mount and saves as
they change, so a run set up and then abandoned is still there tomorrow.
**Not one secret among them.** The settings table is plain text in the same
database as the projects, so passwords, enable secrets, community strings and
v3 passphrases stay in the encrypted vault and are referenced only by
credential id. `e2e/scansettings.mjs` types five deliberately distinctive
secrets and asserts none of them appears anywhere in what was stored — and
that the v3 *user* does come back while its passphrase does not.
**Two things found while doing it:**
- The vault has held SNMP credentials all along and `start_crawl` has taken a
  `snmpCredentialId` all along — but nothing in the interface ever offered
  one or sent one, so the SNMP half of the vault was unreachable from a
  crawl. The picker is now there.
- `SubnetList` seeded its rows once, which is right while someone is typing
  and wrong when the list is set from outside: a restored scan handed it
  subnets it never displayed. It now adopts an incoming list when that
  differs from what it last emitted, which is a no-op during typing.

### LT-130 — Every new link defaults to Bezier, whatever made it — 2026-09-12
**Source:** asked 2026-09-12, and not for the first time — "l've been asking
you to default the links path to to bezier no matter how we build the topolgy
witehr import visio and i beleive thats working right not, or discovery or
manual all they should defualt link path to bezier please we change to others
if needed but defualt is bezier".
**He is right that it is half done, and right about which half.** The Visio
importer asks the document for its default style and gets it
(`visioImportModel.ts`); nothing else does. Every other creator writes
`pathType: 'smoothstep'` by hand:

- `topology.ts` — discovered links and attached links, so every link a crawl
  draws
- `Canvas.tsx` — a link drawn by hand
- `CsvImportPanel.tsx` — a link from a CSV

**Why the default did not save them.** `store.addEdge` *does* apply the
document's default style (LT-079), but as `{ ...style, ...edge.data }` — what
the caller set explicitly wins, which is right for a crawl that means to mark
a link red, and wrong for a creator that only ever filled the field in because
it had to. The creators were overriding a default they had no opinion about.
**Fix:** the built-in default becomes Bezier, and the creators stop naming
style fields they do not mean, so the document's default reaches them. A
leader line to a note stays straight, which is not a style choice — a curved
pointer at a label is just harder to read.
**Acceptance:** draw a link by hand, run a crawl, import a CSV and import a
Visio drawing; all four arrive Bezier. Changing one afterwards still works,
and saving a different default still overrides the built-in one.

**Done 2026-09-12.** `BUILT_IN_LINK_STYLE.pathType` is `bezier`, and the four
creators no longer name a style they have no opinion about — they pass only
what the link *means* (its ports, label, health rule) and `store.addEdge`
supplies colour, path, direction and width from the document's default. So a
saved default still wins, and a crawl that deliberately marks a link still
wins over that.
**One deliberate exception:** a leader line to a note stays straight. It
points at a label rather than joining two devices, and a curved pointer is
harder to follow.
**Verified in the running app, not just in tests:** `e2e/interact.mjs` drags a
link between two devices and reads the path type back off the store;
`e2e/join.mjs` does the same for a link a crawl drew. Unit tests cover that a
discovered link names no style at all.
**Two existing tests changed, and it is worth saying why.** Both asserted the
old default was `smoothstep`. One was simply the default's value and now
tracks it. The other — the Visio importer's "a curve whatever the diagram
default is" — proved its independence *by* that contrast, which the change
destroyed; it now hands in a deliberately orthogonal default and checks the
import is still a curve, which is what it meant to test all along.

### LT-129 — **bug** A traceroute that runs long threw away what it found — 2026-09-12
**Source:** reported with a screenshot — "Traceroute to `aws.com`" and, in
red, "traceroute did not finish within the timeout". No hops, no partial path.
**Reproduced** with the app's own arguments against the same target from a
machine on his network: nine genuinely useful hops — the gateway, then the
ISP's edge and backbone — then the target drops the probes and it runs to the
30-hop limit without ever arriving. 21 dead hops.
**Why Windows and not here.** The run gets a 30-second wall clock. Linux
`traceroute` probes several hops at once and finished this in 10.3s. Windows
`tracert` is strictly sequential: 21 dead hops x 3 probes x 2s is 126 seconds
of waiting alone, so on Windows this target could only ever time out.
**The defect was what happened at the deadline, not the deadline.** stdout was
piped and only read *after* the child exited, so the kill discarded every hop
already printed. The answer was sitting in the pipe.
**Fixed:** the pipes are drained into shared buffers from the moment the child
starts, so a kill cannot lose what arrived first, and a run that is cut short
returns its hops marked `complete: false`. The panel shows them and says the
trace was cut short rather than presenting a truncated path as a whole one.
The deadline is only reported as an error when there is genuinely nothing
else to report.
**One trap found while fixing it, by the test:** the first version still hung
for the full thirty seconds. `read_to_string` waits for end-of-file, and
killing a child does not reliably close its pipe — anything it spawned
inherits the handle. Reading incrementally into a shared buffer and taking
what is there is what actually bounds it.
**Verified:** five new tests, one of which failed against the first fix and
caught that hang. The cut-short path is tested with a command that prints and
then refuses to exit, so it needs no network and no slow host.
**Not fixed, and not a fault:** AWS still will not answer. A path that ends in
stars is a real answer and now displays as one.

### LT-128 — **bug** The move to the new repo left the installer unsigned — 2026-09-12
**Source:** reported with a screenshot — Chrome refusing the artifact,
"coreview-windows (15).zip / Dangerous download blocked" — and "hum".
**Cause, read off the run rather than guessed.** The bundle job's own
annotation said it: "No certificate configured - this installer is UNSIGNED."
`WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD` were configured on
`malmoola/Coreview` and GitHub does not carry Actions secrets to a new owner,
so every build since the move was unsigned. Not caused by LT-121, LT-123 or
LT-127 — the signing step was untouched and correct, it had nothing to sign
with.
**Fixed by the operator re-adding both secrets**; nothing here ever held them
(D-006). Verified on run #4: the annotation now reads "Signing as
L=San Antonio, S=TX, C=US, O=COREVIEW-APP, CN=COREVIEW-APP Code Signing —
thumbprint 7996CE1E0E6F9232D55D922CAC594E4EE3C23957", which is the *same*
thumbprint LT-011 recorded from run #98 on the old repository. Same
certificate, so this is a restoration rather than a new one.
**What it does not fix, said before it was tried and repeated here.**
SmartScreen and Chrome's Safe Browsing key on a publicly-trusted OV/EV
certificate and on reputation. `COREVIEW-APP-Root-CA` is internal and cannot
give either, so a browser may still refuse the download on a machine that
does not trust it. That is LT-011's other half, **declined under D-023** —
"the internal-CA signing that already works is enough" — not a fault.
**Also worth keeping:** the first thing pasted while hunting for this was the
public root CA certificate, which carries no private key and cannot sign
anything. The signing certificate is a leaf issued by it.

### LT-121 — The ping sweep identifies what it found — 2026-09-12
**Asked:** "ping sweep doens't retune names and useful info to discover the
network but if I run angry ip or advance ip scanner or auvik it gets a lot
more useful info like hostname, ports, manufacture, mac address ,...etc".
**Shipped, and measured against the operator's own 192.168.77.0/24** — the
same subnet as the screenshots, from a machine on it:

| | before | after |
|---|---|---|
| hosts named | 1 of 16 | 5 of 16 |
| MAC address | none | 15 of 16 |
| manufacturer | none | 15 of 16 |
| open ports | none | 14 of 16 |

The sixteenth is the machine running the sweep: a host has no ARP entry for
itself, so it shows a dash rather than a guess.

**Where a name now comes from,** best first, all four asked at once so
identification costs about one timeout rather than four:
- **Reverse DNS**, as LT-109 built it.
- **LLMNR** on the multicast group — `LabDesktop01`, capitals intact. Windows
  answers nothing at all when this is sent unicast to its own port 5355; both
  forms were measured before anything was written.
- **NetBIOS** node status — `NAS000001`, which is what Advanced IP Scanner
  shows for the same host.
- **mDNS** reverse PTR — this found `LAB-OFFICE-AP-0001` and `LABAP431F0002`,
  two hosts with no PTR record of any kind that were dashes in his screenshot.

**MAC and manufacturer** come from this machine's own neighbour table, which
the ping has already populated — nothing extra is sent. One parser reads all
three platforms' spellings (`/proc/net/arp`, Windows `arp -a`, macOS
`arp -an`). Only ever for hosts on this segment: ARP does not cross a router,
so a routed sweep shows a dash rather than the gateway's address, which is
the correct answer and comes for free.

The OUI table now reads the **MA-M and MA-S registries** as well as MA-L, and
longest prefix wins. Without that, a Proxmox host on his network reported
"IEEE Registration Authority" — true, and useless. It now says "Shenzhen AZW".

**Open ports**: a TCP connect scan of eighteen ports chosen to identify a
device rather than to be exhaustive. No raw sockets and no privilege, so the
app still runs as an ordinary user. His Catalyst shows 22/23/80/443, the Palo
Alto 22/443, the QNAP 22/139/443/445/8080.

**Both switchable from the panel** and on by default. A whole /24 takes 4.1
seconds.

**Verified:** 16 checks in `e2e/discover.mjs`, driven with the rows the live
run actually produced; the wire format is pinned by a test because it is a
contract TypeScript cannot check; the three name parsers are tested against
responses captured from his network and committed as fixtures.

### LT-122 — What else would make Coreview the one tool that does it all — 2026-09-12
**Asked:** "I want coreview to be better and only tool that does it all /
search the internet for things we could add to it and make it better".
**Delivered as a prioritised list**, ranked by value to him over cost here,
and put in front of him to choose from. Nothing was built from it. In order:

1. **Switch-port mapping** — search a MAC or IP, get device + port + VLAN.
   Netdisco's whole reason to exist. The crawler already reads MAC tables.
2. **Config-backup diff viewer** — backups are already captured; this is a
   diff and a side-by-side view. Already wanted independently.
3. **Device type/role identification** from SNMP sysDescr, CDP/LLDP platform
   strings and the OUI — so a swept host lands on the canvas as a switch
   rather than a grey box.
4. **SNMP interface inventory** (ifTable, descriptions, status, VLAN) — feeds
   LT-027's colour-by-VLAN directly.
5. **Inventory export to CSV** of everything discovered. Cheap; the export
   plumbing exists.
6. **A–B path trace drawn on the canvas** — NetBrain's flagship.
   `traceroute.rs` already exists.
7. **Wake-on-LAN and quick actions** (SSH / RDP / HTTP / share) from a
   discovered host — removes the reason to keep Advanced IP Scanner installed.
8. **Saved scan profiles and favourite ranges.** Not the declined scheduled
   re-crawl (D-023) — just remembering ranges, run on demand.

Worth considering later: passive discovery by listening for mDNS/SSDP/NetBIOS
announcements; custom fields plus conditional formatting; banner grabbing.

Explicitly **not** recommended: Nmap-grade OS fingerprinting (raw packets,
root, a 2,600-signature database, and frequently wrong — sysDescr and OUI beat
it on managed kit); remote Windows shutdown; NetFlow/sFlow traffic analysis,
which is a different product.

Numbers 1, 3 and 4 overlap LT-125 and LT-126, filed the same day.

### LT-123 — The offline Windows installer is no longer built — 2026-09-12
**Asked:** "lets do all the installers except the offline insaller I don't
wnt it now and its takeing too much space".
**Done:** the `bundle-windows-offline` job is gone from
`.github/workflows/build.yml`. It was a second Windows build that rewrote
`webviewInstallMode` to `offlineInstaller` and produced a ~500 MB NSIS exe and
MSI carrying the whole WebView2 runtime.
**Everything else still builds:** NSIS and MSI for Windows, `.deb` and
AppImage for Linux, the universal `.dmg` for macOS, and the AppImage smoke
test. Four jobs where there were five.
**If that machine ever turns up** — no internet *and* no WebView2 — the job is
in the history rather than in the workflow, and the comment in the `bundle`
job says so.

### LT-106 — A macOS build, as a .dmg — 2026-09-08
**Source:** asked 2026-09-08 — "but can we make a macOS version? i think dmg
file" / "so i can run the app on my mac book pro." The goal was the app
running on the operator's own MacBook Pro, not merely a file that exists.
**The constraint that shaped it:** Tauri cannot cross-compile a macOS
bundle from Linux — the same reason `build.yml`'s own header already gave
for Windows — and `.dmg` creation needs `hdiutil`, which exists nowhere
else. So none of this was buildable or testable on the machine this repo
is developed on. It had to be a `macos-latest` CI job, and verification
from here could only ever reach "CI produced the artifact."
**Built:** a `bundle (macOS, universal .dmg)` job, its own job rather than
a third leg of the `bundle` matrix — the same reasoning the offline
installer already uses, so a platform that cannot be tested from here can
never fail the bundles that can. Universal (`--target
universal-apple-darwin`, both Apple targets added to the toolchain) rather
than the runner's own Apple Silicon, because an Intel Mac cannot run an
arm64 build at all and a download does not get to ask which Mac it is
landing on. `bundle.targets` gained `app` and `dmg`, and `bundle.icon`
gained the `.icns` the macOS bundler needs — generated from the existing
`icon.png` by the Tauri CLI, which does that without a Mac; the other
icons were left alone, since they are deliberate placeholders (see
`src-tauri/icons/README.md`) and re-cutting them was not what was asked.
**The risk worth checking, checked:** adding macOS targets to a shared
`targets` list could have broken the two platforms that already worked.
Ran the full Linux release bundle locally afterwards — still exactly the
`.deb` and the AppImage, exit 0. Tauri filters targets by host platform,
which is also why `nsis`/`msi` had always been silently skipped on Linux.
CI then confirmed it: every pre-existing job (both test jobs, the Linux
bundle, both Windows bundles, the AppImage smoke test) stayed green on the
same commit.
**Unsigned, and that shows:** there is no Apple Developer certificate the
way there is for Windows, so macOS quarantines the download and reports it
as "damaged", which it is not. The `xattr -dr com.apple.quarantine` line
that clears it is written into `docs/HANDOVER.md` §6.8 — along with why
right-click → Open is not the instruction to give, since it works on some
macOS versions and not others — rather than left to be discovered. Proper
signing plus notarisation is the real fix and is noted there as the thing
to do before anyone who did not build it gets a copy.
**Verified:** the job went green first time (16 min), and the artifact
upload carries `if-no-files-found: error`, so a green upload is real
evidence a `.dmg` exists at the expected path rather than a compile that
merely finished. **The half this machine cannot do — that it installs and
opens — was confirmed by the operator on his own MacBook Pro** ("mac
worked"), which is the only place that check exists.

### LT-105 — Cisco shapes as real (vector) shapes, not embedded pictures — 2026-09-07
**Source:** asked 2026-09-07 — "can we turn all the cisco shapes to real
shapes not just pictures?" `src-tauri/src/icons.rs`'s own test
`keeps_embedded_bitmaps_but_not_fetching_ones` confirmed the icon pipeline
does deliberately preserve an embedded raster image where a source stencil
has one rather than converting it to vector paths — a real, specific gap,
not a misunderstanding. Left unscoped rather than promising a fix sight
unseen, since redrawing artwork by hand for an unknown number of shapes
could have been a small correction or a large undertaking.
**Scoped 2026-09-07:** counted it. Of 217 SVGs under `stencils/cisco/`,
only 12 contain an embedded `<image>` at all — the other 205 already draw
with real vector paths (`stroke="currentColor"`) and are already fully
recolourable today, which is most of what "all the cisco shapes" was
worried about. Of those 12, 10 live under a `3-rd-party` folder with
generic names (`image196.svg` etc.) — rendered, one turned out to be the
VMware vCenter logo: bundled third-party vendor logos, not Cisco shapes,
and not reasonable to recolour even if they were vector (that would
misrepresent someone else's brand mark). The remaining 2 —
`lan-switching/6500-vss.svg` (a VSS switch icon) and
`wifi-indicator/3g-4g-indicator.svg` — are genuinely Cisco shapes that are
entirely one embedded picture apiece (each file has exactly one `<image>`
and exactly one `<path>`, and that path is only the outer border). The
real scope was 2 icons out of 217, not "all" of them.
**Resolved 2026-09-07, given that count:** left as-is. 2 icons out of 217
was judged not worth hand-redrawing for how little it would change; the
icon pipeline's existing bitmap-preserving behaviour is intentional
elsewhere and stays exactly as it is.

### LT-099 — The status history strip: scrub it, and see more of it — 2026-09-07
**Source:** asked 2026-09-07, alongside LT-097/098 — "for the status line I
need a position line to drag and also I need to klick it and it enlarges
so I can see more details about the status." The "Recent status" strip in
the inspector (`StatusStrip` in `src/components/inspector/Inspector.tsx`)
— the coloured history bar with 15m/1h/6h window buttons.
**Built:** the strip tracks the pointer — no click-and-hold needed, since
a horizontal timeline reads its position from where the cursor already is
— with a thin line at that exact spot and a line underneath reading out
the real time and status there, formatted the same way the transition log
below it already is, a finer answer than the coarse,
per-segment native tooltip the bars already had. Clicking the strip
toggles it to a taller, easier-to-read version of itself (12px to 40px)
and, together with it, the transition log already underneath (LT-074)
both shows more entries (12 to 40) and grows the scrollable area they sit
in (148px to 360px) — answering "see more detail" with more of the actual
data the strip already has behind it, not just a bigger picture of the
same dozen pixels.
**Verified live, through the actual running app:** moved the pointer
across the strip and watched the scrub line and its time/status readout
track it continuously; clicked the strip and watched it grow taller in
place, with the readout still tracking; clicked again and watched it
collapse back. Transient UI state only — nothing here is saved with the
project, so there was nothing to clean up afterward. `npx tsc --noEmit`,
`npm run lint`, and `npx vitest run` (510 tests, unchanged — this is
inspector-only presentation, nothing new to unit-test beyond what the
existing timeline/formatting libraries already cover) all clean.

### LT-098 — More than 4 link connection points per shape — 2026-09-07
> **Reopened 2026-09-08 as LT-107 — this did not do what was asked.** The
> operator re-reported it in the same words, with a screenshot: "this is
> still not done". What shipped below is a hand-dragged fixed anchor; what
> was wanted is the link *automatically* meeting the shape at the true
> bearing to the other device. Kept here as the record of what was built
> and misread; the correction is LT-107.

**Source:** asked 2026-09-07 — "I need the connector to connect to the
shapes at 360 so anywhere I move the link it moves not just 4 directions
we should have more that the 4 points off connections." A device had
exactly four fixed handles — top/right/bottom/left, `DeviceNode.tsx`'s four
`<Handle>` elements.
**Resolved 2026-09-07:** the bigger option over more fixed handles at finer
angles — a link's end lands anywhere on its device's perimeter, dragged
there directly, and stays exactly there (not a point that keeps re-homing
itself to wherever is nearest as the *other* end moves — dragging sets a
fixed spot on this one device, the same idea as diagrams.net's fixed
connection points, not a "floating edge" that recomputes on every move of
the far end).
**Built:** `LinkData` gained `sourceAnchor`/`targetAnchor` — a point
normalized to the device's own bounding box (`x`/`y` each 0..1, one of
them always pinned to 0 or 1 so it sits on the perimeter) rather than a
fixed pixel offset, so a resize just recomputes the same relative point
for free instead of stranding it. The geometry is one new pure module,
`src/lib/floatingAnchor.ts` (`anchorPoint`, `nearestAnchorOnBox`,
`nearestSide`), shared by both places a link's endpoint gets computed: the
live canvas (`LiveEdge.tsx`, which now shadows the plain `sourceX`/
`sourceY`/etc. names it already threaded through path, port-label and
corner-drag logic, so nothing downstream needed to change) and the SVG/PDF
export (`diagram.ts`'s `anchor()`). Each end gets a new drag handle — a
small ring right at the connection point, visible whenever the link is
selected — that follows the cursor while held and snaps to the nearest
point on that device's box on release; double-click puts that one end
back on automatic without touching the other. Reuses the already-existing
`pinnedSides` flag (it stops a link swinging to a different side as
devices move) rather than inventing a second one, since a link with an
explicit anchor obviously should not auto-reswing either. The one explicit
"Route links" action, which forces every link back to its computed
default regardless of `pinnedSides`, now also clears any anchor it
overrides — otherwise a re-routed link would keep quietly ignoring its own
new side.
**Scoped out, deliberately:** the Visio export (`visio.rs`) still glues to
one of the 4 sides — carrying a normalized bounding-box point into Visio's
own connection model is real, separate work, and every other export path
(SVG, PNG, PDF, all of which share `diagram.ts`) already reflects the
true point.
**Verified live, through the actual running app:** selected a link,
dragged its source end from the bottom of a device to its left side and
watched the line visually reroute there immediately; saved, fully reloaded
the app, reopened the project, and confirmed the same custom attachment
point survived (not just an in-memory drag); double-clicked the handle
and watched it snap back to the original fixed-side position. `npx tsc
--noEmit`, `npm run lint`, and `npx vitest run` (510 tests, 13 new — 12 for
the geometry module, 1 for the export path) all clean.

### LT-104 — Save a canvas shape back into the shape library — 2026-09-07
**Source:** asked 2026-09-07 — "can we give admin the ablility to past
shape into the diagram page then drag it to the shape library?" Read as:
place/customise a shape on the canvas, then get it back into the palette
as a new reusable stencil — turning a one-off customisation into something
reachable again without repeating it.
**Resolved 2026-09-07,** two scoping questions asked directly rather than
guessed, since both were real forks with a meaningfully larger option on
one side: **where the shape lives** — this project's own document (chosen)
versus a shared library available everywhere, which would have needed a
whole new persistent store, not just this project's own already-opaque
JSON (D-002); and **how it gets there** — a "Save to shape library" item on
the existing right-click menu (chosen) versus true drag-and-drop off the
canvas, which would fight React Flow's own pointer-based node dragging for
the same gesture and — per this project's own established knowledge,
`paletteDrop.ts`'s header comment — can only ever be verified by hand,
never by an automated test.
**Built:** `ProjectDocument.customShapes?: IconLibEntry[]` — reusing the
icon library's own entry shape rather than inventing a new one, so a
captured shape drops into the palette's existing `icon:<id>` drag payload
alongside bundled and library shapes with no change to how a drop is
resolved (`nodeForDrop`, already generic over "some list of entries").
Capturing one (`src/lib/customShapes.ts`, `svgForDevice`) takes either
path a device's appearance can come from: a built-in glyph (re-rendered as
raw SVG via a new shared `glyphMarkup`, factored out of `diagram.ts`'s own
icon export so both use the same tinting logic instead of two copies of
it) tinted with its actual override or automatic colour, or an already-
inlined library/import icon (its `imageDataUrl`, decoded straight back to
the raw markup it was built from — a new `base64ToUtf8`, the other
direction of the base64 helper `svgToDataUrl` already used). A new palette
section, "Your shapes," lists what this project has captured, draggable
onto the canvas the same as any other shape, each with a small "×" — a
normal undoable edit here, not the permanent, confirm-modal-guarded
deletion LT-103's stencil-pack removal is, since nothing left disk.
**A real bug found live, not caught by `tsc`/`eslint`/`vitest`, all clean
beforehand:** the whole shape palette crashed — "Maximum update depth
exceeded" — the moment "Your shapes" existed as a section, with an actual
device on the canvas or not. Cause: its store selector read
`s.doc.customShapes ?? []`, and that fallback built a *new* empty array
every time Zustand's snapshot check called the selector — which happens
more than once per render — so the selected value never compared equal to
itself, and React's external-store consistency check spun forever. Fixed
by selecting the field itself (stable — the same reference every call
unless the state actually changes) and applying `?? []` outside the
selector, in the render body, where a fresh array each render is normal
and harmless.
**Verified live, through the actual running app:** right-clicked a device,
chose "Save to shape library," watched it appear in a new "Your shapes"
section with its actual on-canvas icon and colour; removed it with its
"×" and confirmed the section disappeared with it (empty); Undo brought
it straight back, proving the capture and the removal both went through
this project's normal history rather than sitting outside it. **Not
verified, and cannot be with the tools available here:** actually dragging
the resulting tile onto the canvas — confirmed by hand that this
limitation is not specific to the new code (the same true of every
existing built-in palette shape in this exact environment) — so this
rests on `nodeForDrop`'s own existing, already-passing test coverage,
which does not care which list an `icon:<id>` entry came from. `npx tsc
--noEmit`, `npm run lint`, and `npx vitest run` (497 tests, 3 new) all
clean.

### LT-102 — Recolour a whole selection of shapes at once — 2026-09-07
**Source:** asked 2026-09-07 — "is it possibel to give admin the ablitity
to change all the shapes colors?" Read as a bulk colour edit, the same
shape the multi-select bulk editor already uses for tags/lock/maintenance
(`MultiInspector` in `src/components/inspector/Inspector.tsx`) — there is
no "admin" account in this app, one operator, no login, so this is simply
"the person using it," same as everywhere else here.
**Found while scoping:** `DeviceNodeData.style` (`iconColor`/`background`/
`border`) already existed and was already read everywhere a device is
drawn or exported (`DeviceNode.tsx`, `diagram.ts`) — but nothing anywhere
could set it. There was no single-device colour editor to extend, bulk or
otherwise; this shipped both, since a bulk control with no single-device
counterpart to check one result against would have been an odd, unverifiable
half-feature.
**Built:** a shared `ColorField` (label, swatch, and a "Reset" back to
automatic that only appears once a field is actually overridden — the
swatch alone cannot tell a real override from the automatic colour it
happens to match). `NodeInspector` gets one row of these for a single
device, defaulting each swatch to `deviceColor(deviceType, status, ground)`
— the same automatic colour the canvas already draws — until overridden.
`MultiInspector` gets the same row over the whole selection: extended
`Selection` (`src/lib/bulkEdit.ts`) with `iconColor`/`background`/`border`
as `Shared<string | undefined>`, the same `shared()` machinery already
used for device type, so a selection that agrees on "no override" reads
`same, undefined` and one that disagrees reads `mixed` — shown with the
same "choosing one sets them all" hint already used for a mixed device
type. Setting or resetting a field goes through `mapManyNodeData`, not
`updateManyNodeData`, merging into each device's own existing `style`
object individually rather than overwriting it wholesale — the flat
patch the latter applies would have deleted an unrelated style key a
different device in the same selection already had set.
**Verified live, through the actual running app:** selected one device,
opened the native colour picker on "Icon," picked a colour — the swatch,
a "Reset" link, and the device's actual glyph on the canvas all updated
together; Reset put it back to the automatic colour on all three at once.
Selected two devices of different types (a firewall and a core switch,
different automatic colours), confirmed all three fields showed the
neutral "not set" swatch with no mixed hint (both genuinely agreed on "no
override"); set "Icon" to green and watched both glyphs turn green
together on the canvas; Reset restored each to its own distinct automatic
colour, not a shared one — proving the merge went through each device's
own data rather than a flat overwrite. `npx tsc --noEmit`, `npm run lint`,
and `npx vitest run` (494 tests, one new) all clean.

### LT-103 — Remove an added-on stencil pack to free space — 2026-09-07
**Source:** asked 2026-09-07 — "can we give the admin the ablity to
delete shapes and add shapes." **Resolved 2026-09-07** — not the core
built-in palette (Router, Firewall, the generic network shapes): "just the
ones we added like the cisco shapes," deleted permanently to free disk
space, restored only by reinstalling the app. The same shape of change as
LT-100 (removing the Tripp Lite pack), but as a button in the app rather
than something only done by hand in the repo.
**Built:** `src-tauri/src/icons.rs` gained `StencilPack`, `list_packs`
(lists the immediate subdirectories of the stencils resource directory —
a missing directory is no packs, not an error) and `remove_pack` (checks
the name has no path separators and isn't `.`/`..`, canonicalizes both the
stencils root and the target and confirms the target is really inside the
root before `remove_dir_all` — the same boundary a path coming from the
frontend always needs). Two new commands, `list_stencil_packs`/
`remove_stencil_pack`, read the resource directory the same way
`list_bundled_icons` already does. The palette gained a "Built-in stencil
packs" section (`StencilPacksSection` in `Palette.tsx`) listing each pack
with a "×", behind the same delete-confirmation modal pattern already used
for deleting a project — removing re-loads both `bundledIcons` and
`stencilPacks` so the palette updates without a restart.
**A real bug found live, not caught by any of `tsc`/`eslint`/`vitest`/
`cargo test`/`cargo clippy`, all of which were clean before this was
found:** the remove "×" was unclickable — not flaky, reliably so, at
every coordinate on the button. Reading the code found nothing wrong; the
component was rendering exactly as written. Diagnosing it live (a
temporary on-page overlay logging `document.elementFromPoint` at each
button's own centre — see the method below, since this was not visible
from a screenshot at all) showed the click was landing on
`ASIDE.cv-palette`, the scrollable palette panel itself, not the button
under it. WebKitGTK's scrollbar here is an overlay one — it does not
reserve layout space (`offsetWidth` and `clientWidth` on the palette came
back equal), so nothing about the layout suggested a problem — but it
still paints on top of the rightmost ~15px of content when shown, and a
click there hits the scrollbar, which resolves to the scrolling element,
not whatever is under it. Every remove button in this panel sits flush
against that exact edge, including the pre-existing Views panel's own
eye/lock/remove row (`Layers.tsx`) — the same bug, just never noticed
there before this.
**Fixed:** `.cv-layers-list` (shared by both Views and stencil packs) gets
`padding-right: 14px`, moving every button in it clear of the overlay
strip; `.cv-palette` also gets `scrollbar-gutter: stable` for engines that
do reserve gutter space (confirmed a no-op in this app's own WebKitGTK, so
the padding is the fix that actually matters here, not a belt-and-braces
extra).
**Verified live, through the actual running app:** with the fix in place,
the same `elementFromPoint` check against every remove button in both
panels (Views' and stencil packs') resolved to the button itself, not the
palette; clicking a real one (the stale `tripp-lite` pack left over from
LT-100's by-hand deletion) opened the confirm modal, and "Remove
permanently" deleted it — the palette's pack list and shape-library count
both dropped immediately, no restart needed. `npx tsc --noEmit`, `npm run
lint`, `npx vitest run` (493 tests), `cargo test` (97, including 5 new
`pack_tests`) and `cargo clippy --all-targets -- -D warnings` all clean.

### LT-097 — Drag a link's port labels along the link — 2026-09-07
**Source:** asked 2026-09-07 — "I need to be able to drag the port lable."
Screenshot showed the small tags near each end of a link (`Gi0/1`, `eth1`,
`port24`...) — the port-end labels, not the link's own centre label, which
LT-051 already made draggable this same way.
**Built:** two new fields on `LinkData`, `sourcePortAt`/`targetPortAt` (0..1
along the drawn path), the exact same mechanism `labelAt` already gave the
centre label — unset keeps `portAnchors`' fixed-distance-from-each-end
placement (the parallel-cable stacking fix, LT-050/055), only a link
someone has actually dragged switches to a stored fraction.
**A real bug caught by testing the drag, not by reading the code:**
`.cv-edge-label`'s base CSS is deliberately `pointer-events: none` — "a
label sits on top of the line it describes... nothing on a label is
clickable, so it loses nothing by standing aside," from before LT-051 made
the *centre* label draggable, at which point `.cv-edge-center` alone
opted back in with its own `pointer-events: auto`. Port labels never got
that override, so the first working version of this had a correctly-wired
drag handler sitting on an element the pointer could not reach at all —
every drag attempt silently did nothing. Confirmed by testing the
*pre-existing* centre-label drag first as a control (it worked), which is
what pointed at the CSS rather than the new drag code. Fixed by adding
`.cv-edge-port` to the same `pointer-events: auto; cursor: grab` rule.
**Verified live, through the actual running app:** dragged a target port
label along a real link in the sample project, watched it slide and land
near the far end; reloaded the app and confirmed the new position
persisted; undid it back to the original placement.

### LT-101 — **bug** "Send backward" does not move a node behind others — 2026-09-07
**Source:** asked 2026-09-07 — "send backward isn't working," alongside a
screenshot of the node context menu (Edit properties / Duplicate / Set
maintenance / Lock / Bring forward / Send backward / Delete).
**Reproduced:** duplicated a device so two identical glyphs overlapped,
right-clicked the front one, chose "Send backward" — nothing moved.
**Was:** `reorder()` in `src/components/Canvas.tsx` swapped a node with its
immediate neighbour in the document's own node array, and paint order used
to follow that array via a flat `zIndex` (0 for a section, 1 for
everything else — the same value for every non-section node). React
Flow's own node store is a `Map` keyed by id, and it updates an existing
entry in place rather than removing and re-adding it — so reordering the
array we hand it changes nothing about that `Map`'s iteration order.
Between two nodes sharing the same explicit `zIndex`, paint order follows
that Map order, which "Bring forward"/"Send backward" were reordering an
array that had no bearing on.
**Fixed:** `zIndex` is now derived from each node's actual position in
that array (a section still always at 0; everything else at its index +
1), so reordering the array — which is exactly what `reorder()` already
did — now changes something paint order actually reads.
**Verified live, through the actual running app, not just by reading the
code:** duplicated a device so it overlapped the original, confirmed the
newer one (later in the array) painted on top; sent it backward
repeatedly and watched it cross behind the original partway through —
proving the fix responds to reordering, not just asserting it compiles.
One call of "Send backward" moves one step in a document that can have
many nodes between two visually-overlapping ones, which is why the very
first click in this same session looked like nothing happened — that part
was never the bug.

### LT-100 — Remove the Tripp Lite / rack stencils — 2026-09-07
**Source:** asked 2026-09-07 — "remove all Tripp Lite / Racks 18 they are
not useful at all." Reverses LT-086 (and its two follow-on bug fixes,
LT-084/LT-085) — the 18 Tripp Lite SmartRack SVGs shipped as built-in
stencils.
**Built:** checked how a bundled stencil actually reaches the palette
before touching anything — `tauri.conf.json` bundles the whole `stencils/`
directory as one resource (`"../stencils/": "stencils/"`), and
`list_bundled_icons` (`src-tauri/src/commands.rs`) scans that resource
directory generically with the same code that scans a user's own icon
folder. Nothing names "Tripp Lite" anywhere in that path — it is purely
whatever happens to be under `stencils/`. So removal was exactly
`stencils/tripp-lite/` deleted, no code changes anywhere.
**Left alone, deliberately:** `src-tauri/fixtures/tripp-lite-racks.vss` and
the tests that use it (`icons.rs`'s `a_real_operator_stencil_becomes_
drawable_icons`, asserting 18 icons) — that is a captured real `.vss` file
testing the general *"import your own Visio stencil folder"* pipeline, a
different feature from the built-in bundled set, and removing it would
have weakened test coverage for something not asked to change.
**Verified:** `cargo test -p coreview` (92 tests, including the untouched
fixture-based ones above) and the full frontend suite both still pass;
confirmed by grep that nothing else in the codebase — frontend or
Rust — names the Tripp Lite stencils, so nothing else needed touching.

### LT-094 — Pages, like Lucidchart — 2026-09-07
**Source:** asked 2026-09-07 — "Lets also add pages just like how lucidchart
does."
**Resolved 2026-09-07:** asked directly whether this meant the existing
"Views" panel (`src/components/Layers.tsx` — one shared canvas, one shared
object set, a view is a saved visibility filter over it) or true Lucidchart
pages (each an independent canvas with its own object positions). Answer:
independent canvases. Confirmed again after reading the actual store code:
offered a smaller, lower-risk alternative (tag each object with a page,
reusing the Views filtering pattern) versus the larger, fully-nested
structure this called for — the operator chose the larger one.
**Built:** `ProjectDocument` changed from one flat `{nodes, edges, canvas,
probes}` to `{pages: ProjectPage[], activePageId, probes}`, each
`ProjectPage` holding its own nodes, edges, and canvas settings (grid,
snap, colour-by, node style, link style, Views). `probes` stays flat and
project-wide — a device's monitoring was never a question of which page
draws it. A new pure module, `src/lib/pages.ts`, holds the page
list-manipulation (add/remove/rename/duplicate/reorder/switch), mirroring
`src/lib/layers.ts`'s own pure-function style, and a new `PageTabs.tsx`
component gives it a tab strip along the bottom of the canvas — modelled on
the Views panel's own interaction vocabulary (inline-editable name, a
remove affordance, an add control), laid out sideways. Renamed the
existing `canvas.page`/`canvas.pageRect` fields (the print-sheet boundary
of one drawing — an unrelated, pre-existing feature) to `canvas.sheet`/
`canvas.sheetRect` so the two concepts sharing the word "page" could not be
confused with each other in the same file.
**Migration:** `migrateDocument` (`src/lib/migrate.ts`) gained a first step
that wraps a document saved before this into a single page named "Page 1"
— idempotent, and everything that was on it stays exactly where it was.
**~30 store actions in `src/state/store.ts`** that used to reach into
`doc.nodes`/`doc.edges`/`doc.canvas` directly now go through
`activePage(doc)`/`withPage(doc, patch)`; the handful that are genuinely
project-wide (`nodeStatus`, `linkStatus`, the Monitored Objects table,
`ensureNodeCheck`, backup/CSV export) go through `allNodes`/`allEdges`
instead, which flatten every page.
**Export scope for v1:** SVG/PNG/PDF/Visio (drawing exports) draw the
active page only; CSV/Markdown (data exports, not drawings) and the
Monitored Objects table stay project-wide. True multi-page Visio export
(one `.vsdx` page per Coreview page) is real, separate work, concentrated
in `src-tauri/src/visio.rs`'s currently-hardcoded single-page XML — not
attempted here.
**A real bug found and fixed during verification, not left in:** the first
working version of `PageTabs.tsx` had a tab's inline-rename `<input>`
calling `e.stopPropagation()` on click, which silently swallowed every
click meant to switch to that tab — clicking a tab did nothing, and it was
easy to misread as "pages aren't really independent" rather than "the
click never arrived." Fixed by switching to the tab's `onFocus` instead
(which a plain click into the input also triggers, without needing the
click to bubble at all) — caught by testing the actual click, not by
reading the code, exactly the kind of thing this project's own standard
("distinguish 'I compiled it' from 'I ran it and watched it work'") exists
to catch.
**Verified live, through the actual running app, not just unit tests:**
opened a project saved before this feature existed and confirmed it came
up as one page named "Page 1" with everything intact; added a second page
and confirmed it was genuinely blank; placed a device on it and watched
the Monitored Objects count go up regardless of which page was on screen;
switched back to the first page and confirmed it was untouched; renamed a
page inline; duplicated a page and confirmed the copy got fresh ids, no
carried-over probes, and a unique name; deleted a page and confirmed its
device dropped out of Monitored Objects (the probe cascade) and the tab
strip fell back to another page; confirmed the last remaining page refuses
to be deleted. `src/lib/pages.ts` also carries 22 direct unit tests
(add/remove/rename/duplicate/reorder/switch, unique-name collision,
probe-cascade-on-delete, last-page-refusal), and `migrate.ts` carries 4
covering the new wrap step specifically (isolated from the pre-existing
LT-065 glyph-squaring tests, which were adjusted to test squaring alone
rather than picking up an extra "changed" count from the wrap).

### LT-095 — A hyperlink on an object — 2026-09-07
**Source:** asked 2026-09-07 alongside pages and note hyperlinks —
"hyprlinks."
**Built:** an optional `link` field on a device and on a note, opened from a
small badge on the canvas (bottom-left corner, next to where the lock badge
already sits). This app deliberately ships with no shell/HTTP/filesystem
plugin (`capabilities/default.json`: "the webview cannot name a path of its
own") — adding `tauri-plugin-shell` would have contradicted that, so this is
one small hand-written command, `open_external_url`, that checks the scheme
is `http`/`https` before shelling out via the `open` crate. A link on a
device or note can arrive inside an imported or shared project file, so the
scheme check is enforced in Rust, not trusted from the frontend.
**Verified:** three Rust tests confirm `file://`, `javascript:`, and a
bare string with no scheme are all refused. Live under Xvfb: this
environment turned out to have no emoji font installed at all (`fc-list`
confirms — not something to fix here, a pre-existing gap in the test VM
that equally affects the already-shipped 🔒 lock badge, not something this
work introduced), so the 🔗 glyph itself couldn't be *seen* to render.
Swapped it for a plain letter with a bright background as a temporary,
reverted-before-commit diagnostic: confirmed the badge sits in exactly the
right spot, only renders when a link is set, and a click is caught by the
badge (`stopPropagation`) rather than falling through to node
selection/drag. Reverted back to 🔗 immediately after.

### LT-096 — Notes support hyperlinks in their text — 2026-09-07
**Source:** same message — "notes with hyperlinks."
**Built:** `NoteNode.tsx`'s existing small inline-markdown parser (bold,
code, headings, checkboxes) gains `[text](url)` link syntax, opened through
the same `open_external_url` command as LT-095 — a plain `<a href>` is never
allowed to navigate the webview itself, since there is nothing for it to
navigate to.
**Verified:** three unit tests on the exported `inline()` parser (a link
renders with the right href and text; unmatched brackets with no following
`(url)` stay plain text, not a broken link; bold/code/link all still work
together on one line). Live under Xvfb: typed `[the runbook](https://…)`
into a real note's body in the sample project and watched it render as an
underlined link (plain text, no emoji-font dependency, so this one *was*
directly visible) — clicking it did not navigate the app away. Sample
project's note content restored to its original text afterward.

### LT-092 — HTTP/HTTPS probing: match text in the response body — 2026-09-07
**Source:** asked 2026-09-07, offered as an idea and accepted ("Do it") —
right now any 2xx/3xx counts as healthy, but a maintenance page or a generic
web-server default page also returns 200. For a failover drill that isn't
enough: a backup site can be "up" at the HTTP layer while serving the wrong
thing entirely.
**Built:** an optional "Expected text in response" field on an HTTP/HTTPS
probe. Empty keeps prior behaviour (status code only). Filled in, a healthy
status whose body does not contain that text comes back as a new
`BodyMismatch` outcome rather than `Success`, with the status code still
reported so a mismatch is never confused with the site being down. The body
is read with the same hard cap (`MAX_BODY_BYTES`, 64 KiB) the rest of this
probe already uses, relying on `Connection: close` rather than buffering
without limit.
**Verified live, through the actual running app:** a real local HTTP server
(not a mock) serving a known body, probed via the Inspector's HTTP GET kind
with "Application OK" as the expected text — "Test now" returned "OK — HTTP
200, ... expected text found." Changed the expected text to a string not in
the body and re-ran — "Failed — HTTP 200, but the expected text was not in
the response." Both outcomes watched end to end: Inspector field → IPC →
`probe_http` → rendered result, under Xvfb.
**A verification trap found along the way:** the first attempt at this
showed only four probe kinds in the dropdown (no HTTP/HTTPS) despite the
source being correct — the running app was loading the stale, pre-LT-087
`dist/` bundle because it had been launched as the raw debug binary rather
than through `tauri dev`. Not a code bug; written up in
`docs/HANDOVER.md` §6.7 so it doesn't cost time twice.

### LT-093 — Traceroute: show what changed since the last run — 2026-09-07
**Source:** same message — comparing two hop lists by eye to prove a path
actually moved after a failover was the friction point.
**Built:** a session-only `Map` of the last hop list seen per target: running
traceroute again against a target it already has a result for compares the
new hop list against the old one (`tracerouteDiff.ts`'s `changedHops`, pure
and unit-tested) and highlights the changed rows. A hop counts as changed if
its set of routers differs at all — new, lost, or newly/no-longer
answering, not just a router-for-router swap. Not persisted across app
restarts and not a metrics/trend feature, per the acceptance as asked: one
before/after comparison, not a history.
**Verified live, through the actual running app:** ran Traceroute against a
node in the sample project — first run: "First trace to this target this
session." Ran it again against the same target — "Same path as the last
trace to this target," the unchanged-path branch of the same message, under
Xvfb. The changed-path branch (highlighted rows, "Path changed at N
hop(s)...") is covered by seven unit tests on `changedHops` itself (router
changed, started/stopped answering, brand-new hop, order-independence) —
forcing a real path change on real hardware mid-verification wasn't
practical, and the rendering ternary next to the already-confirmed
unchanged branch is a two-line read, not a leap of faith.

### LT-091 — **bug** Two probe tests failed only on real Windows CI — 2026-09-07
**Source:** found, not reported — CI's `windows-latest` run on the LT-090 commit
failed `test (windows-latest)` while `test (ubuntu-latest)` was green. No
Windows machine was available in this environment; the operator relayed the
CI log by hand (three rounds of screenshots) since the log-download API
returned 403 here.
**Two independent bugs, one CI run:**
1. `http::tests::nothing_listening_is_refused_not_down_with_no_reason`
   expected `Refused`, got `Timeout`. The test's own 500 ms budget, chosen
   without real justification, was too tight for how Windows tears down a
   just-freed loopback port — Linux delivers the refusal essentially
   instantly, Windows measurably slower. Not an app bug: the test itself was
   flaky. Raised to 3000 ms, matching the budget the other tests already use.
2. `traceroute::tests::a_real_loopback_run_succeeds` — a real loopback trace
   came back with hops but not one probe carrying an RTT. `tracert.exe`
   writes a sub-millisecond round trip as `<1`, which is not a bare number,
   so `parse_hop_body` fell through to reading it as a hostname — the same
   `<1ms` quirk `icmp.rs` already handles for `ping.exe`, missed when this
   was written new. Fixed in `rtt_value`, same `0.5` convention `icmp.rs`
   uses. While in there: `tracert.exe`'s classic layout prints a hop's RTTs
   *before* its router name, the reverse of `traceroute`'s, which the
   original parser had no way to attach a host to — fixed with a same-line
   back-fill that is a no-op for `traceroute`'s own host-first lines.
**Acceptance:** a bug is reproduced before it is fixed (D-020) — for #1, the
reproduction *is* the CI failure itself, a real flake on real Windows, not
worth re-inventing locally. For #2, a new test
(`windows_sub_millisecond_loopback_hop_is_parsed`) reconstructs the failing
line from `tracert.exe`'s documented classic format plus what the CI panic
revealed was wrong — labelled in its own doc comment as reconstructed, not
captured, since no real Windows machine was reachable here. Both fixes
verified passing locally on Linux (68 probe-crate tests) and pushed for CI
to confirm on the platform that actually found them.

### LT-090 — Traceroute, on demand — 2026-09-07
**Source:** same 2026-09-06 message as LT-087/088/089.
**Why not a recurring probe:** traceroute has no pass/fail signal — it's a
diagnostic snapshot of the current path, useful mid-drill when something
isn't reaching the backup DC and you want to see where it's actually going.
Building it as a scored, threshold-based probe would smuggle back the
RTT-trend/metrics-history idea already declined in D-023.
**Built:** a "Traceroute" item on a node's context menu, aimed at the same
address the node's own primary check is aimed at (LT-061), opening a panel
that shells out to the platform's own `traceroute`/`tracert.exe` and parses
its text output — the same privilege-free pattern `ping` already uses here,
no raw sockets. Shows the hop list once; nothing is logged or scored.
**Parser written against real captured output, not documentation** — the
operator installed `traceroute` on request specifically so this could be
verified against a real machine rather than assumed, per this project's own
rule for parsers (`icmp.rs`'s own header comment). The captures found a real
quirk no documentation mentions: on an ECMP path, a single hop's three
probes can come back from two or three *different* routers, and
`traceroute` only reprints the router's name when it changes between
probes — handled and covered by two tests built from real captures of it
(`preserves_a_mid_hop_router_change[_numeric]`).
**Verified live, twice:** once at the Rust level (real loopback run, real
run against the unreachable RFC 5737 range), and once through the actual
running app under Xvfb — right-clicked a real node in the sample project,
opened the real "Traceroute" panel, and watched it return and render a real
result (`localhost (127.0.0.1)`, three real RTTs) end to end: menu → IPC →
Rust command → process spawn → parse → React render. Also exercised the new
HTTP/HTTPS/DNS probe-kind UI the same way — the type dropdown, the
port/path/ignore-cert-errors fields, and a real "Test now" against HTTPS
that surfaced a genuine TLS failure reason in the inspector.

### LT-087 — HTTP probing — 2026-09-06
**Source:** asked 2026-09-06, alongside HTTPS/DNS/traceroute — a two-data-centre
failover drill: "we test failover emulating full data center failure and we
want to confirm the applications are all good on the backup Data Center...
some customers have F5's and traffic from the internet is going to both data
centers."
**Built:** a probe kind that opens a `TcpStream`, hand-writes a minimal
HTTP/1.1 GET (no HTTP client dependency), and reads the status line. 2xx/3xx
is healthy; anything else (4xx/5xx, refused, timeout) is down, with the
actual status code in the summary rather than a generic "down" — confirmed
with the operator rather than assumed.
**Verified:** a real TCP listener written for the test (not a mock),
covering a healthy 204, an unhealthy 503, and nothing listening on the port
at all, each asserting the specific `Outcome` the operator asked to have
distinguished.

### LT-088 — HTTPS probing — 2026-09-06
**Source:** same message as LT-087.
**Built:** the same GET-and-status-code check as LT-087, over TLS via
`rustls`/`tokio-rustls` (no OpenSSL, so the Windows build stays painless).
Crypto provider is `aws-lc-rs`, not rustls's own default of `ring` — this
workspace already pulls in `aws-lc-rs` through `russh`'s SSH crypto, so this
reuses that build instead of compiling a second native-crypto backend
alongside it (found and fixed after the first attempt genuinely ran the
machine out of memory rebuilding both). Certificate validation is on by
default (bundled Mozilla root list via `webpki-roots`, not the OS trust
store, so behaviour doesn't vary between Windows and Linux); a per-probe
`ignoreCertErrors` toggle skips it, for a backup DC on an internal CA or a
self-signed endpoint — confirmed with the operator.
**Verified live, against real servers, not just loopback:** a trusted
public cert (validated normally, succeeded), a known self-signed cert at
`self-signed.badssl.com` (correctly rejected as `CertificateError:
UnknownIssuer` with validation on, correctly accepted with
`ignoreCertErrors` on). All three outcomes confirmed by hand before this
shipped; not committed as an automated test, since it depends on live
internet hosts and this project's other network tests deliberately stay
hermetic (loopback and the RFC 5737 documentation range only).

### LT-089 — DNS probing: confirm the resolved address, not just that one came back — 2026-09-06
**Source:** same message. DNS probing already exists (LT-002-era) and only
checks that something resolved. For this operator's scenario — many F5
deployments steer failover through DNS (GTM/GSLB) — that isn't enough to
prove a failover actually happened.
**Built:** an optional `expectedAddress` field on a DNS probe. Empty keeps
the original behaviour. Filled in, a resolution that does not include that
address comes back as `AddressMismatch` — a failure, not a warning — rather
than `Success`, so pointing this at a failover record proves DNS actually
flipped to the backup DC rather than merely still answering.
**Acceptance:** shipped as written above (mismatch treated as a hard
failure was a judgement call, not asked for in those exact words — flagged
here per the standing rule that shipped acceptance differing from what was
asked gets said explicitly).

### LT-086 — Ship the operator's Tripp Lite SmartRack racks as built-in stencils — 2026-09-04
**Source:** asked 2026-09-04, re-uploading the same file — "can you add these
to the app please just like how you did with the PPTX files this is even
better its VSS".
**Built:** the same 18 masters LT-083/LT-084/LT-085 made drawable are
committed as `stencils/tripp-lite/racks/*.svg`, bundled into the installer
the way the Cisco PPTX set already is (D-022) — no folder to point at,
built in on first run. `stencils/tripp-lite/manifest.json` and
`contact-sheet.html` document the import the way the Cisco set's own do.
Generated by the app's own real scan (`icons::scan` against the fixture),
not a separate script, so what shipped is provably byte-identical to what
converting this file live in the app would produce.
**Along the way:** shipping a second `contact-sheet.html` doubled an
existing rough edge — `.html` wasn't in `is_paperwork`'s allowlist, so the
app's own bundled documentation files were reported as "cannot read
directly" on every single run. Fixed alongside this, since it's this
change that made it visible.
**Not carried over:** master names. `vss2xhtml` exposes none (LT-045's
still-open note), so these are "Tripp Lite SmartRack Rack 1..18" by
declaration order, not by what each rack actually is.
**Acceptance:** `the_shipped_stencils_scan_into_a_full_palette` now also
asserts `lib.skipped` is empty, so a shipped file being unreadable — the
`.html` regression above, or any Visio master reverting to LT-084/LT-085's
malformed XML — fails CI instead of shipping quietly. Verified past that:
a real bundle built and packaged (`.deb`), all 18 files present at
`usr/lib/Coreview/stencils/tripp-lite/racks/`, and the packaged binary
launched and stayed up under Xvfb.

### LT-085 — **bug** A self-closing clip group was reopened with nothing to close it — 2026-09-04
**Source:** found re-verifying LT-083's fix against the operator's second
upload of the same stencil — one of the 18 masters (the one at index 14)
still failed to parse as XML after LT-084's fix, so the investigation wasn't
over.
**Was:** `strip_cruft`'s "a `<g>` that only carried the page clip contributes
nothing without it" step replaced `<g clip-path="...">...</g>` with a plain
`<g>...</g>` — correct for a real, non-empty tag. For an already
self-closing `<g clip-path="..."/>` (soffice writes one when the clip
applies to an empty group), the same wholesale replacement produced a bare
`<g>` that nothing ever closes, since a self-closing tag never had a
`</g>` to begin with.
**Fixed:** a self-closing match collapses to nothing; only a real,
non-empty tag loses just its `clip-path`.
**Acceptance:** a test against a minimal reproduction (a self-closing
`<g clip-path="..."/>` alongside a real one) that fails while the count of
`<g>` opens and `</g>` closes disagree, then the fix. Verified against the
real master that exposed it, and against all 18, by parsing each with
`roxmltree` rather than checking substrings — added as a permanent
assertion in LT-083's own test, since a substring check is exactly what let
both LT-084 and LT-085 through unnoticed the first time.

### LT-084 — **bug** A self-closing `<defs>` swallowed the next unrelated block — 2026-09-04
**Source:** found while committing the operator's Tripp Lite stencil to
`stencils/` after LT-083 shipped — Inkscape reported "Opening and ending tag
mismatch: g ... and svg" on one of the 18 converted masters, which LT-083's
own test had not caught because it checked for a `viewBox` and the absence
of `data:image/emf`, never whether the SVG was well-formed XML at all.
**Was:** `strip_cruft`'s boilerplate-`<defs>` removal always searched for a
literal `</defs>` to know where a boilerplate block ended. soffice writes
some of these self-closing (`<defs class="TextShapeIndex"/>`, empty) with no
`</defs>` of their own; searching for one anyway found the *next*, unrelated
block's close and deleted everything in between — real content included,
along with any `<g>` that opened inside the wrongly-swallowed range but
closed outside it.
**Fixed:** a self-closing boilerplate `<defs>` is deleted on its own; only a
real, non-empty one still searches for its matching `</defs>`.
**Acceptance:** a test against a minimal reproduction (a self-closing
boilerplate `<defs/>` sitting between two real, unrelated `<g>` blocks) that
fails while the count of `<g>` opens and `</g>` closes disagree, then the
fix. Led straight to LT-085, a second, unrelated bug in the same function
found while re-verifying this one against the real file.

### LT-083 — **bug** A stencil's masters are blank tiles — 2026-09-04
**Source:** found while reproducing LT-080/LT-045 against the operator's real
`.vss` — not separately reported by him.
**Was:** libvisio hands a stencil master back as `<image>` pointing at an
inline `data:image/emf` (or `.wmf`) payload — that is the *entire* content of
a master in this stencil, no vector fallback underneath. No webview paints an
`<image>` whose href is `data:image/emf`, so every master converted through
`vss2xhtml` was a blank palette tile. `blue-box.vsdx` (libvisio's own test
fixture, used by the existing LT-045 test) happens to carry vector content
instead, which is why this went unseen until a real vendor stencil was on
hand.
**Fixed:** every embedded EMF/WMF across a stencil's masters is decoded and
run through `soffice` in one batched call, then spliced back in as vector
content scaled onto the picture's own box — coordinates baked into the
geometry itself, not left as a wrapping `<g transform>`, because
`crop_to_content` reads raw path/rect/image attributes and does not follow a
transform (the first version of the fix passed its own test but produced a
10504×28808 viewBox; caught by rendering the result to PNG with Inkscape and
actually looking, not just checking the SVG parsed). Verified against all 18
masters of the operator's real Tripp Lite stencil, each rendered to PNG and
inspected by eye — genuine rack elevation drawings, not blank tiles.
**Acceptance:** a test against the operator's own `tripp-lite-racks.vss`
fixture that fails while any master's SVG still carries a `data:image/emf` or
`data:image/wmf` href, then the fix. Shipped as written; also asserts the
resulting viewBox stays within the master's own scale, which is what caught
the untransformed-geometry regression above.

### LT-081 — Stencil archives, and a skip message that names the wrong formats — 2026-09-04
**Source:** the same 2026-09-04 message, from the pasted output — "46 file(s)
are in formats Coreview cannot read directly (.pptx, .vssx, .zip) — run
scripts/import-shapes.mjs on them first".
**Two things wrong:** `.vssx` *is* read — it has gone through the Visio route
since LT-045, so the message names a format it handles and sends the operator
off to a script he does not need. And a My Shapes folder is full of `.zip`
archives of stencils, which are not opened at all.
**Fixed:** a zip is opened and walked the same way a real subfolder is —
extracted to a scratch directory and fed back through the same `collect`, so
an SVG, EMF or `.vss` inside it becomes an icon exactly as a loose file
would, categorised under the zip's own name the way a real subfolder would
be (`folder_category` now tries more than one root for this reason). A zip
that will not open, or an entry a path-traversal check refuses
(`enclosed_name`), is named in `skipped` rather than silently dropped. The
refusal message for what is genuinely unreadable now lists the actual
extensions seen instead of a hardcoded, and partly wrong, example list.
**Acceptance:** the message names only what was actually skipped, by the
extensions actually seen; a `.zip` holding stencils or SVGs is read through
like a folder. Both shipped as written, plus a broken-zip case mirroring the
existing broken-Visio-file test.

### LT-082 — **bug** A real icon file refused for being over 512 KB — 2026-09-04
**Source:** the same 2026-09-04 message —
"Unmaintained-Design-Icons_v2.0(2).svg: larger than 512 KB".
**Was:** `MAX_SVG_BYTES` is a flat 512 KB guard meant to keep a runaway file
out of the palette. A legitimate multi-shape icon sheet is bigger than that,
so a file the operator wanted was dropped with a size complaint.
**Fixed:** raised to 8 MB — still a guard against a runaway or corrupt file,
no longer a cap on how much legitimate artwork one icon sheet may hold.
**Acceptance:** that file loads. A test that fails without the fix — built
first, confirmed it failed with the message the operator actually saw
("larger than 512 KB"), then fixed.

### LT-079 — A link's default style, and a way back to it — 2026-09-02
A link's menu gains two entries: **Save this style as the default** takes the
link's look — colour, path type, flow direction, width, line style — and makes
it what the document draws links with; **Reset to default style** puts a link
back to exactly that. New links are born with it too, so a diagram drawn after
the choice needs no tidying afterwards, while anything the caller sets
explicitly (a crawl marking a link red, a discovered port label) still wins.
Only the *look* travels: ports, label, health rule, maintenance and enabled
are facts about the network, not style, and a reset leaves them untouched — a
test pins that. A hand-drawn route does go, because that is part of the look.
The choice lives on the document, so it travels with the diagram.

### LT-078 — Export to Visio — 2026-09-01
"Diagram for Visio" writes a real `.vsdx` — an OPC package of seven XML parts
— with each device a named rectangle at its place on the page and each link a
connector glued to both ends carrying its port label. Shapes and connectors,
not a picture: a colleague without Coreview can open it and move things
about. Pixels become inches and the origin flips to the bottom left, in one
place, so nothing downstream has to remember which way up a Visio page is.
draw.io was offered and declined — "export to visio only".
**Verified with an independent reader, not just by assertion:** libvisio (the
engine LibreOffice uses to open Visio files) parses the package and recovers
both device names and the port label. That check earned its keep straight
away — the first version drew the boxes and *no link at all*, because a 1-D
shape's geometry is measured from its own origin and mine was written in page
coordinates. The connector is now a proper 1-D shape: pinned at the midpoint,
rotated onto the bearing, running (0,0)→(Width,0).
**Not claimed:** Visio itself has not opened it — there is no Visio on this
machine. The package is structurally valid, well-formed throughout, and reads
correctly in the one independent Visio reader available here.

### LT-077 — Export the diagram as a PDF — 2026-09-01
"Diagram as PDF" writes a real vector PDF at the chosen paper size, from the
same SVG the screen and the SVG export are drawn from — one renderer, three
outputs. Converted in Rust (`svg2pdf`), so there is no headless browser in
the loop and no bitmap on a page: 0 image objects, text as glyph outlines,
lines a plotter can take.
**Caught before it shipped, by a test written to doubt it:** the first
version produced a 1.5 KB PDF of boxes and lines with *no device names on it
at all*. usvg's default family is "Times New Roman"; where that is not
installed — any stock Linux, plenty of locked-down Windows — every label was
silently dropped, and the file still looked like a valid PDF. The generic
families are now bound to a font the machine actually has, preferring the
app's own stack, and the same diagram comes out at 23 KB with 186 glyph
paths. A test requires that a page of pure text is never empty.

### LT-076 — Choose how times are written, and use the machine's zone — 2026-09-01
DTG is what an operator reads at a glance; it is not what everyone reads. A
"Times" picker in the top bar now writes every timestamp one of four ways —
DTG in Zulu, DTG in the machine's own zone (marked `L`, never pretending to
be Zulu), a plain 24-hour clock, or a 12-hour clock with AM/PM — applied to
the event timeline and the transition log alike, remembered for the machine
rather than stored in the document, because two people reading the same
diagram may want different clocks. The zone is named out loud: the picker's
tooltip and a line under the transition log say "CDT (UTC−05:00)" or "Zulu
(UTC)", so nobody has to guess which one they are reading.
**Found while testing:** the harness grabbed devices at a fixed `+30px` from
their corner, which was inside a node until LT-053 made devices 76 units
square — at a zoomed-out fit that is under 30px on screen, so the grab landed
on the pane and rubber-banded instead of dragging. It had been passing by a
hair; a fraction of a percent of zoom change exposed it. Every drag now takes
its target by the centre.

### LT-075 — **bug** The space-bar hand let go of the diagram mid-drag — 2026-09-01
**Source:** reported 2026-09-01 — "holding the space bar and drag, the hand
doesn't really hold the screen where I try to move from-to, it just takes the
direction that I move the mouse to."
Measured rather than guessed: a plain press-drag-release tracked the cursor
exactly 1:1, at any zoom, starting on a device, and out-and-back returned to
zero — so the arithmetic was never wrong. What broke was releasing the space
bar *during* the drag, which everyone does once the hand has hold: the key-up
tore the pan sheet away mid-gesture and the diagram stopped following the
cursor after only part of the movement. A drag now runs until the button
comes up and the key is irrelevant once it has started; the deferred release
is honoured on pointer-up and on pointer-cancel, and a window blur still
clears everything.

### LT-074 — Transition times as a DTG — 2026-08-31
**Source:** asked 2026-08-31 — "I need time stamp of when the device
disconnects and when its live back again in DTG… I need logs showing in DTG."
"Down 7s" says how long, not which 7 seconds. Every status change now carries
a date-time group — `311430:07Z AUG 26` — in three places: the event timeline
(which showed a bare clock time, no date, no zone), a newest-first transition
log under Recent status on the device itself, and a `dtg` column in the
exported events CSV beside the ISO stamp. Zulu by default, because the zone
letter is part of what makes a DTG worth keeping; seconds included, because a
ping goes down and comes back inside a minute. Double-clicking a timeline row
copies the line with its DTG.

### LT-073 — **bug** Backing up three devices blanked the whole window — 2026-08-31
**Source:** reported 2026-08-31 with a screenshot — three devices selected,
backup pressed, and the app became an empty dark window.
Two faults, both fixed. **The throw:** the Rust backup enum is tagged
adjacently — `{kind, value:{…}}` — and every reader here expected the fields
flat, so a successful save arrived with `bytes` undefined,
`bytes.toLocaleString()` threw, and React unmounted the tree. Nothing caught
it earlier because no test had ever seen a *successful* backup payload.
Events are normalised at the IPC edge now (`normaliseBackupEvent`, tested
against both shapes) and the panel reads a missing size as "size unknown".
**The blank window:** a throw anywhere took the whole application down, with
nothing said and no way back. Each region — toolbar, palette, diagram,
inspector, monitoring panel — now sits in an error boundary that names what
broke, shows the message, keeps the rest alive and offers "Try again".
Verified by forcing a render fault in the harness: the window survives, the
boundary reports it, untouched regions keep working, reopening is clean.

### LT-025 — Two roadmap files — 2026-08-31
The MVP-era root `ROADMAP.md` is now a one-paragraph pointer to
`docs/ROADMAP.md`, which is authoritative.

### LT-033 — Stale debug scripts in `e2e/` — 2026-08-31
`e2e/dbg.mjs` and `e2e/dbg2.mjs` deleted.

### LT-063 — Bump the CI artifact actions off Node 20 — 2026-08-31
`actions/upload-artifact` to v7 and `download-artifact` to v8, clearing the
Node-20-deprecation warning on every run.

### LT-071 — **bug** Elbow grips multiplied into dozens along a link — 2026-08-31
`pathVertices` counted every number pair in the path, so a smoothstep's
rounded corners — each a `Q` whose control point *is* the corner and whose
endpoint lies on the next run — read as three vertices apiece, and every one
sprouted a grip. The parser is command-aware now (M/L give a vertex, Q gives
its control point, the endpoint is dropped) and collapses points that sit on
the run they join; runs too short to aim at get no grip at all. The real
browser path that produced the mess is the test: it now yields three grips,
one per straight run, which is what Lucidchart shows.

### LT-072 — A bezier link's curve can be adjusted — 2026-08-31
A selected curved link offers one ring handle at the middle of the curve;
dragging it away from the straight line between the ends bows the curve,
double-click hands it back to automatic. Stored on the link, undoable, saved.
A bezier shows only this handle — no elbow grips, no waypoint dots — so the
three routing modes never crowd each other.
**Reported not working, and it was:** the first cut passed a `curvature`
option to React Flow's `getBezierPath`, which in the pinned version *ignores
it* — every value returned a byte-identical path, so the handle moved and
nothing happened. Proven by isolating the call, then replaced with our own
cubic (`src/lib/bezierPath.ts`, tested): each end leaves along the side its
handle is on, and curvature is how far the control point reaches along that
end's own axis. Curvature 0.5 reproduces React Flow's old curve exactly, so
no diagram drawn before this moves.

### LT-027 — Colour by VLAN — 2026-08-31
Colour-devices-by joins health, role, subnet and tag with VLAN. The MAC-table
parser already read the VLAN column; that now threads onto each attached
device (`AttachedDevice.vlan`), into the node the topology builds
(`data.vlan`), and into the tinting key. A device the switch learned on an
access port colours by that VLAN; a switch that trunks many, or a device found
over a discovery protocol, has no single VLAN and is left uncoloured rather
than lumped into one shade. Confirmed against the lab 9300's live MAC table
(a flat VLAN-1 network, so everything colours as one group — correctly).

### LT-028 — Multi-sheet export — 2026-08-31
The SVG export can now write one file per sheet at full size, not just the
whole diagram shrunk onto one. `tileRects` splits the content by the chosen
paper's printable area (tested); the renderer clips each sheet to its tile so
a device straddling a seam is not drawn whole on both; the export menu's
"SVG sheets (N)" writes `<name>-sheet-r{row}c{col}.svg` into the export
folder. Needs an export folder set; without one it falls back to the single
SVG and says why.

### LT-069 — Elbow links: drag a segment, press-and-hold to reset — 2026-08-31
A step or smoothstep link now edits the Lucidchart elbow way: a selected one
shows a pill grip on each straight run, dragging a grip slides that run
orthogonally with every corner kept at 90° (`dragSegment`, tested), and a
press-and-hold on a grip that never moves resets the whole line to
automatic. Straight and curved links keep the free vertex/midpoint handles
from LT-068 — one interaction or the other, chosen by the link's path type.

### LT-070 — **bug** Shape conversion failed when LibreOffice was already busy — 2026-08-31
The overnight smoke caught it: `a_real_emf_becomes_a_palette_icon` failed
intermittently because `cargo test` runs the soffice-backed tests in
parallel, and two `soffice --convert-to` invocations sharing the default
user profile collide — one silently produces no output. A user with
LibreOffice already open would hit the identical failure on every import.
Each soffice call now gets its own `-env:UserInstallation` profile directory
(created and cleaned per call), so nothing shares a lock. Reproduced with two
concurrent conversions, fixed, and confirmed stable across repeated full
backend runs that were flaky before.

### LT-068 — Full manual control of link routing — 2026-08-31
Reshape a link by hand, Lucidchart-style: a selected link shows a filled
square at each waypoint (drag to move, double-click to remove) and a hollow
circle at each segment midpoint (drag to bend a new waypoint in). The route
is stored on the link (`waypoints`), undoable, saved, and drawn as a
rounded polyline that keeps its shape — no auto-hop, no lane. "Reset routing"
on the link's context menu hands it back to automatic. Double-click still
adds flat text on the bare line (LT-052); the handles sit only on the
vertices and midpoints, so the two do not fight. **Follow-up filed as LT-069:**
the elbow/step line mode Lucid shows — pill grips that slide a whole segment
orthogonally, and press-and-hold to reset — is a distinct interaction on top
of this.

### LT-064 — **bug** Links lost their little jumps at crossings — 2026-08-31
React Flow's smoothstep splits one straight segment at its border offsets
into collinear runs, and a crossing near one of those joints was dropped for
sitting at a run's end. The runs of a straight line are coalesced now, in
both the crossing finder and the arc renderer, so a crossing anywhere along a
straight link hops again. Not a regression from the recent edge work — a
longstanding weakness the crawled diagram exposed; the browser-captured paths
are the test.

### LT-065 — **bug** The edit corners are far from the shape on older nodes — 2026-08-31
`migrateDocument` squares a pre-LT-053 168x92 device box on open — centre
kept, shapes and already-square glyphs left alone, idempotent, dirtying the
document only when it changed something. Runs on open and recovery-restore.

### LT-066 — The bundled shapes fold into one palette section — 2026-08-31
The built-in library sits behind a single collapsed "Shape library" header
with its count; the nine categories nest inside it, and search opens through.

### LT-067 — Hovering a link shows its physical ports — 2026-08-31
The link hover leads with the ports: `Ports: A Gi1/0/1 ↔ B Gi0/1` for a
plain link, and `Port-channel: … (Gi1/0/11, Gi1/0/12)` listing the members
for a LAG, from the discovery note.

### LT-013 — Crawl a network and draw it — 2026-08-29
Shipped: CDP and LLDP over SSH and telnet, FortiOS command set, backup
credentials, chassis-id→ARP resolution, SNMP fallback, subnet scoping.

### LT-014 — Live status that is actually live — 2026-08-29
Asked: "I need it show real time status not fake". Shipped: three probes five
seconds apart, an amber ring and "1 of 3 missed" while a device is failing, and
the time each result was last confirmed.

### LT-015 — Reach the FortiGate at 192.168.77.1 — 2026-08-30
Shipped: FortiOS ends its prompt in `$` for a non-super_admin profile, which
the prompt finder rejected, so the device was unreachable entirely. Also VDOM
prompts, `execute dhcp lease-list` for 44 named endpoints, managed FortiSwitch
over FortiLink, and FortiAP status including each AP's own LLDP — the only
evidence of the UniFi switch anywhere in the crawl.
**Differs from the ask:** `diagnose user-device-store device memory list` does
not exist on that profile; the lease list is used instead and is better for the
purpose.

### LT-016 — The eight drawing enhancements — 2026-08-30
Tidy layout, find a device, change report, right-angle routing, bulk edit, CSV
export, status history, fold a site.

### LT-017 — Links that follow their devices — 2026-08-30
Asked: links should "rotate" as devices move. Shipped: a full turn — any of the
four sides — recomputed on every render, with lanes so links off the same side
do not overlap, hops where they cross, and per-link colour, style and end
shapes.

### LT-018 — Colours that are not pale — 2026-08-30
Asked: "no pale colors". Shipped: an unwatched device is drawn by what it is
rather than by a health it has not got; the light ground is built against white
rather than dimmed from the dark one; contrast floors are held by test.

### LT-019 — A modern shape set — 2026-08-30
Shipped: `scripts/fetch-modern-shapes.mjs` pulls 118 curated shapes from Tabler
(MIT) and Simple Icons (CC0) with licences written beside them.

### LT-020 — Import a PowerPoint stencil deck — 2026-08-30
Shipped: `scripts/import-shapes.mjs` converts the Cisco deck's EMFs through
Inkscape and names them from slide captions; 217 written, indexed by the app.
**Superseded by LT-002**, which replaces Inkscape with LibreOffice, adds the
bounding-box crop the icons need, and expands groups.

### LT-021 — Views, sections, callouts, page setup — 2026-08-30
More than one drawing in one document; a labelled area that carries what stands
in it; a line that is a remark rather than a cable; and an export placed on A4,
A3, Letter or Tabloid.

### LT-022 — Drive it like Lucidchart and Visio — 2026-08-30
Asked 2026-08-30. Shipped: a click in the middle of a device selects it —
invisible connection handles were keeping their hit area and swallowing clicks
meant for neighbours; left-drag on bare canvas rubber-band selects and the
catch moves together; space held drags the whole diagram; double-click on bare
canvas writes borderless text that moves and groups like any other object.

### LT-001 — Neutral desk, white page, one colour token file — 2026-08-30
Shipped: the viewport is `--desk #EDEDED` and the drawing surface is a real
white page floating on it with a `--page-border` edge and the specified shadow.
The whole palette is hue-neutral. Chrome is `--chrome #FAFAFA` with
`--chrome-edge` dividers and no shadows, measured darker than the page.
Inspector fields sit on `--page`. The dark toggle moves the same tokens.
`rg '#[0-9a-fA-F]{6}' src/` now finds nothing outside `src/theme.ts` and the
three token blocks in `src/styles.css`.
**Differs from the ask in one place:** the page is drawn through React Flow's
viewport portal rather than as a node type — see D-021. Everything the ask
wanted from `zIndex -1` and the exclusions it listed comes for free that way.
**Found while doing it:** the page painted over the links until it was given
`z-index: -1`; the devices still drew, which made it look as though the links
had gone. And `--cv-text-dim`, `--cv-warn` and `--cv-accent` were being read in
three rules and have never been defined anywhere — every one of them was
silently falling back to a hardcoded hex.

### LT-007 — Grid clipped to the page — 2026-08-30
Shipped with LT-001: an SVG pattern inside the page, minor every 12px in
`--grid-minor`, major every 60px in `--grid-major`. React Flow's `<Background>`
is gone.

### LT-008 — The page is not an object — 2026-08-30
Shipped with LT-001, by construction rather than by filtering: the page is not
in `doc.nodes` at all, so there is nothing to keep out of the monitored-objects
table, the exports, the save payload, select-all, the crawl merge or any count.
Fit view fits the sheet rather than only what is on it, because fitting to the
devices puts the page edge off-screen and the edge is the thing that says where
the drawing surface is.

### LT-043 — Hover card during validation — 2026-08-30
The monitored-objects row, brought to the cursor: while validation runs,
hovering a device floats its primary probe's last result, RTT and checked
time over the node, ticking so "4s ago" never goes stale under a held
cursor. A 250ms intent delay keeps a crossing cursor from strobing cards;
the native tooltip yields while the card can show and returns when the
session stops. Tested end-to-end by staging a running session through a
dev-only store handle (`window.__cvStore`, absent from builds) — a real
session needs the Tauri backend the browser harness does not have.
This closes Item D and the 2026-08-30 batch (LT-034…LT-043).

### LT-042 — Autosave and restore — 2026-08-30
Shipped as crash recovery, composing with what already existed: edits are
saved for real 2.5 seconds after they stop, so the new slot covers only the
window that save can miss — the app dying mid-edit, or the machine going down
before the debounce fires. Written every 60s while dirty and on the way out,
offered back on the next open only when newer than the last real save (an
older slot is stale and is silently cleared), restored as an edit so undo can
take it back, cleared by every successful save. No cloud, no new dependencies.
**A day of debugging worth recording:** the harness intermittently reloads
mid-run (environmental — a renderer hiccup on two-hundred-check runs), and the
banner then appears exactly as designed, shifting the canvas 34px and breaking
every geometry measured before it. Bisecting was poisoned twice: first by
three zombie vite dev-servers all watching the tree and pushing stale reloads
into the page, then by editing app files seconds before runs against a live
HMR server. The harness now dismisses a recovery banner before any block that
measures, and the lesson — one dev server, no edits mid-run — is in the
handover.

### LT-041 — Export renders exactly the page rect — 2026-08-30
Shipped: SVG and PNG exports render exactly the LT-036 sheet — same function,
same visible-view nodes, so hidden views do not hold the exported sheet open —
in whichever ground is active, with devices staying where they sit on the
sheet rather than being slid to a shrink-wrapped margin. The export never
contained the minimap or selection chrome (it draws from the model, D-001);
that is now asserted rather than assumed.

### LT-040 — The filter box finds on the canvas — 2026-08-30
Shipped: typing in the monitored-objects filter lights every canvas match with
a ring and steps everything else back to 30% — found, not hidden. Enter
centres and selects the first match, zooming in only if the view is far out.
Clearing the box puts the canvas back exactly.

### LT-039 — Keyboard pass and a "?" shortcut overlay — 2026-08-30
Shipped: arrows nudge a pixel, Shift-arrows a grid step; Ctrl+D duplicates one
grid step over with the copy taking the selection; Esc closes what is on top
first, then clears the selection; "?" opens an overlay naming everything,
arrange keys included. Two things found on the way: React Flow's own arrow-key
a11y movement was adding five pixels on top of the one-pixel nudge, so a
single press walked a device six — it is off, and ours is the only keyboard
movement; and Ctrl+D used to leave the original selected, so the next Delete
removed both the copy and the thing copied.

### LT-038 — Align/distribute on the keyboard — 2026-08-30
Shipped: Ctrl+Alt+L/C/R aligns left/centre/right, Ctrl+Alt+T/M/B tops,
middles, bottoms, Ctrl+Alt+H/V evens the gaps across or down — the keyboard
half of the context menu's arrange, on the same `store.arrange` path, so the
two cannot drift apart. Only fires with more than one thing selected.

### LT-037 — Smart guides: Alt disables — 2026-08-30
Shipped: Alt held during a drag stands the guides and the snap down and clears
any guide already shown. Tracked in a ref so a keypress does not re-render the
canvas. Verified: a device dragged to 3px off a neighbour's edge snaps without
Alt and stays deliberately off-line with it.

### LT-034 — Light chrome must not be white — 2026-08-30
Shipped: `--desk #E4E4E4`, `--chrome #F1F1F1`, `--chrome-edge #D6D6D6`, page
stays the only pure white. Measured, not eyeballed: page–chrome 14 RGB points
apart, chrome–desk 13, page–desk 27 — all above the "few points" failure bar.
Table rows sit on the page inside a chrome frame; the header stays chrome.
Minimap: desk-coloured map, chrome edge, ink-dark node marks — the old
blue-grey marks were within a few points of the mask, which is what made it a
blob. Dark theme untouched. Both-theme screenshots attached to the checkpoint.

### LT-035 — Minimap show/hide in the top bar — 2026-08-30
Shipped: an "Overview" checkbox beside Reduce motion, default on, persisted as
a view preference for this machine (like which panels are open — not part of
any project). Verified that toggling moves nothing: the viewport transform is
read before and after and must be identical.

### LT-036 — Page auto-grows with content — 2026-08-30
Shipped: one function (`src/lib/pageRect.ts`) computes the sheet — content
bounds of the current view + 120px margin, snapped outward in 60px steps,
never below the default sheet, never shrinking on its own. The renderer, Fit
view, the top-bar fit and the grid all read it. Growth is live during a drag
and remembered a moment later, without dirtying the document when nothing
grew. "Fit page to content" on the canvas menu is the one deliberate shrink.
**One reading settled while testing:** the 120px margin is the rule even
inside the default sheet — a device 100px from an edge grows that edge a step,
because the margin is what was asked for, not "grow only past the border".

### LT-032 — A handover document — 2026-08-30
**Source:** asked 2026-08-30 — a doc covering "this app and its code and
everything we need to know about" to hand the work to a different model and
have it continue.
**Shipped:** `docs/HANDOVER.md`. The map (what the app is, the shape of the
code, how to run and verify it, what "done" means here) and the minefield —
six categories of trap that have actually cost time on this project, each with
the specific failure and how it was found. Plus the lab hardware and what each
device proved, and the things that are true but written nowhere else.
**Deliberately not in it:** credentials. They belong in the vault, and any
that appeared in conversation should be rotated.

### LT-030 — **bug** A click in the middle of a device did nothing — 2026-08-30
**Source:** flagged 2026-08-30 — "clicking a node's centre selected nothing — a
neighbouring node's connection handle covers the middle after a tidy, and
swallows the click... if a click on a device does nothing, aim at the icon."
**Shipped, in `d81b91b`, before this was raised:** connection handles are
hidden until a device is pointed at, but hidden was not the same as
untouchable — an invisible handle kept its hit area, and that area is larger
than the dot it draws, so the handles of one device sat over its neighbours.
They now take the pointer only while they are visible.
**Verified by:** the check "a click in the middle of a device selects it" in
`e2e/interact.mjs`, which clicks the geometric centre of a device on a tidied
diagram where the neighbours are close. It fails without the fix.
**Not done the way it was offered:** the suggestion was to make handles ignore
clicks that are not drags. Making them untouchable until shown is simpler,
needs no drag-versus-click guess, and matches what the handles already did
visually.

### LT-023 — Work tracking in the repository — 2026-08-30
This file, `docs/DECISIONS.md`, `docs/OPEN-QUESTIONS.md` and `CLAUDE.md`.

---

## Declined

*Explicitly ruled out by the operator. Kept with their IDs (never deleted),
never to be built.*

### LT-006 — Lucidchart `.lcsl` import
**Source:** asked 2026-08-30. File `Affinity-Native.lcsl`, 65 shapes.
**Blocked on:** the file. `Affinity-Native.lcsl` is no longer on this machine
(2026-08-30) and the converter cannot be verified without it — re-provide it
and this unblocks. The scan already recognises `.lcsl` by name (LT-003).
**Acceptance:**
- 35 shapes with real vector in `properties.Stencil.Shapes[]`: convert `Points`
  (normalised 0..1) and `Lines` (`p1`/`p2` indices, `n1`/`n2` cubic control
  *offsets*) into SVG paths in `viewBox "0 0 1 1"` — `C` where the offsets are
  present, `L` where they are not, closing when the chain returns to its start.
  Map `prop` values for FillColor/StrokeColor/LineWidth to `currentColor` or the
  shape's own colours.
- 24 `ImageFillProps` shapes and 3 `UserImage2Block` shapes reference remote
  Lucid assets. "Do not fabricate a placeholder that looks like a real icon."
  Skip them, write `stencils/lucid/unresolved.json` with name and url, and
  print "24 of 65 shapes reference remote Lucid assets and were skipped."
- The one `Group` ("Master.79") is expanded per Object or skipped entirely —
  "do NOT flatten it into a single unreadable blob".
- The 5 bare unit rectangles are skipped.
**Declined 2026-08-31:** the operator will not do this now or in future.

### LT-011 — Signed Windows installers on machines that do not trust the
internal CA
**Source:** asked 2026-08-29.
**Half of this is done and verified 2026-08-30:** the two GitHub secrets are
configured and every Windows bundle is being signed — run #98's annotation
reads "Signing as … CN=COREVIEW-APP Code Signing", thumbprint 7996CE1E…
Machines that trust the internal CA see a valid signature today.
**Still blocked on:** the other half — machines *outside* that trust, and
SmartScreen. Only an OV/EV certificate from a public CA clears those; the
internal COREVIEW-FGT-Root-CA cannot and never will.
**Declined 2026-08-31:** the operator will not do this now or in future. The internal-CA signing that already works is enough.

---

## Icebox


### LT-307 — Selling Coreview per seat — dropped 2026-09-18
Asked and designed the same day, then dropped the same day: "forget about the
per seat license". `docs/LICENSING.md` was written and is removed with it —
what replaced it is LT-308, a licence that keeps the app free to use while
reserving every other right.
**Kept here rather than deleted** because the reasoning is worth having if the
question ever comes back: the design was offline node-locked licensing, Ed25519
signatures, a machine fingerprint that never leaves the machine, and the honest
caveat that a check running on the customer's computer can always be removed by
someone determined.
*Raised but deliberately deferred. Not dropped.*

### LT-080 — `.vss` stencils do not import on Windows
**Source:** asked 2026-09-04 — "can we find a way to import vss", with the
app's own report pasted from a Windows machine pointed at My Shapes:
"83 Visio file(s) need libvisio-tools to convert — install it and reload".
**Why it fails:** the `.vss`/`.vssx` route runs libvisio's `vss2xhtml`, which
is packaged on Linux and has no Windows package. LibreOffice is not a way out:
its Visio filter is the same libvisio but calls `parse()`, and a stencil has
no drawing page — converting this operator's real Tripp Lite `.vss` through
`soffice` gives one empty page, while `vss2xhtml` on the same file gives 18
masters. Checked 2026-09-04, both ways, on the operator's own file.
**Tried and reverted, 2026-09-04 (D-024):** bundled the MSYS2 `mingw64` build
of `vss2xhtml`/`vsd2xhtml` and its DLLs (~40 MB) into the Windows installer
as a resource, resolved at startup with a `PATH` fallback. It built and
passed CI on a real `windows-latest` runner. The operator rejected it on
size: "made the installer up to 38MB I don't like that lets revert it and
remove whatever app or tool to covert the files i'm happy with what we have."
His stated workflow going forward: hand a stencil file over directly and
have it converted and committed the way `tripp-lite-racks.vss` was, rather
than have his own Windows install read a My Shapes folder natively.
**Deferred, not declined:** if a materially smaller way to read `.vss` on
Windows turns up — a native Rust reader for the legacy compound-binary
format, say, rather than shipping libvisio's own binary — this is still
wanted. Don't re-propose the ~40 MB DLL bundle; that trade is already made.

### LT-024 — Connection points on imported shapes
A Visio master carries named ports; an imported EMF is a picture. Reading ports
would let a link land on "Gi0/1" rather than on the right-hand side. Deferred:
the conversion path produces pictures, so there is nothing to read yet.

### LT-026 — Canvas performance above ~400 devices
Measured 2026-08-30: 400 devices open in ~2s, drag at ~15fps, pan at ~8fps;
120 devices at 33 and 18. The cost is ~60 DOM elements per device.
`onlyRenderVisibleElements` was tried and rejected (D-010). Not worth doing
until someone actually has a diagram that large.


