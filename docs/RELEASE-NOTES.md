# Release notes

Newest first. Each entry names the roadmap items it closes; `docs/ROADMAP.md`
holds what each one asked for and what ran.

## 2.5.0 — 2026-09-30

The first release in which the catalog-driven collector is what **Discover
devices** runs, and the first checked against real hardware end to end.

**Discovery**
- *Discover devices* runs the Coreview collector by default: each device is
  recognised and sent only its own OS's read-only commands; CDP/LLDP
  neighbours, the default route's next hop and neighbours known only from
  ARP are followed within the hop, device and subnet limits. A next hop
  outside the private ranges is followed only when a subnet limit names it,
  so a login is never offered to a provider's router unasked. The classic
  crawler stays selectable. (LT-576, LT-612, D-062)
- The run survives a tab change, lists each device that failed with the
  reason, and says which command a device last answered. (LT-619–LT-621)
- A FortiGate's policies, address objects, FQDN resolutions, managed
  FortiSwitches and FortiAPs are read over its REST API when an API login
  is chosen; the login carries its HTTPS port. (LT-571, LT-578–LT-585,
  LT-596, LT-598)
- ArubaOS-CX switches are asked their own LLDP and MAC-table spellings.
  (LT-635)
- A stuck device no longer ends the run; Stop stops at once; a sidecar that
  stops answering is replaced. (LT-588, LT-589, LT-609, LT-617)
- FortiOS 7.6 replies that ntc's templates refused are read by Coreview's own
  readers; a FortiSwitch has its own catalog. (LT-563–LT-567)

**Topology and paths**
- The diagram's rows are the distance from the seed again, and devices seen
  on switch ports sit under their switch. (LT-575, LT-605, LT-606)
- Hosts known only from a firewall's ARP table hang off its interface, with
  their maker. (LT-597)
- A tunnel reached through itself no longer overflows the stack; a switch
  that only switches the frame no longer hides the firewall as first router;
  missing zone knowledge is Undetermined, not Deny. (LT-637–LT-639)
- Identity and placement: all-zero MACs, placeholders sharing a first label,
  one cable claimed from both ends, known neighbours behind a router, crowds
  beside a placed box, two strangers on a port. (LT-640–LT-645)
- Path-Trace from a LAN host starts at the gateway, not at a switch whose
  management address shares the subnet. (LT-570)

**Backups and tools**
- FortiGate and FortiSwitch backups read `show full-configuration`, send no
  `enable`, and allow 300 s per command. (LT-572, LT-573, LT-587, LT-594)
- Tracert from a device shows each hop as it arrives and keeps them when the
  time limit is reached. (LT-577)

**Secrets**
- SNMP trap-host communities and RADIUS/TACACS server keys are scrubbed from
  support captures; a FortiGate's `ENC …` blobs never reach a database row;
  a parse error's quoted line is scrubbed. (LT-607, LT-608, LT-614)

**Sidecar**
- A slow SSH banner is waited for; a session a timeout closed is reported
  closed; a failed open closes its connection; the escalate step passes the
  vocabulary; FortiOS paging is restored outside the VDOM; an unlisted VDOM
  is refused. (LT-601, LT-627–LT-631)

**Packaging and build**
- Batch files are ASCII with CRLF, so the Windows build runs them as written.
  (LT-593)
- The sidecar starts with no console window on Windows. (LT-591)

Not in this release, logged: Tracert and Collect surviving a tab change
(LT-626), a cable between two uncollected neighbours on the review (LT-646),
VRF-aware next-hop resolution (LT-647), and the EVE-NG platforms (LT-559).
