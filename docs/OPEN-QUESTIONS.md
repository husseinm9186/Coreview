# Open questions

Things deferred, or needing a decision that is not mine to make. Each one moves
to ROADMAP.md or DECISIONS.md when it is answered.

*Closed: Q-002 (where converted stencils live) — answered 2026-08-30, see
D-019. Q-005 (re-sourcing the remote Lucid shapes) — answered 2026-09-16 by
D-028: no vendor or third-party artwork is fetched or shipped. Q-015 (how much
IPAM) — answered 2026-09-18 by building both halves; see LT-285 in ROADMAP.md.
The choice was not as expensive as the question assumed: the discovered half is
derived on every draw rather than stored, so the register he keeps is only the
subnets and holds he types, and the two cannot drift apart. If he wants it
narrower — the view without the register — the typed half is one panel section
and one document field to drop. Q-009 (which licence Coreview ships under) —
answered 2026-09-18 by LT-308: proprietary, free to use, everything else
reserved, in `LICENSE`. The dependencies keep their own licences and are
credited in `THIRD-PARTY-NOTICES.md`. Q-017 (does Coreview serve an HTTP API) —
answered 2026-09-18: **no.** "Forget about Q-017 thats was thought not something
i wanted now." Nothing listens on a port; the app calls out and never in. See
D-041. Q-014 (lab identifiers in the repository's published history) — answered
2026-09-18 by LT-314: the published history is a single commit, so there is no
earlier commit for them to sit in. Rotating anything that was live is still
worth doing, because those commits were public for a time.*

---

### Q-001 — Install `libvisio-tools` for legacy `.vss`?
Raised 2026-08-30. `.vss` from Visio 2003–2010 is a compound binary file that
nothing here can open; `libvisio-tools` reads it. Installing a system package
is not a call I should make on your machine. Deferred by you the same day
("Skip the .vss for now"), so this is only live again if the `.zip` twins in
your shape folder turn out not to cover the same sets. See LT-012.

### Q-003 — What should the page default to?
Raised 2026-08-30 by LT-008. The spec says 1584x1224 (11x8.5in @ 144dpi),
which is Letter landscape. The export already has its own page-size menu with
A4 as an option. Should the canvas page follow the export page setting, or stay
a fixed size regardless?

### Q-004 — Does the page apply to every project or only new ones?
Raised 2026-08-30 by LT-008. Existing diagrams have devices at coordinates that
predate any page and may sit outside 1584x1224. Options: put the page under
them wherever they are, grow the page to contain them, or show the page only on
new projects.

### Q-005 — Re-sourcing the 27 remote Lucid shapes
Raised 2026-08-30 by LT-006 and D-018. They will be listed in
`stencils/lucid/unresolved.json` with their urls. Fetching them from
`images.lucid.app` is possible but they are somebody else's artwork under
somebody else's terms. Do you want them fetched, or replaced from the Tabler /
Simple Icons set, or left out?

### Q-006 — Catalyst 9000 and a lab LAG
Raised 2026-08-29, still open. LT-009 and LT-010 are both blocked on hardware
access rather than on work. Two bonded ports on the test switch and an hour
against a Catalyst would clear both.

### Q-007 — Is the root `ROADMAP.md` still wanted?
Raised 2026-08-30. There are two roadmap files and they had drifted apart.
`docs/ROADMAP.md` is now authoritative. Delete the root one, or leave it as a
one-line pointer? See LT-025.

### Q-008 — What exactly does "no HTTP client in the Rust core" forbid?
Raised 2026-09-16 by the parity mission, whose invariants include "No HTTP
client in the Rust core" and "Do not introduce any network call that the
operator did not explicitly start". Three things meet that line:
- **Already shipped (LT-124):** `coreview-probe` reads a host's plain-HTTP
  `Server` header over a raw TCP socket and its TLS certificate through
  `rustls`, during a sweep the operator started. No HTTP library, but it is an
  HTTP request.
- **Asked for:** RESTCONF (2.1, LT-205) is HTTP by definition, and the opt-in
  HTTP/HTTPS HEAD probe (3.1, LT-218) is too.
My reading, not yet confirmed: the rule means *no client that talks to the
internet or to a service of its own accord* — requests to a device the operator
pointed a scan or probe at are allowed, and no general-purpose HTTP crate
(`reqwest`, `hyper`) enters the tree. If that is wrong, LT-124's banner read
must come out, and LT-205 and LT-218 are declined.

### Q-010 — The CI matrix costs money
Raised 2026-09-16 by Phase 8 (LT-269): Windows 10 and 11, macOS 12+, Ubuntu
22.04 and 24.04. CI minutes are the operator's, and every push already builds
five installers. A full matrix on every push multiplies that. Run the matrix
only on tags or on demand, and keep every-push CI as it is?


### Q-011 — BGP and OSPF neighbours with no router to capture from
Raised 2026-09-16 by Phase 2 (LT-201). Parsers here are written against captured
output (CLAUDE.md; D-026 is the one exception). Nothing in the lab runs BGP or
OSPF: the switch has no BGP, `show ip ospf neighbor` is empty, and the BGP4-MIB and
OSPF-MIB tables are empty on all three lab devices that answer SNMP. Options:
point a crawl at a router that peers (any lab router with one OSPF adjacency is
enough), or rule, as D-026 did for stacking, that it may be built from the
standard MIBs (RFC 4273, RFC 4750) and marked unverified until it meets one.
LT-201 waits on the answer.

### Q-012 — An encrypted database means OpenSSL in every installer
Raised 2026-09-16 by Phase 7 (LT-261). SQLCipher is SQLite with encryption, and
rusqlite builds it only against OpenSSL's libcrypto. The database is bundled
today, so every installer would carry OpenSSL too — built from source on
Windows (Perl on the runner, several extra minutes on each of the installer jobs
you pay for) or linked from the system on Linux and macOS. It cannot be switched
on per user without shipping it to everyone. The credentials in the database are
already encrypted by the vault; what LT-261 adds is the project diagrams, event
history and crawl results at rest. Options: build it (and accept the build cost
and a second crypto library), encrypt only chosen tables with the vault's own
cipher instead, or leave the database to the operating system's disk encryption
(BitLocker, FileVault, LUKS) and say so. LT-261 waits on the answer.

### Q-013 — Hardware-backed keys with no hardware to build them on
Raised 2026-09-16 by Phase 7 (LT-263). Deriving the vault key through a TPM
(Windows, Linux) or the Secure Enclave (macOS) is three separate platform
integrations, and this machine has no TPM (`/dev/tpm*` does not exist) and is
not a Mac, so none of them could be run before being called done. The keychain
(LT-262) already puts the key behind the operating system's own protection,
which on Windows 11 and recent Macs is itself hardware-backed. Options: a machine
with a TPM 2.0 to build and test the Windows/Linux path on, a Mac for the Secure
Enclave, or close LT-263 as covered by LT-262. It waits on the answer.

### Q-016 — How much further towards Infoblox
Raised 2026-09-18 by LT-288/289 — "just like Infoblox". LT-288 and LT-289 take
the parts named outright: add, remove, rename, retitle, add and remove
addresses, reserve. Infoblox is much more than that, and the rest is guesswork
until asked:

- **Network containers.** A hierarchy, where `10.0.0.0/8` holds `10.1.0.0/16`
  holds `10.1.2.0/24`, with utilisation rolled up the tree. Coreview's register
  is flat; an address already lands in the most specific block that holds it, so
  the arithmetic is there, but the display and the editing are not.
- **DHCP ranges.** A span inside a subnet handed out by a server, so "free"
  means free *outside* the pool. Without it the free count treats a DHCP scope
  as empty space, which is how addresses get double-allocated.
- **Extensible attributes.** Arbitrary named fields on a subnet or address —
  site, owner, cost centre, ticket — searchable. Coreview has a note and a VLAN.
- **A change log.** Who changed which record and when. There is one operator
  and no accounts, so this is a history of edits rather than an audit trail.
- **CSV import.** Export exists (LT-285). Import means reconciling a
  spreadsheet against what discovery found, which is a merge with conflicts,
  not a load.

None of these are started. The first two are the ones that change whether the
numbers can be trusted; the rest are convenience.
