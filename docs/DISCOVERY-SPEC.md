# Coreview — Discovery / Topology / Path Engine — specification

The operator's specification of 2026-09-29, kept here so the work is measured
against it. Sections are his words; the **Architecture (final)** section is
his decision of the same day, replacing the original "Architecture decision
(propose, then implement)". The **P1 plan** at the end is the proposal made
against it and is marked with its status. Roadmap: LT-507. Decision: D-060.

## Context
- Tauri 2 + React/TS/Vite + @xyflow/react, Rust backend, SQLite. Local-first, no cloud. Linux first, then a Windows .exe with everything bundled.
- Goal: vendor-aware CDP/LLDP crawler → normalized discovery tables → topology builder → routing-table-driven path builder.
- First: read CLAUDE.md, src/, src-tauri/, existing schema/SSH code. Summarize what exists, propose a plan for the 4 phases at the bottom, wait for approval, then implement phase by phase.

## Architecture (final)

Transport/collector end state is Rust-native (B). Python sidecar (A) is a temporary bridge only.

1. Phase 1 — bridge (A): scrapli + ntc-templates + genie in a Python sidecar. Windows packaging: embeddable CPython zip + prebuilt site-packages as a Tauri `externalBin` (NO PyInstaller onefile, NO UPX). Sidecar contract is JSON-lines over stdio: `{device, cmd, status, rows[], raw_ref, duration_ms}`. Rust owns SQLite, graph, path engine, UI. API-based collectors (FortiOS REST, PAN-OS XML API, AOS-CX REST, Meraki) are Rust/reqwest from day one — never in the sidecar.

2. Phase 2 — Rust parser engine: implement a TextFSM interpreter in Rust (check crates.io for an existing `textfsm` crate first; if immature, write one). Vendor ntc-templates into `resources/templates/` (keep the Apache 2.0 LICENSE and NOTICE). Load templates at runtime; the catalog `parser: textfsm:<name>` resolves to those files. Acceptance criterion: the Rust engine passes 100% of ntc-templates' own test fixtures (`tests/<platform>/<command>/*.raw` vs `*.yml`) in `cargo test`. Extract netmiko/scrapli per-OS session behaviour (prompt regex, paging prep, enable, VDOM/context/vsys switching) into the catalog YAML `session:` block — no Python session logic survives.

3. Phase 3 — shadow mode: behind a feature flag, run both collectors on every run, diff parsed rows per (os, command), log mismatches to `command_log`. Flip a vendor to Rust when the mismatch rate is 0 across ntc fixtures + the operator's lab captures. The sidecar remains only for genie-only Cisco parsers; close those gaps with new TextFSM templates or native `| json`.

4. Phase 4 — delete the sidecar. Single signed Rust binary.

### Packaging / trust (applies from Phase 1)
- No self-extracting or packed binaries. The sidecar spawns from the install dir, not `%TEMP%`.
- Pin deps with hashes (`pip --require-hashes`; `Cargo.lock`); generate an SBOM (`cargo auditable` / `pip-audit`).
- Sign every PE (Tauri exe, python.exe, DLLs/pyd, installer) via Tauri `signCommand` — Azure Trusted Signing. *(Amended by the operator, 2026-09-29: the existing Coreview certificate, not Azure Trusted Signing; see docs/SIGNING.md and docs/INSTALL-WINDOWS.md.)*
- Release CI: build → sign → VirusTotal scan (vt-cli) → fail on any detection → publish SHA-256 + SBOM.
- Credentials in the OS keychain only. Outbound only SSH/443 to user-entered targets; no telemetry.

## Catalog schema (per OS)
vendor, os, fingerprint{probe, match_regex}, session{prep[], prompt_regex}, role_hint{model_regex→role},
caps_probe[]: cheap cmds whose output only sets cap.* flags,
commands[]: id, cmd, gate (expr over cap.*/role.*: `always`, `cap.vrf && cap.bgp`, `!cap.vdom`), foreach (vrf|vdom|vsys|context|instance),
  parser (json|xml|textfsm:<tpl>|genie:<name>|regex:<file>|api:<path>), feeds[tables], timeout, weight (light|heavy), verified (lab|docs|unverified)
Rules: fingerprint → role HINT from model regex → caps_probe confirms → gated commands. Probe wins over hint. Every command is optional: unsupported/timeout = command_log entry, never fatal. Light commands first, heavy last.

## Capability flags
switching routing vrf ospf eigrp bgp isis rip fhrp pbr nat ipsec gre dmvpn sdwan mpls vxlan_evpn stack vss_svl vpc_mlag_vsx ha fex cdp lldp wlc vdom vsys multi_context structured_output
Derived roles: access_switch l3_switch router firewall wlc ap host unknown. Operator role override is stored and survives re-runs.

## Command catalog (applicable-only; `foreach` expands per VRF/VDOM/vsys/context)

### cisco_ios (IOS / IOS-XE: Catalyst, ISR/ASR/C8k, 9800)
prep: terminal length 0 · terminal width 511
fp: show version → /Cisco IOS(-| )XE Software|Cisco IOS Software/
role_hint: /C9[2-6]\d\d|C3[5678]50|C2960|WS-C|C4[59]00|C6[58]00/→switch · /ISR|ASR1|CSR1|C8[0-5]00/→router · /C9800/→wlc
caps_probe: show ip protocols · show run | include ^ip routing|^router |^ip route |^vrf definition|^ip vrf |^interface Tunnel|^ip nat |^crypto |^ip policy|^mpls |^interface Port-channel|^ standby|^ vrrp|^ glbp
always: show version · show inventory · show ip interface brief · show interfaces · show interfaces description · show ip arp · show cdp neighbors detail · show lldp neighbors detail · show running-config (heavy, scrub secrets)
cap.stack: show switch · show module · show redundancy · show stackwise-virtual
cap.switching: show interfaces status · show interfaces switchport · show interfaces trunk · show vlan brief · show vtp status · show spanning-tree · show spanning-tree root · show mac address-table (12.2: show mac-address-table) · show etherchannel summary · show ip dhcp snooping binding · show device-tracking database (XE)
cap.routing: show ip route summary · show ip route · show ip route static · show ipv6 route · show ipv6 interface brief · show ipv6 neighbors · show route-map · [cap.pbr] show ip policy
cap.vrf: show vrf (legacy: show ip vrf) → foreach vrf: show ip route vrf {vrf} · show ip arp vrf {vrf} · show ip protocols vrf {vrf}
cap.ospf: show ip ospf neighbor · show ip ospf interface brief
cap.eigrp: show ip eigrp neighbors · foreach vrf: show ip eigrp vrf {vrf} neighbors
cap.bgp: show bgp all summary · [cap.vrf] show ip bgp vpnv4 all summary
cap.isis: show isis neighbors
cap.fhrp: show standby brief · show vrrp brief · show glbp brief
cap.ipsec/dmvpn: show crypto session brief · show crypto ipsec sa · show dmvpn
cap.nat: show ip nat statistics · show ip nat translations (cap at 5k lines)
cap.mpls: show mpls interfaces · show mpls ldp neighbor brief · show mpls forwarding-table
role.wlc (9800): show ap summary · show ap cdp neighbors · show ap lldp neighbors (verify) · show wlan summary · show wireless client summary · show wireless mobility summary
live-path: show ip route [vrf {vrf}] {dst} · show ip cef [vrf {vrf}] exact-route {src} {dst} · show ip arp {nh} · show mac address-table address {mac} · traceroute [vrf {vrf}] {dst} source {src}

### cisco_nxos
prep: terminal length 0 · append `| json` wherever supported (TextFSM fallback)
fp: show version → /Cisco Nexus Operating System|NX-OS/
caps_probe: show feature (source of truth: ospf eigrp bgp isis vpc lacp interface-vlan hsrp vrrp pim lldp fex nv overlay vn-segment-vlan-based fabric forwarding mpls) · show run | include ^ip route |^route-map|^interface Tunnel|^ip policy|^vrf context
always: show version · show inventory · show module · show hostname · show interface · show interface brief · show interface description · show ip interface brief vrf all · show ip arp vrf all · show cdp neighbors detail · show lldp neighbors detail · show running-config (heavy)
cap.switching: show interface status · show interface switchport · show interface trunk · show vlan brief · show spanning-tree · show mac address-table · show port-channel summary
cap.vpc: show vpc · show vpc consistency-parameters global
cap.fex: show fex · show fex detail
cap.routing: show vrf · show ip route vrf all · show ip route static vrf all · show ipv6 route vrf all · show ipv6 neighbor vrf all · show route-map
cap.ospf: show ip ospf neighbors vrf all · cap.eigrp: show ip eigrp neighbors vrf all · cap.isis: show isis adjacency vrf all
cap.bgp: show bgp sessions vrf all · show bgp all summary
cap.fhrp: show hsrp brief · show vrrp
cap.vxlan_evpn: show nve peers · show nve vni · show bgp l2vpn evpn summary · show l2route evpn mac all
cap.mpls: show mpls ldp neighbor brief · show mpls switching
live-path: show ip route {dst} vrf {vrf} · show routing hash {src} {dst} vrf {vrf} · show ip arp {nh} vrf {vrf} · show mac address-table address {mac} · traceroute {dst} vrf {vrf} source {src}

### cisco_iosxr
prep: terminal length 0 · terminal width 0
fp: show version → /Cisco IOS XR Software/
caps_probe: show run | include ^router |^route-policy|^vrf |^interface tunnel|^mpls|^l2vpn|^evpn
always: show version · show inventory · show platform · show interfaces · show interfaces description · show ipv4 interface brief · show ipv6 interface brief · show arp · show lldp neighbors detail · show cdp neighbors detail · show bundle · show lacp · show running-config (heavy)
cap.vrf: show vrf all → foreach vrf: show route vrf {vrf} · show arp vrf {vrf}
cap.routing: show route · show route static · show route ipv6 unicast
cap.ospf: show ospf vrf all neighbor · cap.isis: show isis neighbors · cap.bgp: show bgp summary · show bgp vrf all summary · show bgp vpnv4 unicast summary
cap.fhrp: show hsrp brief · show vrrp brief
cap.mpls: show mpls interfaces · show mpls ldp neighbor brief · show mpls forwarding
cap.l2vpn: show l2vpn bridge-domain brief · show l2vpn xconnect · show evpn evi
live-path: show route [vrf {vrf}] {dst} detail · show cef [vrf {vrf}] {dst} · traceroute [vrf {vrf}] {dst} source {src}

### arista_eos
prep: terminal length 0 · `| json` on everything (or eAPI if enabled)
fp: show version → /Arista/
caps_probe: show running-config | include ^router |^ip routing|^vrf instance|^ip virtual-router|^vrrp|^interface Vxlan|^mlag|^policy-map type pbr|^interface Tunnel|^ip route
always: show version · show inventory · show hostname · show interfaces · show interfaces status · show interfaces description · show ip interface brief · show ip arp vrf all · show lldp neighbors detail · show running-config (heavy)
cap.switching: show interfaces switchport · show interfaces trunk · show vlan · show spanning-tree · show mac address-table · show port-channel summary · show lacp neighbor
cap.mlag: show mlag · show mlag interfaces
cap.routing: show vrf · show ip route vrf all · show ipv6 route vrf all · show ipv6 neighbors · [cap.pbr] show policy-map type pbr
cap.ospf: show ip ospf neighbor vrf all · cap.bgp: show ip bgp summary vrf all · cap.isis: show isis neighbors
cap.fhrp: show vrrp · show ip virtual-router
cap.vxlan_evpn: show vxlan vni · show vxlan vtep · show vxlan address-table · show bgp evpn summary
live-path: show ip route vrf {vrf} {dst} · show ip arp vrf {vrf} {nh} · show mac address-table address {mac} · traceroute vrf {vrf} {dst} source {src}

### juniper_junos (EX/QFX/MX/SRX)
prep: set cli screen-length 0 · set cli screen-width 0 · `| display xml` (json on ≥14.2)
fp: show version → /JUNOS|Junos/ · role_hint: EX|QFX→switch, MX→router, SRX→firewall
caps_probe: show configuration protocols | display set · show configuration routing-instances | display set · show configuration firewall | display set (FBF = PBR) · [SRX] show configuration security | display set
always: show version · show chassis hardware · show system information · show interfaces terse · show interfaces descriptions · show interfaces · show arp no-resolve · show ipv6 neighbors · show lldp neighbors · show lacp interfaces · show configuration | display set (heavy)
cap.stack: show virtual-chassis · show chassis routing-engine
cap.switching: show ethernet-switching interfaces · show vlans · show spanning-tree bridge · show spanning-tree interface · show ethernet-switching table
cap.routing: show route instance · show route · show route protocol static · show route forwarding-table · foreach instance: show route table {ri}.inet.0
cap.ospf: show ospf neighbor instance all · cap.bgp: show bgp summary · foreach instance: show bgp summary instance {ri} · cap.isis: show isis adjacency
cap.fhrp: show vrrp brief · cap.mpls: show ldp neighbor · show mpls lsp · show mpls interface
cap.vxlan_evpn: show evpn instance · show ethernet-switching vxlan-tunnel-end-point remote
role.firewall: show security zones · show security policies · show security nat source rule all · show security nat destination rule all · show security nat static rule all · show security ike security-associations · show security ipsec security-associations · show chassis cluster status
live-path: show route {dst} table {ri}.inet.0 · show route forwarding-table destination {dst} table {ri} · [SRX] show security match-policies from-zone {z1} to-zone {z2} source-ip {src} destination-ip {dst} protocol {p} source-port {sp} destination-port {dp} · traceroute {dst} routing-instance {ri} source {src}

### fortios (FortiGate — SSH; REST when a token is provided)
prep: driver sets `config system console / set output standard` (restore after). Multi-VDOM: system cmds in `config global`; routing/policy in `config vdom` → `edit {vdom}`.
fp: get system status → /Version: FortiGate/
caps_probe: get system status (Virtual domain configuration) · diagnose sys vd list · show router ospf · show router bgp · show router static · show router policy · show system sdwan (6.x: show system virtual-wan-link) · show vpn ipsec phase1-interface · show firewall vip · show system interface (set vrf / set type aggregate|vlan|tunnel / set role)
always (global): get system status · get system ha status · get system performance status · get system interface physical · show system interface · get system arp · diagnose ip address list · diagnose ip route list · diagnose lldprx neighbors summary · diagnose lldprx neighbors (verify syntax on target release; needs lldp-reception enabled)
foreach vdom: get system interface · show system zone · get router info routing-table all (VRF sections "Routing table for VRF=n") · get router info routing-table database · get router info kernel · show router static · [cap.pbr] show router policy · diagnose firewall proute list · [cap.ospf] get router info ospf neighbor · [cap.bgp] get router info bgp summary · show firewall policy · show firewall address · show firewall addrgrp · show firewall vip · show firewall ippool
cap.ipsec: get vpn ipsec tunnel summary · diagnose vpn tunnel list · show vpn ipsec phase1-interface · show vpn ipsec phase2-interface
cap.sdwan: show system sdwan · diagnose sys sdwan member · diagnose sys sdwan service · diagnose sys sdwan health-check
cap.fortilink: execute switch-controller get-conn-status
REST (?vdom=): /api/v2/monitor/system/status · /monitor/system/interface · /cmdb/system/interface · /cmdb/system/zone · /monitor/network/arp · /monitor/network/lldp/neighbors · /monitor/router/ipv4 · /cmdb/router/static · /cmdb/router/policy · /monitor/router/ospf/neighbors · /monitor/router/bgp/neighbors · /cmdb/firewall/policy · /cmdb/firewall/vip · /monitor/vpn/ipsec · /monitor/virtual-wan/members · /monitor/system/ha-peer
live-path: get router info routing-table details {dst} · diagnose firewall proute list · execute traceroute-options source {src} ; execute traceroute {dst}

### panos (Palo Alto — CLI, or XML API type=op with identical commands)
prep: set cli pager off · set cli config-output-format set · set cli scripting-mode on
fp: show system info → /^model: PA-|^sw-version:/
caps_probe: show system info (multi-vsys, advanced-routing) · show config running (parse: virtual-router protocols, tunnel/ipsec, rulebase/pbf, rulebase/nat) · if `show routing route` errors on advanced routing → use `show advanced-routing *`
always: show system info · show high-availability state · show interface all · show interface logical · show lacp aggregate-ethernet all · show lldp neighbors all · show arp all · show mac all · show vlan all · show routing interface · show config running (heavy)
cap.routing (legacy VR): show routing route · show routing fib · foreach vr: show routing route virtual-router {vr} · [cap.ospf] show routing protocol ospf neighbor · [cap.bgp] show routing protocol bgp summary · show routing protocol bgp peer
cap.routing (advanced, 10.2+): show advanced-routing route · show advanced-routing fib · show advanced-routing ospf neighbor · show advanced-routing bgp peer (verify)
always (fw): show running security-policy · show running nat-policy · show pbf rule all · [cap.ipsec] show vpn ike-sa · show vpn ipsec-sa · show vpn tunnel · show vpn flow
cap.vsys: foreach vsys: set system setting target-vsys {vsys} → policy/nat/pbf/interface queries → set system setting target-vsys none
live-path: test routing fib-lookup virtual-router {vr} ip {dst} · test pbf-policy-match from {zone} source {src} destination {dst} protocol {p} · test nat-policy-match from {z1} to {z2} source {src} destination {dst} protocol {p} destination-port {dp} · test security-policy-match from {z1} to {z2} source {src} destination {dst} protocol {p} destination-port {dp} · traceroute source {src} host {dst}

### aoscx (Aruba CX 6xxx/8xxx/10k — REST v10.x preferred)
prep: no page
fp: show version → /ArubaOS-CX/
caps_probe: show running-config | include ^router |^vrf |^vrrp|^active-gateway|^interface vxlan|^evpn|^vsx|^vsf|^ip route |^interface lag
always: show version · show system · show hostname · show interface brief · show interface · show ip interface brief · show arp all-vrfs · show ipv6 neighbors all-vrfs · show lldp neighbor-info · show lldp neighbor-info detail · show running-config (heavy)
cap.stack/pair: show vsf · show vsx status · show vsx brief · show module
cap.switching: show vlan · show spanning-tree · show mac-address-table · show lag brief · show lacp interfaces
cap.routing: show vrf · show ip route all-vrfs · show ipv6 route all-vrfs
cap.ospf: show ip ospf neighbors all-vrfs · cap.bgp: show bgp ipv4 unicast summary all-vrfs (verify keyword placement)
cap.fhrp: show vrrp brief · show active-gateway
cap.vxlan_evpn: show interface vxlan 1 vni · show evpn · show bgp l2vpn evpn summary
REST: /rest/v10.xx/system · /system/interfaces · /system/vlans · /system/vrfs/{vrf}/routes · /system/interfaces/{if}/lldp_neighbors
live-path: show ip route {dst} vrf {vrf} · show arp vrf {vrf} · traceroute {dst} vrf {vrf} source {src}

### aoss (Aruba/HPE ProCurve 2530/2930/3810/5400 — NOTE: "trunk" = LAG here)
prep: no page
fp: show system → /Software revision|ProCurve|Aruba/ and version /[A-Z]{2}\.\d\d\./
caps_probe: show running-config | include ^ip routing|^router |^ip route |^vrrp|^trunk |^stacking
always: show system · show version · show modules · show interfaces brief · show name · show ip · show arp · show lldp info remote-device · show lldp info remote-device detail · show cdp neighbors detail · show running-config
cap.stack: show stacking
cap.switching: show vlans · show vlans ports all detail · show trunks · show lacp · show spanning-tree · show mac-address
cap.routing: show ip route · [cap.ospf] show ip ospf neighbor · [cap.fhrp] show vrrp · [cap.bgp] show ip bgp summary (5400R/3810 only)
live-path: traceroute {dst} source {src}

### cisco_asa / cisco_ftd (no CDP/LLDP — placement inferred from neighbors' ARP/MAC + shared subnets)
prep: terminal pager 0 (ASA) · FTD CLI is the same subset
fp: show version → /Adaptive Security Appliance|Firepower Threat Defense/
caps_probe: show mode (multi → show context → foreach ctx: changeto context {ctx}) · show running-config | include ^router |^route |^nat |^crypto map|^tunnel-group|^vrf
always: show version · show inventory · show failover · show interface ip brief · show interface · show nameif · show arp · show route · show nat · show nat detail · show running-config (heavy)
cap.switching (transparent): show mac-address-table
cap.ospf: show ospf neighbor · cap.eigrp: show eigrp neighbors · cap.bgp: show bgp summary
cap.vrf (FTD 6.6+): show vrf → foreach vrf: show route vrf {vrf}
cap.ipsec: show crypto ipsec sa · show vpn-sessiondb summary
FTD extra: show network · show managers · FMC REST: /devices/devicerecords/{id}/physicalinterfaces · /routing/ipv4staticroutes · /policy/accesspolicies · /policy/ftdnatpolicies
live-path: show route {dst} · packet-tracer input {in_if} {proto} {src} {sport} {dst} {dport} (ASA and FTD)

### cisco_wlc_aireos (5520/8540/3504; 9800 = cisco_ios role.wlc)
prep: config paging disable
fp: show sysinfo → /Cisco Controller|Product Name/
always: show sysinfo · show inventory · show interface summary · show cdp neighbors detail · show ap summary · show ap cdp neighbors all · show wlan summary · show client summary · show redundancy summary · show mobility summary · show route summary · show network summary

### meraki (Dashboard API only)
GET /organizations · /organizations/{org}/networks · /organizations/{org}/devices · /organizations/{org}/devices/statuses · /networks/{net}/topology/linkLayer · /devices/{serial}/lldpCdp · /devices/{serial}/switch/ports · /devices/{serial}/switch/ports/statuses · /networks/{net}/switch/stacks · /devices/{serial}/switch/routing/interfaces · /devices/{serial}/switch/routing/staticRoutes · /networks/{net}/appliance/vlans · /networks/{net}/appliance/staticRoutes · /organizations/{org}/appliance/uplink/statuses · /networks/{net}/appliance/firewall/l3FirewallRules · /networks/{net}/appliance/vpn/siteToSiteVpn · /organizations/{org}/appliance/vpn/statuses · /networks/{net}/wireless/ssids · /networks/{net}/clients?timespan=86400
Meraki gear also appears as LLDP/CDP neighbors of other vendors — reconcile by MAC/serial.

### hosts / hypervisors (phase 4)
Linux/Proxmox: ip -j addr · ip -j route show table all · ip -j neigh · bridge -j fdb show · lldpcli show neighbors -f json
ESXi: esxcli network nic list · esxcli network vswitch standard list · vim-cmd hostsvc/net/query_networkhint (per-vmnic CDP/LLDP)
Windows: Get-NetIPConfiguration | ConvertTo-Json · Get-NetRoute · Get-NetNeighbor

### snmp fallback (phase 4, when SSH is unavailable)
LLDP-MIB lldpRemTable · CISCO-CDP-MIB cdpCacheTable · Q-BRIDGE-MIB dot1qTpFdbTable (community@vlan / vlan context) · IP-MIB ipNetToPhysicalTable · IP-FORWARD-MIB inetCidrRouteTable · IF-MIB ifTable/ifXTable · ENTITY-MIB entPhysicalTable

### phase-2 catalog stubs (YAML only, parsers later)
huawei_vrp/hpe_comware: display version · display interface brief · display ip interface brief · display lldp neighbor-information verbose · display mac-address · display arp · display ip routing-table [vpn-instance X] · display ospf peer · display bgp peer · display vlan · display stp brief · display link-aggregation summary | display eth-trunk · display vrrp brief · display current-configuration
mikrotik_routeros: /system resource print · /interface print · /ip address print · /ip route print · /ip neighbor print · /ip arp print · /interface bridge host print · /routing ospf neighbor print · /routing bgp session print
dell_os10 · extreme_exos · ruckus_icx · ubiquiti_edgeos

## Discovery tables (SQLite; every row has run_id, device_id, collected_at; raw output gzip'd per command)
device: hostname fqdn vendor os os_version model serial mgmt_ip role role_override base_mac chassis_ids[] stack_members[] ha_role contexts[] (vdom/vsys/context)
interface: name canon(normalized long form) kind(phys|svi|lo|tunnel|lag|subif|mgmt) admin oper speed duplex mac descr mtu lag_parent sw_mode(access|trunk|routed) access_vlan native_vlan allowed_vlans vrf zone context stp_role stp_state
ip_address: interface vrf ip prefixlen af kind(primary|secondary|vip|anycast)
neighbor: local_if proto(cdp|lldp|api) rem_sysname rem_chassis_id rem_port_id rem_port_descr rem_mgmt_ip rem_platform rem_caps
mac_table: vlan mac interface type age
arp: vrf ip mac interface age
vlan: vlan_id name state ports[]
lag: name proto(lacp|static|pagp) members[] state partner_sysid
stp: instance root_bridge root_port bridge_prio port_roles{if: role,state,cost}
vrf: name rd rt_import[] rt_export[] interfaces[]
route: vrf prefix proto ad metric next_hops[{ip,if,weight}] is_default recursive age
routing_neighbor: vrf proto neighbor_id neighbor_ip local_if state area_or_as uptime
fhrp: proto group interface vip prio state peer_ip
policy_route: vrf seq in_if src dst proto port action_nh action_if source(route-map|policy|proute|pbf|fbf)
nat_rule: seq type(snat|dnat|static|vip) orig_src orig_dst trans_src trans_dst in_zone_if out_zone_if service
fw_zone: name interfaces[]
fw_policy: seq name src_zones dst_zones src_addr dst_addr services action nat_ref enabled
tunnel: name kind(ipsec|gre|dmvpn|vxlan|sdwan) local_ip remote_ip bound_if state
ha_pair: kind(stack|vss|svl|vc|vpc|mlag|vsx|fw_ha|cluster) members[] state peer_link
ap: controller ap_name ap_ip ap_mac model nbr_switch nbr_port wlans[]
endpoint: mac ip vlan switch port seen_via(mac|arp|dhcp_snoop|device_tracking|meraki_clients) oui_vendor
link: a_dev a_if b_dev b_if kind(cdp|lldp|api|inferred_mac|inferred_l3|manual) confidence lag_group evidence[]
l3_adjacency: a_dev a_if a_vrf b_dev b_if b_vrf subnet proto
collection_run: seed scope status started finished · command_log: cmd status(ok|unsupported|timeout|auth|parse_error) duration_ms rows raw_ref

## Crawler
- Inputs: seeds (IP/CIDR/hostname), credential profiles tried in order (password/key + enable), API tokens (FortiOS/PAN-OS/AOS-CX/Meraki), scope: include/exclude CIDRs, max hops, vendor allowlist, skip roles (ap/phone/host), global + per-device concurrency, timeouts.
- BFS from seeds. Dedupe devices by serial/base MAC, never by IP. Neighbor candidate = CDP/LLDP mgmt address; if absent, resolve chassis-id MAC via ARP already collected; else placeholder node.
- Don't recurse into phones/APs/printers/hosts (LLDP capability bits, CDP platform). APs come from WLC/Meraki.
- Per device: connect → fingerprint → caps_probe → build collection plan (commands + skip reasons) → run light→heavy → persist raw + parsed.
- Lockout protection: max 1 failed credential per device per run; stop on auth failures, don't cycle.
- Offline mode: import a folder `captures/<host>/<command>.txt` and run the identical pipeline with no SSH. Replay from stored raw after parser fixes.
- Run diff: new/lost devices, links, neighbors, routes.

## Topology builder
- Interface normalization lib with tests: Cisco short/long (Gi1/0/1 ↔ GigabitEthernet1/0/1), NX-OS Eth1/1, EOS Et1, Junos ge-0/0/0 vs unit .0, AOS-S A1 / 1/A1, FortiOS port1/x1, PAN ethernet1/1. LLDP port-id may be ifname, MAC, or ifindex — map all three.
- Device matching for neighbor rows: chassis_id ∈ device MACs → mgmt_ip ∈ device IPs → normalized sysname (strip domain, case). Unmatched = placeholder.
- Link = merged bidirectional neighbor pairs. Confidence: both directions 1.0 · one direction 0.7 · inferred via ARP/MAC 0.6 · inferred via shared subnet 0.4. Store evidence.
- LAG collapse: both ends LAG members → one logical link with member list; mismatched members flagged.
- Stack/VSS/SVL/VC → one node with members. vPC/MLAG/VSX → two nodes + peer-link + pair marker; dual-homed LAGs drawn to both.
- Non-LLDP devices (ASA/FTD, unmanaged, hosts): device interface MAC seen in switch S mac_table on port P with no neighbor → inferred link. Port with many MACs and no neighbor → "unknown switch" placeholder. Port with one MAC, access mode → endpoint leaf.
- WLC/Meraki AP CDP/LLDP → AP↔switch-port links.
- L3 adjacency: shared subnet across devices (excluding /32 and mgmt) + routing_neighbor confirmation + FHRP VIP ownership.
- Overlays: VXLAN/EVPN VTEP peers and IPsec/GRE/DMVPN tunnels as overlay edges with underlay sub-links.

## Path builder (modes: modeled from snapshot · live = targeted per-hop commands · verify = compare to traceroute)
Input: src (IP, or device+vrf), dst IP, optional proto/port, start VRF.
1. Locate src: endpoint table → switch/port → VLAN → gateway = FHRP active (or SVI owner). Anycast/VARP/active-gateway/vPC anycast: both peers own the VIP → prefer the switch where the src MAC is learned locally, else branch.
2. At each L3 hop: policy_route first (PBR/PBF/proute/FBF match on in_if/src/dst/proto/port) → else LPM on route(vrf,dst). ECMP → branch and return all paths. Recursive next hop → re-lookup, depth ≤3. Default route flagged.
3. Firewall pipeline per vendor: FortiOS VIP(DNAT) → route → policy → SNAT. PAN-OS route(pre-NAT dst) → policy → NAT → route(post-NAT). ASA/FTD NAT can dictate egress interface. Record zone_in/zone_out, first matching fw_policy (objects resolved), verdict, NAT rewrites.
4. Resolve next hop → device: ip_address exact (FHRP VIP → active) → else current device's ARP → MAC → device interface MAC → else "unmanaged hop", continue via traceroute if verify mode.
5. L2 expansion between L3 hops: egress SVI → port where next-hop MAC is learned → follow links switch to switch until MAC is learned on an edge port toward the next-hop device. Record switches/ports; STP-blocked port on the path = warning.
6. Tunnels/overlays: egress = tunnel/NVE → overlay hop + underlay sub-path to tunnel dst / VTEP IP (default VRF). MPLS L3VPN: BGP next hop = remote PE, underlay via IGP/LSP.
7. VRF leaking via route-targets: follow the imported route's originating VRF.
8. Stop when dst is connected/local on the current device → endpoint port via ARP/MAC. Loop guard: visited (device,vrf) + TTL 64.
9. Always compute the reverse path and diff → asymmetry warning (stateful firewalls).
10. What-if: mark link/device down → recompute from snapshot (note: approximates reconvergence).
Output: hops[{device, in_if, vrf, matched(prefix,proto,ad,metric), decision(lpm|pbr|nat|default|connected), out_if, next_hop, l2_path[], fw_verdict, nat}], branches[], warnings[], verify{traceroute_hops, match%}.
Live mode uses the per-vendor live-path helpers above (cef exact-route, routing hash, test fib-lookup / security-policy-match, packet-tracer, match-policies, routing-table details).

## UI (React / xyflow)
- Collection plan preview per device before run: vendor/os/role/caps, each command with the gate that enabled it, parser, tables fed; skipped commands with reason.
- Run view: per-command status/duration/rows; failures link to raw.
- Topology: toggles for LAG/stack collapse, VRF/VLAN filter, overlay/underlay layer, confidence-styled links, placeholders for unmanaged.
- Path panel: hop table + canvas highlight, ECMP branches, fw verdicts, reverse-path diff, warnings; export JSON/CSV/markdown.

## Non-negotiables
- Read-only allowlist enforced in the collector: commands must match `^(show|get|display|dis |diagnose|execute (traceroute|ping)|test |ping|traceroute|/.* print)` and never contain config/write/commit/reload/reboot/factoryreset/delete/clear. Reject anything else, including catalog entries.
- Credentials in OS keychain (tauri-plugin-stronghold or keyring crate), never plaintext in SQLite. Scrub secrets from stored configs before persisting (enable secret, username secret, snmp community, PSKs, key-strings, set password/psksecret, tunnel-group keys).
- Every command optional; paging disabled per OS; per-command timeout; concurrency limits.
- Parsers fixture-tested from real captures. Mark each catalog entry verified: lab|docs|unverified — never invent a command; ask me for captures where unsure and list exactly which commands you need captured per platform.
- No cloud, no telemetry.

## Phases (propose plan → my approval → implement → tests + build → short report → next)
P1 Catalog YAML + fingerprint + caps gating + collector (SSH + API) + parsers + tables + offline import + collection plan preview. Accept: fixture tests pass per vendor; lab run populates all tables.
P2 Topology builder + reconciliation + UI. Accept: lab topology reproduced; LAG/stack collapse; inferred links flagged with evidence.
P3 Path builder (modeled/live/verify) + fw/NAT/PBR awareness + reverse path + ECMP. Accept: modeled path matches traceroute on lab; verdicts correct.
P4 Run diff, SNMP fallback, hosts/hypervisors, exports, scheduled re-discovery.

---

# P1 plan — proposed 2026-09-29, approved the same day

**Approved with four instructions** (roadmap LT-508–LT-511), which replaced
the plan's "captures needed" section with the derived list below. What has
shipped since is in `docs/ROADMAP.md` under Done; D-060 records how three
lines of the decision were read (the allowlist as verbs, `bundle.resources`
rather than `externalBin`, genie left out until a named gap).

## Two things the architecture decision runs into, said first

1. **`externalBin` takes one file per target; the embeddable CPython is a folder.** Tauri's `bundle.externalBin` renames and installs single executables. A CPython layout (`python.exe`, `python3xx.zip`, `python3xx.dll`, `Lib/site-packages/`, the sidecar package) is a directory, so it ships as `bundle.resources` — installed under the app's resource directory, spawned from there by absolute path, never from `%TEMP%`, which is what the trust rule asks for. Same intent as the decision, one Tauri key different.
2. **genie is not needed for anything in P1's scope, and it is the size problem.** Every P1 command either has an ntc-templates template, is native structured output, or is a table simple enough to template from a capture (the mapping is below). pyATS+genie adds roughly 400 MB and a Cisco EULA to the bundle for parsers nothing in P1 calls. Proposed: **scrapli + ntc-templates in P1; genie only if a specific gap appears that a template cannot close**, added then with the reason recorded. The catalog keeps `parser: genie:<name>` in its grammar so nothing has to change if it is.

Also: this development machine has Python 3.14 and no `pip`; the sidecar's pinned environment needs `python3-venv` (or a 3.12 build, since scrapli's wheels lag the newest interpreter). That is a prerequisite I will name in the report, not a blocker.

## Layout

```
sidecar/                              Python bridge (Phase 1–3), Apache-2.0/MIT deps only
  coreview_sidecar/
    __main__.py                        JSON-lines loop over stdio; one session per device
    protocol.py                        request/response dataclasses; schema below
    session.py                         scrapli driver per OS; prep/prompt/enable from the catalog `session:` block
    parse.py                           textfsm:<name> → ntc-templates; json/xml pass-through
    allowlist.py                       the read-only regex, enforced again here (defence in depth)
  requirements.txt                     pinned, --require-hashes
  tests/                               pytest: parse fixtures (raw → rows), allowlist, protocol
  build/windows.ps1                    embeddable CPython + site-packages → src-tauri/sidecar/ (resources)
  build/linux.sh                       venv under src-tauri/sidecar/ for the AppImage/.deb
crates/coreview-catalog/               YAML catalog: loader, schema check, gate evaluator, plan builder, allowlist
  src/{schema,gate,plan,allowlist,session}.rs
  tests/catalog_is_well_formed.rs      every resources/catalog/*.yaml loads, every command passes the allowlist
crates/coreview-collect/               the collector: fingerprint → caps → plan → run → rows
  src/{sidecar,run,api/fortios,api/panos,api/aoscx,fingerprint,capabilities,scrub}.rs
  (coreview-meraki stays as it is and is called from here)
crates/coreview-discover/              unchanged in P1; the existing crawl keeps working behind `collector = legacy`
resources/catalog/                     cisco_ios.yaml cisco_nxos.yaml cisco_iosxr.yaml arista_eos.yaml juniper_junos.yaml
                                       fortios.yaml panos.yaml aoscx.yaml aoss.yaml cisco_asa.yaml cisco_wlc_aireos.yaml
                                       meraki.yaml + stubs (huawei_vrp, hp_comware, mikrotik_routeros, dell_os10, extreme_exos, ruckus_icx, ubiquiti_edgeos)
resources/catalog/schema.json          the YAML's shape; checked in cargo test
resources/templates/                   Phase 2 (vendored ntc-templates + LICENSE + NOTICE); empty in P1
src-tauri/src/tables.rs                schema 6: the 22 discovery tables + collection_run + command_log; migration
src-tauri/src/collect_commands.rs      IPC: plan_collection, start_collection, import_captures, collection_run, command_raw
src/lib/collection.ts                  page types for plan/run/rows
src/components/CollectionPlan.tsx      the plan preview; CollectionRun.tsx the run view (per-command status, rows, raw link)
e2e/collection.mjs                     plan preview and run view against a stubbed backend
```

Flag: `settings.collector = legacy | sidecar` (project setting). Legacy stays the default until P1 acceptance passes on the lab; then sidecar. The existing crawl, review and topology are untouched by P1.

## Sidecar contract — JSON-lines over stdio

One JSON object per line, both ways. Rust writes requests; the sidecar writes exactly one response per request `id`, plus `event` lines. Secrets travel on stdin only — never argv, never the environment, never a file.

Requests:
```json
{"op":"open","session":"s1","host":"192.0.2.10","port":22,"os":"cisco_ios",
 "auth":{"username":"reader","password":"…","enable":"…"},
 "session_spec":{"prep":["terminal length 0","terminal width 511"],"prompt_regex":"[\\w.-]+[#>]\\s*$","enable":true},
 "timeouts":{"connect_ms":8000,"auth_ms":20000}}
{"op":"run","session":"s1","id":"cmd-17","cmd":"show ip route","parser":"textfsm:cisco_ios_show_ip_route","timeout_ms":30000}
{"op":"run","session":"s1","id":"cmd-18","cmd":"show ip route vrf CUST-A","parser":"textfsm:cisco_ios_show_ip_route","timeout_ms":30000,"context":{"vrf":"CUST-A"}}
{"op":"switch","session":"s1","id":"ctx-2","context":{"kind":"vdom","name":"root"}}      // FortiOS/ASA/PAN-OS context change, from the catalog's session block
{"op":"parse","id":"off-3","os":"cisco_ios","cmd":"show ip arp","parser":"textfsm:cisco_ios_show_ip_arp","raw":"…"}   // offline import: parse only, no SSH
{"op":"close","session":"s1"}
```
Responses:
```json
{"id":"cmd-17","session":"s1","device":"192.0.2.10","cmd":"show ip route","status":"ok",
 "rows":[{"protocol":"S","prefix":"0.0.0.0","mask":"0","nexthop_ip":"192.0.2.1","distance":"1","metric":"0"}],
 "raw":"S*    0.0.0.0/0 [1/0] via 192.0.2.1\n…","duration_ms":812,"error":null}
{"id":"cmd-19","status":"unsupported","rows":[],"raw":"% Invalid input detected at '^' marker.","duration_ms":41,"error":"rejected by device"}
{"id":"cmd-20","status":"parse_error","rows":[],"raw":"…","duration_ms":900,"error":"textfsm: cisco_ios_show_foo: state error at line 12"}
{"event":"log","level":"info","session":"s1","msg":"authenticated"}
```
`status ∈ ok | unsupported | timeout | auth | parse_error | refused` (refused = failed the sidecar's own allowlist; Rust has already refused it before sending, so this is the audit trail, not the gate). **`raw` comes back inline and Rust writes it**: redacted with the run's secrets (the support-capture path, LT-481), under the run's diagnostic folder, and `raw_ref` in `command_log` points at that file. The sidecar never writes to disk, so D-055 and the backup-folder rule hold in one place, and `show running-config` is scrubbed by Rust before it is kept anywhere.

## Catalog → parser mapping (P1 platforms)

Read against ntc-templates' index on 2026-09-29. **native** = the OS's own structured output, used first; **ntc** = an existing template by that name; **new** = a TextFSM template to write from a lab capture (verified: lab) or from documentation (verified: docs, marked); **raw** = kept, not parsed (configs, scrubbed).

**cisco_ios** — ntc: `show version` `show inventory` `show ip interface brief` `show interfaces` `show interfaces description` `show ip arp` `show cdp neighbors detail` `show lldp neighbors detail` `show module` `show redundancy` `show switch virtual` `show interfaces status` `show interfaces switchport` `show vlan` `show vtp status` `show spanning-tree` `show spanning-tree root` `show mac address-table` (both spellings, one template) `show etherchannel summary` `show ip dhcp snooping binding` `show ip route summary` `show ip route` (and `vrf X`, `{dst}`) `show ipv6 route` `show ipv6 interface brief` `show ipv6 neighbors` `show route-map` `show vrf` `show ip ospf neighbor` `show ip ospf interface brief` `show ip eigrp neighbors` `show ip bgp summary` `show isis neighbors` `show standby brief` `show vrrp brief` `show crypto session detail` `show crypto ipsec sa` `show dmvpn` `show ip nat translations` `show mpls interfaces` `show ap summary` `show ap cdp neighbors` `show ip cef` `traceroute`. **new**: `show switch` (ntc has only `show switch detail`), `show stackwise-virtual`, `show interfaces trunk`, `show device-tracking database` (ntc has `show ip device tracking all`), `show ip policy`, `show ip vrf` (legacy), `show bgp all summary` (use ntc's `show ip bgp summary` where the platform answers it), `show ip bgp vpnv4 all summary`, `show glbp brief`, `show crypto session brief`, `show ip nat statistics`, `show mpls ldp neighbor brief`, `show mpls forwarding-table`, `show ap lldp neighbors` (unverified command), `show wlan summary`, `show wireless client summary`, `show wireless mobility summary`, `show ip cef exact-route`. **raw**: `show running-config`.

**cisco_nxos** — native `| json` for everything the platform answers with it (it answers for all of the catalog's `show` commands on 7.x/9.x); ntc as fallback for: version inventory module hostname interface `interface brief` `interface description` `ip interface brief` (vrf all) `ip arp` (vrf all) cdp/lldp detail `interface status` `interface switchport` vlan `mac address-table` `port-channel summary` vpc fex vrf `ip route` route-map `ip ospf neighbor` `ip eigrp neighbors` `ip bgp summary` `hsrp all` `nve peers` `nve vni` feature. **new** (fallback only): `interface trunk` `spanning-tree` `vpc consistency-parameters global` `fex detail` `ipv6 route` `ipv6 neighbor` `isis adjacency` `bgp sessions` `hsrp brief` vrrp `bgp l2vpn evpn summary` `l2route evpn mac all` mpls `routing hash`.

**cisco_iosxr** — ntc: version inventory platform interfaces `interfaces description` `ipv4 interface brief` `ipv6 neighbors` arp lldp/cdp detail `vrf all detail` `route` `ospf vrf all neighbor` `isis neighbors` `bgp summary` `bgp vrf all summary` hsrp `mpls ldp neighbor brief`. **new**: `ipv6 interface brief` bundle lacp `route static` `route ipv6 unicast` `bgp vpnv4 unicast summary` `vrrp brief` `mpls interfaces` `mpls forwarding` `l2vpn bridge-domain brief` `l2vpn xconnect` `evpn evi` `cef`. No IOS-XR in the lab: **verified: docs** until a capture exists.

**arista_eos** — native `| json` for everything (eAPI when enabled); ntc fallback exists for version inventory hostname interfaces `interfaces status` `interfaces description` `ip interface brief` `ip arp` `lldp neighbors detail` `port-channel summary` `mac address-table` vlan vrf `ip route` `ip ospf neighbor` `ip bgp summary` `isis neighbors` mlag. Native covers the rest (switchport, trunk, spanning-tree, lacp, mlag interfaces, ipv6, pbr, vrrp, virtual-router, vxlan, evpn).

**juniper_junos** — native `| display xml` for everything; ntc exists for version `chassis hardware` interfaces `arp no-resolve` `lldp neighbors` `lacp interfaces` `ethernet-switching table` `ethernet-switching interfaces` vlans `chassis cluster status` `ospf neighbor` `isis adjacency` `bgp summary` `route summary`. XML is the parser of record; templates are the shadow-mode comparison.

**fortios** — REST (`/api/v2/monitor`, `/cmdb`) is the parser of record when a token is given, Rust-side. CLI: ntc for `get system status` `get system ha status` `get system interface physical` `get system interface` (config form) `get system arp` `get router info routing-table all` `get router info bgp summary` `get router info bgp neighbors` `get router info ospf status` `execute dhcp lease-list` `execute traceroute` `diagnose lldprx neighbor details`. **new**: `get system performance status` `diagnose ip address list` `diagnose ip route list` `diagnose lldprx neighbors summary` `diagnose sys vd list` `show system zone` `get router info routing-table database` `get router info kernel` `show router static` `show router policy` `diagnose firewall proute list` `get router info ospf neighbor` `show firewall policy` `show firewall address` `show firewall addrgrp` `show firewall vip` `show firewall ippool` `get vpn ipsec tunnel summary` `diagnose vpn tunnel list` `show vpn ipsec phase1-interface` `show vpn ipsec phase2-interface` `show system sdwan` `diagnose sys sdwan *` `execute switch-controller get-conn-status` — the `show …` ones are config blocks and get one shared block parser, not a template each. Coreview's own FortiOS readers (verified on the bench FortiGate and FortiSwitch) cover several of these already and become the Rust side of shadow mode.

**panos** — XML API (`type=op`) is the parser of record, Rust-side; CLI ntc for `show system info` `show high-availability all` `show interface all` `show interface logical` `show lacp aggregate-ethernet all` `show lldp neighbors all` `show arp all` `show mac all` `show routing route` `show routing protocol bgp summary` `show running security-policy` `show running nat-policy` `test security-policy-match`. **new** (CLI fallback only): `show vlan all` `show routing interface` `show routing fib` `show routing protocol ospf neighbor` `show routing protocol bgp peer` `show pbf rule all` `show vpn ike-sa` `show vpn ipsec-sa` `show vpn tunnel` `show vpn flow` `show advanced-routing *` (unverified) `test routing fib-lookup` `test pbf-policy-match` `test nat-policy-match`. No PAN-OS in the lab: **verified: docs**.

**aoscx** — REST v10.x is the parser of record, Rust-side; CLI ntc for `show system` `show interface` `show mac-address-table` `show arp all-vrfs` `show ip route all-vrfs` `show lldp neighbor-info detail` `show vsf detail` `show vlan` `show vrf` `show module` `show bgp all-vrfs all summary`. **new**: `show hostname` `show interface brief` `show ip interface brief` `show ipv6 neighbors all-vrfs` `show lldp neighbor-info` `show vsx status` `show vsx brief` `show spanning-tree` `show lag brief` `show lacp interfaces` `show ipv6 route all-vrfs` `show ip ospf neighbors all-vrfs` `show vrrp brief` `show active-gateway` `show interface vxlan 1 vni` `show evpn` `show bgp l2vpn evpn summary`. The lab 6200F makes these **verified: lab** as captures arrive.

**aoss** — ntc: `show system` `show version` `show interfaces brief` `show ip` `show arp` `show lldp info remote-device` (+detail) `show cdp neighbors detail` `show ip route` `show vlans` `show trunks` `show mac-address` `show interfaces status` `show vsf detail`. **new**: `show modules` `show name` `show stacking` `show vlans ports all detail` `show lacp` `show spanning-tree` `show ip ospf neighbor` `show vrrp` `show ip bgp summary`. Coreview's ArubaOS-Switch readers (verified on the 2930M) are the Rust side.

**cisco_asa** — ntc: version inventory failover `interface ip brief` interface route nat arp `ospf neighbor` `bgp summary` `crypto ipsec sa` `vpn-sessiondb` `port-channel summary`. **new**: nameif `nat detail` `mac-address-table` `eigrp neighbors` vrf `route vrf` `show mode` `show context` `packet-tracer`. No ASA in the lab: **verified: docs**.

**cisco_wlc_aireos** — ntc: sysinfo inventory `interface summary` `cdp neighbors detail` `ap summary` `wlan summary` `mobility summary` `redundancy summary`. **new**: `ap cdp neighbors all` `client summary` `route summary` `network summary`. No AireOS in the lab: **verified: docs**. (The 9800 is `cisco_ios` with `role.wlc`; Coreview's AP-table reader exists for both.)

**meraki** — Rust, already (LT-404, D-056/D-057); P1 adds the endpoints the spec lists that it does not call yet (`topology/linkLayer`, `lldpCdp`, switch ports/statuses/stacks, routing interfaces/static routes, appliance vlans/static routes/uplink/firewall/vpn, ssids, clients) and feeds the tables.

**Phase-2 stubs (YAML only in P1):** huawei_vrp, hp_comware, mikrotik_routeros, extreme_exos, ruckus_icx, ubiquiti_edgeos have ntc templates for most of their listed commands; dell_os10 has none. Coreview's own readers for Comware, Huawei, RouterOS and EdgeOS/VyOS (documentation-built, D-058) are the Rust side for shadow mode.

## Captures — the one list (LT-511), after LT-508–510

The operator's instruction on approving the plan: use ntc-templates' index
and tests, scrapli's and netmiko's drivers, and ask once for what has
neither a template nor native structured output. `docs/DISCOVERY-RECONCILIATION.md`
(generated by `scripts/reconcile-ntc.mjs`) is the full table — every spec
command → matched template | native output | none — and the list below is
its `none` rows for the platforms in the lab, minus the live-path
lookups, which are Phase 3. Each is `verified: unverified` in its catalog
until a capture arrives; a command the device refuses is recorded as
unsupported, which is itself an answer.

- **Catalyst 2960CX** (`cisco_ios`; the 9300 for `show device-tracking database` and `show stackwise-virtual`, a 9800 for the four wireless ones): `show ip protocols` · `show ip policy` · `show ip vrf` · `show ip protocols vrf <vrf>` · `show ip eigrp vrf <vrf> neighbors` · `show bgp all summary` · `show glbp brief` · `show crypto session brief` · `show crypto ipsec sa` · `show ip nat statistics` · `show mpls ldp neighbor brief` · `show mpls forwarding-table` · `show ap lldp neighbors` · `show wlan summary` · `show wireless client summary` · `show wireless mobility summary`
- **FortiGate 60F** (`fortios`): `get system performance status` · `diagnose ip address list` · `diagnose ip route list` · `get router info routing-table database` · `get router info kernel` · `diagnose firewall proute list` · `diagnose sys sdwan service` (and `show system virtual-wan-link` only on a 6.x unit)
- **Aruba CX 6200F** (`aoscx`): `show spanning-tree` · `show lacp interfaces` · `show ip ospf neighbors all-vrfs` · `show bgp ipv4 unicast summary all-vrfs` · `show vrrp brief` · `show active-gateway` · `show evpn` · `show bgp l2vpn evpn summary`
- **ArubaOS-Switch 2930M** (`aoss`): `show modules` · `show name` · `show stacking` · `show lacp` · `show spanning-tree` · `show vrrp`
- **Nexus 9000** (`cisco_nxos`): nothing — every command is `| json` with a template as the shadow.

Not in the lab, so they stay `verified: unverified` on documentation alone:
IOS-XR (`show ipv6 interface brief`, `show bundle`, `show lacp`, `show vrf
all`, `show vrrp brief`, the mpls, l2vpn and evpn ones), ASA/FTD (`show
mode`, `show nameif`, `show mac-address-table`, `show eigrp neighbors`,
`show vrf`, `show network`, `show managers`), AireOS (`show ap cdp
neighbors all`, `show client summary`, `show route summary`, `show network
summary`). EOS, Junos and PAN-OS have structured output for everything.

## Test strategy

- **Catalog:** `catalog_is_well_formed` loads every YAML against `schema.json`, and every command in every catalog passes the read-only allowlist (a catalog entry that could change a device fails `cargo test`). Gate evaluator: unit tests over `always`, `&&`, `!`, unknown flag = false. Plan builder: given (os, caps, role) → commands in weight order with skip reasons; one test per platform from the catalog.
- **Sidecar:** pytest — allowlist (both accepted and refused forms, including catalog entries), protocol round-trip, and **parse fixtures**: `sidecar/tests/fixtures/<os>/<command>.raw` + `.yml` (the ntc-templates fixture format), one per catalog command, from lab captures where they exist and from the ntc fixture set otherwise. These fixtures are the same files Phase 2's Rust engine must pass.
- **Rust rows → tables:** fixture JSONL from the sidecar (recorded, checked in) fed to the table loaders; every table gets a test that a row lands with its run_id, device_id and collected_at; secret scrubbing tested on a config carrying every secret kind the spec lists.
- **Fake devices:** the existing fake SSH network gains a `sidecar` mode where the sidecar connects to the fakes, so the whole pipeline runs in `cargo test` with no lab.
- **Offline import:** `captures/<host>/<command>.txt` through the identical pipeline via `op: parse`; the lab captures above become that test's input, and replay-after-parser-fix is the same test rerun.
- **Page:** `e2e/collection.mjs` — the plan preview shows each command with its gate, parser and tables and each skip with its reason; the run view shows per-command status/duration/rows and links a failure to its raw file.
- **Conformance harness (Phase 2, planned now so P1 fixtures feed it):** `resources/templates/tests/<platform>/<command>/*.raw` vs `*.yml` iterated by one `cargo test`, reporting pass/fail per template, gated at 100%. Candidate crates found on crates.io: `textfsm-rs` 0.3.6, `textfsm-rust`/`textfsm-core` 0.3.1 — to be run against that harness before deciding whether to build on one or write our own.

## Acceptance for P1 (the spec's, made concrete)

Fixture tests pass for every P1 platform; a lab run with `collector = sidecar` over the FortiGate, FortiSwitch, Nexus, Catalyst, CX 6200F and 2930M populates device, interface, ip_address, neighbor, mac_table, arp, vlan, lag, stp, vrf, route, routing_neighbor, fhrp, policy_route, fw_zone, fw_policy, nat_rule (FortiGate), tunnel (if any), ha_pair (stack/FortiLink), endpoint, collection_run and command_log; the plan preview is shown before the run; offline import of the same captures produces the same rows; nothing that could change a device is ever sent (tested on both sides).

---

# P2 plan — topology builder, proposed 2026-09-29, awaiting approval

Nothing below is built. The spec's P2: "Topology builder + reconciliation +
UI. Accept: lab topology reproduced; LAG/stack collapse; inferred links
flagged with evidence." It reads the discovery tables a P1 collection
fills (schema 6/7) and writes `link` and `l3_adjacency`, which the spec
lists and P1 left empty.

## The one decision to make first

Coreview already draws a topology: the crawl's `CrawlResult` goes through
`src/lib/topology.ts` (`buildTopology`, identity by name/address/MAC,
stacks, LAG labels) into the review screen and "add to diagram". P2 can
either

- **(recommended) build the graph in Rust from the tables**
  (`crates/coreview-topology`, pure, tested with cargo) — matching,
  confidence, evidence, LAG/stack/pair collapse, inferred links — write it
  to `d_link` / `d_l3_adjacency`, and hand the page a `CrawlResult`-shaped
  view of it, so the existing review screen, drawing, layout and diffing
  are reused and there is one drawing path; or
- extend `topology.ts` to read the new tables directly, which keeps the
  logic on the page but duplicates identity rules the Rust side needs
  anyway for the P3 path builder.

The first keeps the path builder (P3) and the topology on the same graph
in Rust; the second is less code now and more later.

## Layout

```
crates/coreview-topology/          pure: tables in, graph out; no SQLite, no Tauri
  src/ifname.rs                    interface normalisation: Gi1/0/1 ↔ GigabitEthernet1/0/1,
                                   NX-OS Eth1/1, EOS Et1, Junos ge-0/0/0(.0), AOS-S A1 / 1/A1,
                                   FortiOS port1/x1, PAN ethernet1/1; LLDP port-id as name, MAC or ifIndex
  src/identity.rs                  one device per serial / base MAC, never per IP; the
                                   neighbour-to-device match order: chassis-id ∈ MACs →
                                   mgmt IP ∈ addresses → normalised sysname; else placeholder
  src/links.rs                     bidirectional merge; confidence 1.0 / 0.7 / 0.6 / 0.4;
                                   evidence rows (which table, which command, which run)
  src/collapse.rs                  LAG → one logical link with members (mismatch flagged);
                                   stack / VSS / SVL / VC → one node; vPC / MLAG / VSX → two
                                   nodes, a peer-link and a pair marker; dual-homed LAGs to both
  src/inferred.rs                  MAC-table edges for devices without LLDP/CDP (ASA/FTD,
                                   unmanaged); many MACs on one edge port → "unknown switch";
                                   one MAC on an access port → endpoint leaf
  src/l3.rs                        shared subnets (not /32, not management) confirmed by
                                   routing neighbours; FHRP VIP ownership
  src/overlay.rs                   VXLAN VTEP peers and IPsec/GRE/DMVPN as overlay edges with
                                   their underlay
  tests/                           scenarios built from the vendored ntc fixtures' rows
src-tauri/src/topology_cmd.rs      build for a run, write d_link / d_l3_adjacency, return the view
src/components/…                   the review screen fed from a collection run; toggles:
                                   LAG/stack collapse, VRF/VLAN filter, overlay layer,
                                   confidence styling, placeholders
e2e/topology.mjs                   the toggles and the evidence drawer, stubbed backend
```

## Tests

- Unit: every normalisation pair above, both directions; each identity
  rule, including two devices sharing an IP and one device answering on
  three.
- Scenario: small networks assembled from the vendored fixtures' real
  rows (a 2960 stack, a Nexus vPC pair, a FortiGate with FortiLink, an
  ASA seen only through a switch's MAC table), each with the expected
  graph written out by hand.
- Offline: `import_captures` over the operator's captured folder, then
  the builder — the "lab topology reproduced" check, repeatable without
  the lab.
- Page: `e2e/topology.mjs`.

## Acceptance, made concrete

A collection over the lab (or its captures imported) draws every device
once whatever address it was reached on; every CDP/LLDP adjacency as one
link with both ports; the 2960 stack as one node with its members; a
LAG as one link listing its members; the ASA or any device without
LLDP placed by MAC evidence and drawn as inferred (dashed, 0.6) with the
evidence one click away; nothing inferred drawn as if it were seen.

---

# P3 plan — 2026-09-29, built on the operator's "start and finish it"

Roadmap LT-531 (modeled), LT-532 (PBR, NAT, firewall), LT-533 (reverse
path, what-if), LT-534 (verify), LT-535 (live), LT-536 (the panel). Built
the same day; D-061 records the assumptions it makes, and LT-538 holds the
parts of steps 6–7 it did not build (route-target leaking, MPLS L3VPN)
with IPv6 and live checks inside a VDOM or vsys.

## Where it sits

Path-Trace already traces over a crawl's routing tables on the page
(`src/lib/pathTrace.ts`, LT-346–348, LT-477–480), takes a traceroute from
the source device and asks a device which ECMP leg it hashes a flow onto.
It reads routes only: it cannot see a policy route, a firewall policy, an
FHRP address, an ARP entry or a MAC table. P2 was built in Rust so that P3
could walk the same graph with every table the collection filled, so:

```
crates/coreview-path/              pure: the tables and the graph in, a path out
  src/model.rs                     a device's forwarding state from its rows: addresses,
                                   routes merged per (vrf, prefix) with every next hop,
                                   ARP, MAC tables, FHRP, STP-blocked ports, zones,
                                   policy routes, NAT rules, firewall policies, tunnels
  src/walk.rs                      the spec's steps 1–8: locate the source, PBR then LPM,
                                   ECMP branches, recursive next hops (depth 3), next hop
                                   to device, L2 between routers, tunnels, loop guard
  src/firewall.rs                  the vendor pipelines of step 3 and the verdict
  src/compare.rs                   the reverse path and its differences; verify against
                                   a traceroute; the live answers against the model
  src/export.rs                    JSON, CSV and markdown
crates/coreview-collect/src/live.rs  a device's live_path commands through the sidecar,
                                   placeholders filled from the trace, the guard unchanged
src-tauri/src/collection.rs        collection_path (modeled + reverse + verify) and
                                   collection_live (live), over a stored collection run
src/components/PathTracePanel.tsx  the Rust result when the run came from a collection
```

## Rules it keeps

- **D-050:** a path is calculated from evidence or not calculated. A
  missing table stops the walk with the reason; an unresolved firewall
  object makes the verdict undetermined, naming it; an address nobody
  collected is an unmanaged hop.
- **What-if approximates reconvergence** and says so: only the routes the
  device held are known, so a route through a device marked down falls to
  the next-longest match the device already had.
- **Live mode** sends only catalog `live_path` commands, through the one
  guard every command passes (LT-522), with the login the operator picks
  for the run; replies are redacted before they are shown.

## Acceptance, made concrete

Scenario tests, each with the path written out by hand: a routed core with
ECMP, an endpoint behind an HSRP pair, a recursive BGP next hop, a
FortiGate with a VIP and a deny, a PAN-OS NAT rule, a PBR override, an
asymmetric return, a switch path with a blocked port, a device marked
down. "Modeled path matches traceroute on lab; verdicts correct" is the
operator's run: a collection over the lab, Build topology, then a trace
with **Compare with traceroute** — the match percentage is the answer.

---

# P4 plan — 2026-09-29, built on the operator's "start P4 without a separate plan round"

Roadmap LT-542–LT-551, in the operator's order. Before it, pulled forward
from LT-538: ASA access lists (LT-540) and an FTD's policy through its FMC
(LT-541, which needed LT-518's API plumbing) — done, with four normaliser
bugs a sweep found on the way (LT-552–LT-555).

1. **Run diff (LT-542) and overlay edges (LT-543).** `coreview-topology`
   gains `diff`: two runs' P2 graphs compared with devices matched by serial,
   then MAC, then name — never by the address a run reached them on — giving
   new and lost devices, links (with how each was seen), CDP/LLDP neighbours,
   routing neighbours, routes (new, lost, next hop changed) and overlays.
   `collection_diff` answers the Collect tab's "compare with an earlier run";
   its rows share the page's existing diff row shape, so the Markdown and CSV
   writers apply. Overlays reach the diagram: the crawl result gains
   `tunnels` (filled from P2's overlays, and from a crawl's own VXLAN peers),
   and the diagram draws a dotted overlay edge on the Logical view between the
   two ends, labelled with its kind and name.
2. **The rest of LT-538.** Route-target VRF leaking (LT-544): an imported
   route is followed into the VRF that exports it, from the `vrf` table's
   route-targets. MPLS L3VPN (LT-545): a BGP next hop that is a remote PE,
   reached over the IGP, as an overlay hop with its underlay. IPv6 (LT-546):
   the model and walk take IPv6 prefixes and addresses. Live checks inside a
   VDOM, context or vsys (LT-547): the session enters the hop's context first.
3. **Exports (LT-548)**: the P2 topology (devices, links with evidence,
   overlays, findings) and the run diff as JSON, CSV and Markdown from the
   Collect tab; the path already exports (LT-536).
4. **SNMP fallback (LT-549)**: for a device whose SSH session could not be
   opened, LLDP-MIB, CDP-MIB, Q-BRIDGE, IP-FORWARD and ENTITY walked with the
   SNMP code Coreview already has, into the same tables.
5. **Hosts and hypervisors (LT-550)**: catalogs for Linux/Proxmox, ESXi and
   Windows, read-only.
6. **Scheduled re-discovery (LT-551) — not built.** It conflicts with D-023,
   which declines scheduled re-crawl "now or in the future"; D-030 proposes
   constraints only for scheduled validation sessions and is not accepted.
   It waits on the operator's ruling.
