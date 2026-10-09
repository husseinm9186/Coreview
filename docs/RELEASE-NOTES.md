# Release notes

Newest first.

## 2.8.0 — 2026-10-09

**Backups**
- A backup can be taken over SNMP from Cisco IOS, IOS-XE and NX-OS: with
  the new tick on the Backups tab, each device is asked — one write into
  Cisco's configuration-copy table, with a read-write SNMP credential — to
  send its running or startup configuration to the SFTP server named under
  Tools → Settings, and Coreview collects the file from there and files it
  like any other capture, so history and before/after work unchanged. The
  SFTP server and its login live in Settings; the login is a vault kind of
  its own and is never offered to a device. A device without the table, or
  one that refuses the write, is read over SSH as before, and the run says
  why. Built from the MIB's definition; unverified on hardware until a
  Cisco has answered one.

## 2.7.1 — 2026-10-08

**Documentation**
- README, the Windows install guide, the signing notes and the architecture
  notes brought up to date: the installers CI publishes and their artifact
  names, the dependency and command counts, and where secrets live.
- The user guide describes every saved login being tried wherever Coreview
  logs in.

Nothing in the application changed since 2.7.0; this release rebuilds both
installers from the same code.

## 2.7.0 — 2026-10-08

**Discovery**
- Every login saved in the project is tried on a device that refuses the
  first, then any second login typed for the run, under both engines — and
  the same everywhere else Coreview logs in: backups, the SSH terminal, Path
  check, Tracert and Path-Trace's checks from a device. Only a refused login
  moves on to the next; an unreachable device is not retried once per login.
- A **Scan** box beside each subnet: the subnet is swept for devices that
  answer on the login port, and each one found is logged into, identified as
  a switch, router or firewall, and followed like any neighbour, so devices
  no CDP or LLDP neighbour names are still found.
- Switches, routers and firewalls on private addresses are followed even
  outside the subnets listed; the filter decides only which endpoints are
  logged into.
- NVIDIA Cumulus 5 (NVUE) and Aruba switches are read by both engines, with
  their neighbours' addresses.
- A Catalyst 9600 core classifies as a switch.

**Topology**
- Point-to-point routed links (/30, /31, /127) are drawn between the two
  devices that share them, on the right interfaces, even where CDP and LLDP
  are off, and say that the shared subnet is where they came from.
- A finished run keeps its devices as finished.

**SSH**
- Reach a device through the one that found it (device-hopping SSH).
- The terminal shows each login stage, and keeps its session when you leave
  the screen and come back.

**Interface**
- The canvas filter fits its window.

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
  crawler stays selectable.
- The run survives a tab change, lists each device that failed with the
  reason, and says which command a device last answered.
- A FortiGate's policies, address objects, FQDN resolutions, managed
  FortiSwitches and FortiAPs are read over its REST API when an API login
  is chosen; the login carries its HTTPS port.
- ArubaOS-CX switches are asked their own LLDP and MAC-table spellings.

- A stuck device no longer ends the run; Stop stops at once; a sidecar that
  stops answering is replaced.
- FortiOS 7.6 replies that ntc's templates refused are read by Coreview's own
  readers; a FortiSwitch has its own catalog.

**Topology and paths**
- The diagram's rows are the distance from the seed again, and devices seen
  on switch ports sit under their switch.
- Hosts known only from a firewall's ARP table hang off its interface, with
  their maker.
- A tunnel reached through itself no longer overflows the stack; a switch
  that only switches the frame no longer hides the firewall as first router;
  missing zone knowledge is Undetermined, not Deny.
- Identity and placement: all-zero MACs, placeholders sharing a first label,
  one cable claimed from both ends, known neighbours behind a router, crowds
  beside a placed box, two strangers on a port.
- Path-Trace from a LAN host starts at the gateway, not at a switch whose
  management address shares the subnet.

**Backups and tools**
- FortiGate and FortiSwitch backups read `show full-configuration`, send no
  `enable`, and allow 300 s per command.
- Tracert from a device shows each hop as it arrives and keeps them when the
  time limit is reached.

**Secrets**
- SNMP trap-host communities and RADIUS/TACACS server keys are scrubbed from
  support captures; a FortiGate's `ENC …` blobs never reach a database row;
  a parse error's quoted line is scrubbed.

**Sidecar**
- A slow SSH banner is waited for; a session a timeout closed is reported
  closed; a failed open closes its connection; the escalate step passes the
  vocabulary; FortiOS paging is restored outside the VDOM; an unlisted VDOM
  is refused.

**Packaging and build**
- Batch files are ASCII with CRLF, so the Windows build runs them as written.

- The sidecar starts with no console window on Windows.

Not in this release, logged: Tracert and Collect surviving a tab change
, a cable between two uncollected neighbours on the review,
VRF-aware next-hop resolution, and the EVE-NG platforms.
