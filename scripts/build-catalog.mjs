#!/usr/bin/env node
/**
 * The first cut of `resources/catalog/<os>.yaml`, built once from
 * three sources and then maintained by hand:
 *
 *   docs/DISCOVERY-RECONCILIATION.json   every spec command, its template,
 *                                        native output and verification
 *   resources/catalog/sessions.json      prompts, privilege levels, on-open
 *                                        steps and failure strings, read
 *                                        from the scrapli drivers by
 *                                        scripts/extract-sessions.py
 *   this file                            what neither source carries: the
 *                                        tables each command feeds, its
 *                                        weight, the capability flags a
 *                                        probe sets, the context switching
 *                                        netmiko encodes (VDOM, ASA
 *                                        context, vsys), each with its
 *                                        source named
 *
 *   node scripts/build-catalog.mjs [--force]
 *
 * Without --force it refuses to overwrite a catalog that already exists,
 * because the YAML is the source of truth once it is checked in.
 * `catalog.test.ts` keeps every catalog honest against the ntc index and
 * the allowlist; this script is for rebuilding from scratch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const rows = JSON.parse(readFileSync(join(root, 'docs/DISCOVERY-RECONCILIATION.json'), 'utf8'));
const sessions = JSON.parse(readFileSync(join(root, 'resources/catalog/sessions.json'), 'utf8'));
const outDir = join(root, 'resources/catalog');
mkdirSync(outDir, { recursive: true });

// ----------------------------------------------------------------- platforms

/**
 * Per-OS facts from the spec's catalog headers: vendor, fingerprint, role
 * hints, the capability probes and the flags each sets. Regexes are
 * multiline; a flag is set when any of its probes' output matches.
 */
const OS = {
  cisco_ios: {
    vendor: 'Cisco', name: 'IOS / IOS-XE', ntc: 'cisco_ios',
    fingerprint: { probe: 'show version', match: 'Cisco IOS(-| )XE Software|Cisco IOS Software' },
    role_hint: [
      { match: 'C9[2-6]\\d\\d|C3[5678]50|C2960|WS-C|C4[59]00|C6[58]00', role: 'switch' },
      { match: 'ISR|ASR1|CSR1|C8[0-5]00', role: 'router' },
      { match: 'C9800', role: 'wlc' },
    ],
    caps: {
      'show ip protocols': { ospf: '^Routing Protocol is "ospf', eigrp: '^Routing Protocol is "eigrp', bgp: '^Routing Protocol is "bgp', isis: '^Routing Protocol is "isis', rip: '^Routing Protocol is "rip', routing: '^Routing Protocol is "' },
      'show run | include ^ip routing|^router |^ip route |^vrf definition|^ip vrf |^interface Tunnel|^ip nat |^crypto |^ip policy|^mpls |^interface Port-channel|^ standby|^ vrrp|^ glbp': {
        routing: '^ip routing|^router |^ip route ', ospf: '^router ospf', eigrp: '^router eigrp', bgp: '^router bgp', isis: '^router isis', rip: '^router rip',
        vrf: '^vrf definition|^ip vrf ', gre: '^interface Tunnel', nat: '^ip nat ', ipsec: '^crypto ', pbr: '^ip policy', mpls: '^mpls ',
        switching: '^interface Port-channel', fhrp: '^ standby|^ vrrp|^ glbp', dmvpn: '^interface Tunnel',
      },
    },
    defaults: { switch: ['switching', 'cdp', 'lldp', 'stack'], router: ['routing', 'cdp', 'lldp'], wlc: ['wlc', 'cdp', 'lldp'] },
  },
  cisco_nxos: {
    vendor: 'Cisco', name: 'NX-OS', ntc: 'cisco_nxos', structured: 'json_pipe',
    fingerprint: { probe: 'show version', match: 'Cisco Nexus Operating System|NX-OS' },
    role_hint: [{ match: 'Nexus|N[3579]K|N9K', role: 'switch' }],
    caps: {
      'show feature': {
        ospf: '^ospf\\s+\\d+\\s+enabled', eigrp: '^eigrp\\s+\\d+\\s+enabled', bgp: '^bgp\\s+\\d+\\s+enabled', isis: '^isis\\s+\\d+\\s+enabled',
        vpc_mlag_vsx: '^vpc\\s+\\d+\\s+enabled', vpc: '^vpc\\s+\\d+\\s+enabled', switching: '^lacp\\s+\\d+\\s+enabled|^interface-vlan\\s+\\d+\\s+enabled',
        fhrp: '^hsrp_engine\\s+\\d+\\s+enabled|^vrrp\\s+\\d+\\s+enabled', lldp: '^lldp\\s+\\d+\\s+enabled', fex: '^fex\\s+\\d+\\s+enabled',
        vxlan_evpn: '^nv overlay\\s+\\d+\\s+enabled|^vn-segment-vlan-based\\s+\\d+\\s+enabled', mpls: '^mpls\\S*\\s+\\d+\\s+enabled', routing: '^(ospf|eigrp|bgp|isis|rip)\\s+\\d+\\s+enabled',
      },
      'show run | include ^ip route |^route-map|^interface Tunnel|^ip policy|^vrf context': { routing: '^ip route ', pbr: '^ip policy|^route-map', gre: '^interface Tunnel', vrf: '^vrf context (?!management)' },
    },
    defaults: { switch: ['switching', 'cdp', 'lldp', 'structured_output'] },
  },
  cisco_iosxr: {
    vendor: 'Cisco', name: 'IOS XR', ntc: 'cisco_xr',
    fingerprint: { probe: 'show version', match: 'Cisco IOS XR Software' },
    role_hint: [{ match: 'ASR9|NCS|CRS|XRv', role: 'router' }],
    caps: {
      'show run | include ^router |^route-policy|^vrf |^interface tunnel|^mpls|^l2vpn|^evpn': {
        routing: '^router ', ospf: '^router ospf', bgp: '^router bgp', isis: '^router isis', pbr: '^route-policy', vrf: '^vrf ', gre: '^interface tunnel', mpls: '^mpls', l2vpn: '^l2vpn|^evpn', vxlan_evpn: '^evpn',
      },
    },
    defaults: { router: ['routing', 'lldp', 'cdp'] },
  },
  arista_eos: {
    vendor: 'Arista', name: 'EOS', ntc: 'arista_eos', structured: 'json_pipe',
    fingerprint: { probe: 'show version', match: 'Arista' },
    role_hint: [{ match: 'DCS-7|CCS-7|vEOS', role: 'switch' }],
    caps: {
      'show running-config | include ^router |^ip routing|^vrf instance|^ip virtual-router|^vrrp|^interface Vxlan|^mlag|^policy-map type pbr|^interface Tunnel|^ip route': {
        routing: '^router |^ip routing|^ip route', ospf: '^router ospf', bgp: '^router bgp', isis: '^router isis', vrf: '^vrf instance', fhrp: '^ip virtual-router|^vrrp',
        vxlan_evpn: '^interface Vxlan', vpc_mlag_vsx: '^mlag', pbr: '^policy-map type pbr', gre: '^interface Tunnel',
      },
    },
    defaults: { switch: ['switching', 'lldp', 'structured_output'] },
  },
  juniper_junos: {
    vendor: 'Juniper', name: 'Junos', ntc: 'juniper_junos', structured: 'xml_pipe',
    fingerprint: { probe: 'show version', match: 'JUNOS|Junos' },
    role_hint: [{ match: '\\bEX\\d|\\bQFX', role: 'switch' }, { match: '\\bMX\\d|\\bACX|\\bPTX', role: 'router' }, { match: '\\bSRX|vSRX', role: 'firewall' }],
    caps: {
      'show configuration protocols | display set': { ospf: '^set protocols ospf', bgp: '^set protocols bgp', isis: '^set protocols isis', rip: '^set protocols rip', mpls: '^set protocols (mpls|ldp|rsvp)', lldp: '^set protocols lldp', fhrp: 'vrrp-group', vxlan_evpn: '^set protocols evpn', routing: '^set protocols (ospf|bgp|isis|rip)' },
      'show configuration routing-instances | display set': { vrf: '^set routing-instances \\S+ instance-type (vrf|virtual-router)', vxlan_evpn: 'instance-type (evpn|mac-vrf)' },
      'show configuration firewall | display set': { pbr: 'routing-instance' },
      'show configuration security | display set': { nat: '^set security nat', ipsec: '^set security ipsec', fw_zone: '^set security zones' },
    },
    defaults: { switch: ['switching', 'lldp', 'structured_output'], router: ['routing', 'lldp', 'structured_output'], firewall: ['routing', 'lldp', 'structured_output', 'ha'] },
  },
  fortios: {
    vendor: 'Fortinet', name: 'FortiOS', ntc: 'fortinet',
    fingerprint: { probe: 'get system status', match: 'Version: Forti(Gate|Switch|Wifi)' },
    role_hint: [{ match: 'FortiGate|FortiWiFi|FGT|FWF', role: 'firewall' }, { match: 'FortiSwitch|FSW', role: 'switch' }],
    caps: {
      'get system status': { vdom: '^Virtual domain configuration: (multiple|enable|split-task)', ha: '^Current HA mode: (a-a|a-p)' },
      'show router ospf': { ospf: 'set router-id|config area', routing: 'set router-id' },
      'show router bgp': { bgp: 'set as \\d', routing: 'set as \\d' },
      'show router static': { routing: '^\\s+edit \\d+' },
      'show router policy': { pbr: '^\\s+edit \\d+' },
      'show system sdwan': { sdwan: 'set status enable' },
      'show vpn ipsec phase1-interface': { ipsec: '^\\s+edit "' },
      'show firewall vip': { nat: '^\\s+edit "' },
      'show system interface': { vrf: 'set vrf [1-9]', switching: 'set type (aggregate|hard-switch|switch)', gre: 'set type tunnel', fortilink: 'set fortilink enable' },
    },
    defaults: { firewall: ['routing', 'nat', 'lldp'], switch: ['switching', 'lldp'] },
  },
  panos: {
    vendor: 'Palo Alto Networks', name: 'PAN-OS', ntc: 'paloalto_panos', structured: 'xml_api',
    fingerprint: { probe: 'show system info', match: '^model: PA-|^sw-version:' },
    role_hint: [{ match: 'PA-|VM-', role: 'firewall' }],
    caps: {
      'show system info': { vsys: '^multi-vsys: on', advanced_routing: '^advanced-routing: on', ha: '^ha-mode|^ha-state' },
      'show config running': { ospf: '<ospf>\\s*<enable>yes', bgp: '<bgp>\\s*<enable>yes', ipsec: '<ipsec>', pbr: '<pbf>', nat: '<nat>\\s*<rules>', routing: '<virtual-router>', gre: '<tunnel>' },
    },
    defaults: { firewall: ['routing', 'nat', 'lldp', 'structured_output'] },
  },
  aoscx: {
    vendor: 'Aruba (HPE)', name: 'AOS-CX', ntc: 'aruba_aoscx',
    fingerprint: { probe: 'show version', match: 'ArubaOS-CX' },
    role_hint: [{ match: '\\b(6[0-4]\\d\\d|8[0-4]\\d\\d|10000)\\b', role: 'switch' }],
    caps: {
      'show running-config | include ^router |^vrf |^vrrp|^active-gateway|^interface vxlan|^evpn|^vsx|^vsf|^ip route |^interface lag': {
        routing: '^router |^ip route ', ospf: '^router ospf', bgp: '^router bgp', vrf: '^vrf (?!mgmt)', fhrp: '^vrrp|^active-gateway', vxlan_evpn: '^interface vxlan|^evpn',
        vpc_mlag_vsx: '^vsx', stack: '^vsf', switching: '^interface lag',
      },
    },
    defaults: { switch: ['switching', 'lldp'] },
  },
  aoss: {
    vendor: 'Aruba (HPE)', name: 'ArubaOS-Switch / ProCurve', ntc: 'hp_procurve',
    fingerprint: { probe: 'show system', match: 'Software revision|ProCurve|Aruba' },
    role_hint: [{ match: '2530|2540|2920|2930|3810|5400|J[89]\\d{3}A', role: 'switch' }],
    caps: {
      'show running-config | include ^ip routing|^router |^ip route |^vrrp|^trunk |^stacking': { routing: '^ip routing|^router |^ip route ', ospf: '^router ospf', bgp: '^router bgp', rip: '^router rip', fhrp: '^vrrp', switching: '^trunk ', stack: '^stacking' },
    },
    defaults: { switch: ['switching', 'lldp', 'cdp'] },
  },
  cisco_asa: {
    vendor: 'Cisco', name: 'ASA / FTD', ntc: 'cisco_asa',
    fingerprint: { probe: 'show version', match: 'Adaptive Security Appliance|Firepower Threat Defense' },
    role_hint: [{ match: 'ASA|FPR|Firepower', role: 'firewall' }],
    caps: {
      'show mode': { multi_context: '^Security context mode: multiple' },
      'show running-config | include ^router |^route |^nat |^crypto map|^tunnel-group|^vrf': { routing: '^router |^route ', ospf: '^router ospf', eigrp: '^router eigrp', bgp: '^router bgp', nat: '^nat ', ipsec: '^crypto map|^tunnel-group', vrf: '^vrf ' },
    },
    defaults: { firewall: ['routing', 'nat', 'ha'] },
  },
  cisco_wlc_aireos: {
    vendor: 'Cisco', name: 'AireOS WLC', ntc: 'cisco_wlc_ssh',
    fingerprint: { probe: 'show sysinfo', match: 'Cisco Controller|Product Name' },
    role_hint: [{ match: 'AIR-CT|5520|8540|3504', role: 'wlc' }],
    caps: {},
    defaults: { wlc: ['wlc', 'cdp'] },
  },
  meraki: {
    vendor: 'Cisco Meraki', name: 'Dashboard API', ntc: null, structured: 'api',
    fingerprint: null, role_hint: [], caps: {}, defaults: {},
  },
  hosts: { vendor: 'hosts', name: 'Linux, Proxmox, ESXi, Windows (phase 4)', ntc: 'linux', fingerprint: null, role_hint: [], caps: {}, defaults: {}, stub: true },
  huawei_vrp: { vendor: 'Huawei', name: 'VRP', ntc: 'huawei_vrp', fingerprint: { probe: 'display version', match: 'Huawei Versatile Routing Platform|VRP' }, role_hint: [], caps: {}, defaults: {}, stub: true },
  hpe_comware: { vendor: 'HPE', name: 'Comware', ntc: 'hp_comware', fingerprint: { probe: 'display version', match: 'Comware' }, role_hint: [], caps: {}, defaults: {}, stub: true },
  mikrotik_routeros: { vendor: 'MikroTik', name: 'RouterOS', ntc: 'mikrotik_routeros', fingerprint: { probe: '/system resource print', match: 'platform: MikroTik|RouterOS' }, role_hint: [], caps: {}, defaults: {}, stub: true },
  dell_os10: { vendor: 'Dell', name: 'OS10', ntc: 'dell_os10', fingerprint: { probe: 'show version', match: 'Dell EMC Networking OS10|OS10' }, role_hint: [], caps: {}, defaults: {}, stub: true },
  extreme_exos: { vendor: 'Extreme', name: 'EXOS', ntc: 'extreme_exos', fingerprint: { probe: 'show version', match: 'ExtremeXOS' }, role_hint: [], caps: {}, defaults: {}, stub: true },
  ruckus_icx: { vendor: 'Ruckus', name: 'ICX / FastIron', ntc: 'ruckus_fastiron', fingerprint: { probe: 'show version', match: 'ICX|FastIron' }, role_hint: [], caps: {}, defaults: {}, stub: true },
  ubiquiti_edgeos: { vendor: 'Ubiquiti', name: 'EdgeOS', ntc: 'ubiquiti_edgerouter', fingerprint: { probe: 'show version', match: 'EdgeOS|EdgeRouter' }, role_hint: [], caps: {}, defaults: {}, stub: true },
};

// ------------------------------------------------------------------ sessions

/**
 * What the scrapli drivers do not encode, from netmiko's drivers and the
 * spec, each step with its source. These are session steps: the sidecar
 * sends only the literal strings in a catalog's `session:` block, and the
 * command allowlist is not consulted for them — which is why they are the
 * only place a `config` word may appear.
 */
const SESSION_EXTRA = {
  cisco_ios: {
    paging: { off: ['terminal length 0', 'terminal width 511'], source: 'scrapli IOSXEDriver on_open; netmiko cisco_ios.py session_preparation (terminal width 511)' },
  },
  cisco_nxos: {
    paging: { off: ['terminal length 0', 'terminal width 511'], source: 'scrapli NXOSDriver on_open; netmiko cisco_nxos.py session_preparation' },
    structured: { suffix: ' | json', source: 'spec: append `| json` wherever supported (TextFSM fallback)' },
  },
  cisco_iosxr: {
    paging: { off: ['terminal length 0', 'terminal width 511'], source: 'scrapli IOSXRDriver on_open; netmiko cisco_xr.py session_preparation' },
  },
  arista_eos: {
    paging: { off: ['terminal length 0', 'terminal width 511'], source: 'scrapli EOSDriver on_open; netmiko arista.py session_preparation' },
    structured: { suffix: ' | json', source: 'spec: `| json` on everything (or eAPI if enabled)' },
  },
  juniper_junos: {
    paging: { off: ['set cli screen-length 0', 'set cli screen-width 511', 'set cli complete-on-space off'], source: 'scrapli JunosDriver on_open; netmiko juniper.py session_preparation' },
    structured: { suffix: ' | display xml', source: 'spec: `| display xml` (json on ≥14.2)' },
    strip_context_lines: { pattern: '^\\{(master|backup|line|primary|secondary)(:\\d+)?\\}\\s*$|^\\[edit\\]\\s*$', source: 'netmiko juniper.py strip_context_items' },
  },
  fortios: {
    banner: { prompt: "(Press 'a' to accept):", answer: 'a', source: 'scrapli_community FortinetFortiOSDriver.prepare_session; netmiko fortinet_ssh.py session_preparation ("to accept")' },
    contexts: {
      kind: 'vdom',
      detect: { cmd: 'get system status', match: '^Virtual domain configuration: (multiple|enable|split-task)', source: 'netmiko fortinet_ssh.py _vdoms_enabled; scrapli_community _vdoms_status' },
      list: { cmd: 'diagnose sys vd list', match: '^name=(\\S+)/', source: 'spec (unverified); scrapli_community gather_vdoms uses `show | grep "config vdom" -f -A1` → ^edit (\\w+)$' },
      enter_global: ['config global'],
      enter: ['config vdom', 'edit {vdom}'],
      leave: ['end'],
      abort: ['abort', 'end'],
      source: 'scrapli_community FortinetFortiOSDriver.context / _to_system; netmiko fortinet_ssh.py _config_global',
    },
    paging: {
      check: { cmd: 'get system console | grep ^output', match: 'output\\s*:\\s*(\\w+)', want: 'standard', in_global: true, source: 'netmiko fortinet_ssh.py _get_output_mode_v7; scrapli_community prepare_session' },
      check_v6: { cmd: 'show full-configuration system console', match: '^\\s+set output (\\S+)\\s*$', source: 'netmiko fortinet_ssh.py _get_output_mode_v6' },
      off: ['config system console', 'set output standard', 'end'],
      restore: ['config system console', 'set output {original}', 'end'],
      in_global: true,
      source: 'netmiko fortinet_ssh.py disable_paging / cleanup; scrapli_community prepare_session / cleanup_session; spec prep',
    },
    kex_note: 'netmiko fortinet_ssh.py preferred_kex: group14-sha1, group-exchange-sha1, group-exchange-sha256, group1-sha1 — Coreview already offers these',
  },
  panos: {
    paging: { off: ['set cli scripting-mode on', 'set cli pager off', 'set cli config-output-format set'], source: 'scrapli_community paloalto_panos on_open; netmiko paloalto_panos.py session_preparation; spec prep (config-output-format set)' },
    contexts: {
      kind: 'vsys',
      detect: { cmd: 'show system info', match: '^multi-vsys: on', source: 'spec' },
      list: { cmd: 'show system setting target-vsys', match: 'vsys\\d+', source: 'unverified — no source encodes vsys listing; PAN-OS XML API `type=config&xpath=/config/devices/entry/vsys` is the API-side answer' },
      enter: ['set system setting target-vsys {vsys}'],
      leave: ['set system setting target-vsys none'],
      source: 'spec cap.vsys (unverified against a device)',
    },
    banner: { prompt: 'Do you accept', answer: 'yes', source: 'netmiko paloalto_panos.py pa_banner_handler (keyboard-interactive)' },
    structured: { api: 'XML API type=op, identical commands as <show><system><info></info></system></show>', source: 'spec' },
  },
  aoscx: {
    paging: { off: ['no page'], source: 'scrapli_community aruba_aoscx on_open; netmiko aruba_aoscx.py session_preparation; Coreview arubacx dialect (verified on the lab 6200F)' },
    ansi: { strip: true, source: 'netmiko aruba_aoscx.py ansi_escape_codes = True' },
  },
  aoss: {
    banner: { prompt: 'any key to continue', answer: '', source: 'netmiko hp_procurve.py session_preparation' },
    prompt_pattern: '[>#]',
    privilege_levels: {
      exec: { pattern: '^[\\w.\\-@/:()]{1,63}>\\s?$' },
      privilege_exec: { pattern: '^[\\w.\\-@/:()]{1,63}#\\s?$', escalate: 'enable', escalate_auth: true, escalate_prompt: '(username|login|user name|password)', source: 'netmiko hp_procurve.py enable: may ask for the username before the password' },
    },
    default_privilege: 'privilege_exec',
    paging: { off: ['terminal width 511', 'no page'], needs_enable: true, source: 'netmiko hp_procurve.py session_preparation ("requires elevated privileges to disable output paging"); Coreview arubasw dialect (verified on the lab 2930M)' },
    on_close: { steps: ['logout'], confirm: { prompt: 'Do you want', answer: 'y' }, source: 'netmiko hp_procurve.py cleanup' },
    ansi: { strip: true, source: 'netmiko hp_procurve.py ansi_escape_codes = True' },
    ssh_note: 'netmiko hp_procurve.py disables rsa-sha2-256/512 pubkey algorithms; kex quirks on old firmware are not handled yet',
    failed_when_contains: ['Invalid input:', 'Incomplete input:', 'Ambiguous input:'],
    source: 'netmiko hp_procurve.py (no scrapli platform in the pinned release)',
  },
  cisco_asa: {
    paging: { off: ['terminal pager 0'], source: 'scrapli_community cisco_asa on_open; netmiko cisco_asa_ssh.py session_preparation' },
    contexts: {
      kind: 'context',
      detect: { cmd: 'show mode', match: '^Security context mode: multiple', source: 'spec' },
      list: { cmd: 'show context', match: '^\\*?\\s*(\\S+)\\s+\\S+', source: 'spec; unverified' },
      enter: ['changeto context {ctx}'],
      leave: ['changeto system'],
      reprompt: true,
      source: 'netmiko cisco_asa_ssh.py send_command ("multi-context mode … base_prompt needs to be updated" after changeto)',
    },
  },
  cisco_wlc_aireos: {
    login: { username_prompt: 'User:', password_prompt: 'ssword', source: 'netmiko cisco_wlc_ssh.py special_login_handler; scrapli_community cisco_aireos auth_bypass' },
    paging: { off: ['config paging disable'], restore: ['config paging enable'], source: 'scrapli_community cisco_aireos on_open; netmiko cisco_wlc_ssh.py session_preparation / cleanup' },
    on_close: { steps: ['logout'], confirm: { prompt: 'save', answer: 'n' }, source: 'netmiko cisco_wlc_ssh.py cleanup' },
  },
  hpe_comware: { paging: { off: ['screen-length disable'], source: 'scrapli_community hp_comware on_open; Coreview comware dialect' } },
  huawei_vrp: { paging: { off: ['screen-length 0 temporary'], source: 'scrapli_community huawei_vrp on_open; Coreview huawei dialect' } },
  mikrotik_routeros: { paging: { suffix: ' without-paging', source: 'Coreview routeros dialect; RouterOS has no session-wide paging switch' }, prompt_echo_twice: { source: 'scrapli_community mikrotik_routeros sync_driver.send_command' } },
};

// ------------------------------------------------------------- feeds, weight

/** Which tables a command fills, by what the command asks for. All that match apply. */
const FEEDS = [
  [/\b(running-config|current-configuration)\b|configuration \| display set|config running/, ['raw_config']],
  [/^(show|get|display) (version|system status|system info|sysinfo|chassis hardware|inventory|platform|hostname|name|device manuinfo|esn)$|^show system$|^show system information$|system (resource|identity|routerboard) print|admin show inventory|^\/organizations$|\/devices$|\/devices\/statuses/, ['device']],
  [/\b(modules?|switch|stack|stacking|vsf|vsx|vpc|mlag|redundancy|failover|ha|high-availability|virtual-chassis|cluster|stackwise-virtual|routing-engine|fex|stacks)\b/, ['ha_pair']],
  [/\binterfaces?\b|\bip addr\b|\bip address\b|ipconfig|address list|NetIPConfiguration|\bbundle\b|nic list|\bports?\b|\/ports\/statuses|uplink/, ['interface']],
  [/\b(ip|ipv6) interface\b|interface all|interface logical|routing interface|\bip address\b|address list|system interface|ip -j addr|ip -4 -o addr|NetIPConfiguration|interfaces terse|^show ip$|\/routing\/interfaces|\/appliance\/vlans/, ['ip_address']],
  [/\barp\b|\b(ip|ipv6) neighbors?\b|ip neighbor print|ip -j neigh|NetNeighbor|device-tracking|\bip neigh\b|\/neighbors$/, ['arp']],
  [/\blldp\b|\bcdp\b|networkhint|lldpctl|lldpcli|lldpCdp|linkLayer/, ['neighbor']],
  [/\bmac\b|mac-address|mac address|\bfdb\b|ethernet-switching table|bridge host|\bmacs\b/, ['mac_table']],
  [/\bvlans?\b|switchport|\btrunk$|ethernet-switching interfaces|port vlan|\/vlans$/, ['vlan']],
  [/port-channel|etherchannel|\blag\b|\blacp\b|\btrunks\b|\bbundle\b|link-aggregation|eth-trunk|\bsharing\b|mlag interfaces|aggregate-ethernet/, ['lag']],
  [/spanning-tree|\bstp\b/, ['stp']],
  [/\bvrfs?\b|routing-instances|route instance|vpn-instance|vd list|\bvsys\b|all-vrfs|vrf all/, ['vrf']],
  [/\broutes?\b(?! ?-?map)|routing-table|routing route|\bfib\b|\bcef\b|forwarding|ip -j route|NetRoute|\bkernel\b|staticRoutes/, ['route']],
  [/\bospf\b|\beigrp\b|\bbgp\b|\bisis\b|\brip\b|ldp neighbor|routing protocol|ip protocols|\bpeers?\b/, ['routing_neighbor']],
  [/\bstandby\b|\bhsrp\b|\bvrrp\b|\bglbp\b|active-gateway|virtual-router/, ['fhrp']],
  [/ip policy|\bpbf\b|\bproute\b|route-map|route-policy|router policy|policy-map type pbr|firewall \| display set/, ['policy_route']],
  [/\bnat\b|\bxlate\b|\bippool\b|\bvip\b|nat-policy/, ['nat_rule']],
  [/\bzones?\b/, ['fw_zone']],
  [/security-policy|firewall policy|firewall address|firewall addrgrp|security policies|security zones|match-policies|security \| display|l3FirewallRules/, ['fw_policy']],
  [/\bcrypto\b|\bipsec\b|\bike\b|\bvpn\b|\bdmvpn\b|\btunnel\b|\bnve\b|\bvxlan\b|\bevpn\b|l2route|\bsdwan\b|virtual-wan|\bmpls\b|\bldp\b|\bl2vpn\b|xconnect|bridge-domain|siteToSiteVpn|vpn-sessiondb|\bike-sa\b|\bipsec-sa\b|\/vpn\//, ['tunnel']],
  [/\bap\b|\baps\b|\bwlan\b|wireless|mobility|access-point|ap database|ssids/, ['ap']],
  [/client summary|\bclients\b|dhcp snooping|device-tracking|lease-list|endpoint/, ['endpoint']],
  [/\bfeature\b|show ip protocols|show mode|show context|^show network$|show managers|performance status|switch-controller|networks$/, ['device']],
  [/traceroute|exact-route|routing hash|fib-lookup|packet-tracer|policy-match/, ['path_probe']],
];

const HEAVY = /running-config|configuration \| display set|config running|current-configuration|^show interfaces?$|^show interface$|^show interfaces detail|mac address|mac-address|mac all|fdb|^show (ip )?arp|arp all|arp no-resolve|neighbor(s)? (vrf all|all-vrfs)|route(?! ?summary| ?instance| ?static)|routing-table|nat translations|forwarding|cef|fib|client summary|clients|display set|routing route|ip route|ipv6 route/;

const feedsOf = (cmd) => {
  const out = new Set();
  for (const [re, tables] of FEEDS) if (re.test(cmd)) for (const t of tables) out.add(t);
  return [...out];
};

// ------------------------------------------------------------------- gates

/** The spec's gate spellings → the catalog's expression grammar. */
function gateOf(raw) {
  let g = raw.trim();
  let foreach = null;
  let context = null;
  const fe = /(?:^| )foreach (\w+)/.exec(g);
  if (fe) { foreach = fe[1]; g = g.replace(fe[0], '').replace(/^\s*&&\s*/, '').trim() || 'always'; }
  if (g === 'api') g = 'always';
  g = g
    .replace(/always \(global\)/, () => { context = 'global'; return 'always'; })
    .replace(/always \(fw\)/, 'role.firewall')
    .replace(/cap\.routing \(legacy VR\)/, 'cap.routing && !cap.advanced_routing')
    .replace(/cap\.routing \(advanced, 10\.2\+\)/, 'cap.routing && cap.advanced_routing')
    .replace(/cap\.switching \(transparent\)/, 'cap.switching')
    .replace(/cap\.vrf \(FTD 6\.6\+\)/, 'cap.vrf')
    .replace(/role\.wlc \(9800\)/, 'role.wlc')
    .replace(/cap\.stack\/pair/, '(cap.stack || cap.vpc_mlag_vsx)')
    .replace(/cap\.ipsec\/dmvpn/, '(cap.ipsec || cap.dmvpn)')
    .replace(/&& SRX/, '&& role.firewall')
    .replace(/cap\.vsys/, 'cap.vsys')
    .replace(/cap\.l2vpn/, '(cap.mpls || cap.vxlan_evpn)')
    .replace(/cap\.mlag/, 'cap.vpc_mlag_vsx')
    .replace(/cap\.vpc\b/, 'cap.vpc_mlag_vsx')
    .replace(/cap\.fortilink/, 'cap.fortilink')
    .replace(/^fp$/, 'always')
    .replace(/^stub$/, 'always')
    .replace(/^role\.(linux-proxmox|esxi|windows|ftd)$/, 'role.$1');
  if (foreach === 'vr') foreach = 'vrf';
  if (foreach === 'instance' || foreach === 'ri') foreach = 'vrf';
  if (foreach === 'ctx') foreach = 'context';
  return { gate: g, foreach, context };
}

/** The spec writes `A → foreach vrf: B · C · D`; C and D are under the same foreach. */
function foreachFromPlaceholder(cmd, foreach) {
  if (foreach) return foreach;
  const m = /\{(vrf|vr|ri|instance|vdom|vsys|ctx)\}/.exec(cmd);
  if (!m) return null;
  return { vr: 'vrf', ri: 'vrf', instance: 'vrf', ctx: 'context' }[m[1]] ?? m[1];
}

const slug = (s) => s.replace(/\{(\w+)\}/g, '$1').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase();

// ----------------------------------------------------------------- build

/**
 * Coreview readers that met real hardware, per OS — the rest of
 * the existing crawl was built from documentation
 * and may not claim `lab` here.
 */
const COREVIEW_LAB = {
  cisco_ios: ['show version', 'show inventory', 'show cdp neighbors detail', 'show lldp neighbors detail', 'show mac address-table', 'show etherchannel summary', 'show ip interface brief', 'show ip arp', 'show arp', 'show ip route', 'show interfaces status'],
  cisco_nxos: ['show version', 'show inventory', 'show cdp neighbors detail', 'show lldp neighbors detail', 'show ip interface brief', 'show ip route'],
  fortios: ['get system status', 'get system interface physical', 'get system arp', 'get router info routing-table all', 'diagnose lldprx neighbors summary', 'execute switch-controller get-conn-status'],
  aoss: ['show version', 'show system', 'show cdp neighbors', 'show lldp info remote-device', 'show lldp info remote-device detail', 'show mac-address', 'show trunks', 'show ip', 'show arp', 'show ip route'],
  aoscx: ['show version', 'show system'],
};

function parserOf(os, row) {
  const meta = OS[os];
  if (row.kind === 'raw') return { parser: 'raw' };
  if (row.kind === 'caps') return { parser: 'regex' };
  if (row.gate === 'api' || (row.native && /^(REST|Dashboard API)/.test(row.native) && row.kind === 'native')) {
    return { parser: 'api', api: row.command.startsWith('/') ? row.command : row.native.replace(/^REST /, '') };
  }
  const out = {};
  if (meta.structured === 'json_pipe' && row.native) out.parser = 'json';
  else if (meta.structured === 'xml_pipe' && row.native) out.parser = 'xml';
  else if (meta.structured === 'xml_api' && row.native) out.parser = 'xml';
  else if (row.template) out.parser = `textfsm:${row.template.replace(/\.textfsm$/, '')}`;
  else if (row.native?.startsWith('JSON')) out.parser = 'json';
  else out.parser = 'none';
  if (row.template && out.parser !== `textfsm:${row.template.replace(/\.textfsm$/, '')}`) out.shadow = `textfsm:${row.template.replace(/\.textfsm$/, '')}`;
  if (row.templates_also?.length) out.also = row.templates_also.map((t) => `textfsm:${t.replace(/\.textfsm$/, '')}`);
  if (row.native?.startsWith('REST ')) out.api = row.native.replace(/^REST /, '');
  return out;
}

function verifiedOf(os, row, parser) {
  const coreview = row.coreview === 'yes' && (COREVIEW_LAB[os] ?? []).includes(row.command);
  if (row.template && row.fixtures > 0) return { verified: 'lab', evidence: `ntc-templates tests (${row.fixtures} captures)${coreview ? '; Coreview ' + os + ' reader' : ''}` };
  if (coreview) return { verified: 'lab', evidence: `Coreview ${os} reader, met real hardware` };
  if (parser.parser === 'raw' || parser.parser === 'regex') return { verified: 'docs', evidence: 'a configuration; no parser to verify' };
  if (row.template) return { verified: 'docs', evidence: 'ntc-templates template without a test fixture' };
  if (parser.parser === 'json' || parser.parser === 'xml' || parser.parser === 'api') return { verified: 'docs', evidence: `structured output (${row.native}); field mapping from documentation` };
  return { verified: 'unverified', evidence: 'no template, no structured output, no capture yet' };
}

function sessionOf(os) {
  const s = sessions[os] ?? sessions[{ hpe_comware: 'hpe_comware', ubiquiti_edgeos: 'vyos', hosts: 'cumulus' }[os]] ?? null;
  const extra = SESSION_EXTRA[os] ?? {};
  const out = {};
  if (s && !s.error) {
    out.source = s.source;
    if (s.prompt_pattern) out.prompt_pattern = s.prompt_pattern;
    if (s.privilege_levels && Object.keys(s.privilege_levels).length) {
      out.privilege_levels = {};
      for (const [name, p] of Object.entries(s.privilege_levels)) {
        if (/^(configuration|tclsh|bash|shell|root_shell|root|expert|configuration_exclusive|configuration_private)$/.test(name)) continue; // never entered
        const lvl = { pattern: p.pattern };
        if (p.escalate) lvl.escalate = p.escalate;
        if (p.escalate_auth) lvl.escalate_auth = true;
        if (p.escalate_prompt) lvl.escalate_prompt = p.escalate_prompt;
        if (p.previous) lvl.previous = p.previous;
        out.privilege_levels[name] = lvl;
      }
    }
    if (s.default_privilege) out.default_privilege = s.default_privilege;
    if (s.failed_when_contains?.length) out.failed_when_contains = s.failed_when_contains;
    if (s.on_open?.length) out.on_open = s.on_open;
    if (s.on_close?.length) out.on_close = s.on_close;
    if (s.ntc_platform) out.ntc_platform = s.ntc_platform;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'privilege_levels') out.privilege_levels = { ...(out.privilege_levels ?? {}), ...v };
    else out[k] = v;
  }
  if (!out.default_privilege && out.privilege_levels) out.default_privilege = Object.keys(out.privilege_levels).at(-1);
  return out;
}

function build(os) {
  const meta = OS[os];
  const mine = rows.filter((r) => r.os === os);
  const commands = [];
  const caps_probe = [];
  const live_path = [];
  const ids = new Set();
  for (const r of mine) {
    if (r.kind === 'session' || r.kind === 'refused') continue;
    const { gate, foreach: fe0, context } = gateOf(r.gate);
    const foreach = r.gate.startsWith('live-path') || r.kind === 'native' && /^\//.test(r.command) ? fe0 : foreachFromPlaceholder(r.command, fe0);
    const parser = parserOf(os, r);
    if (r.gate === 'caps_probe' || r.gate === 'caps_probe && SRX' || r.gate === 'fp') {
      if (r.gate === 'fp') continue; // the fingerprint probe is its own block
      const flags = meta.caps[r.command];
      const entry = { id: slug(r.command).slice(0, 60), cmd: r.command, flags: flags ?? {}, timeout: 30 };
      if (!flags) entry.note = 'no flag rule written yet; output is kept and sets nothing';
      if (r.template) entry.parser = `textfsm:${r.template.replace(/\.textfsm$/, '')}`;
      if (/&& SRX/.test(r.gate)) entry.gate = 'role.firewall';
      caps_probe.push(entry);
      continue;
    }
    let id = slug(r.command);
    while (ids.has(id)) id += '_2';
    ids.add(id);
    const entry = { id, cmd: r.command, gate };
    if (foreach) entry.foreach = foreach;
    if (context) entry.context = context;
    Object.assign(entry, parser);
    if (r.gate === 'live-path' || r.gate === 'live-path && SRX') {
      entry.gate = /SRX/.test(r.gate) ? 'role.firewall' : 'always';
      entry.feeds = ['path_probe'];
      const v = verifiedOf(os, r, parser);
      entry.verified = v.verified;
      entry.evidence = v.evidence;
      entry.phase = 3;
      live_path.push(entry);
      continue;
    }
    entry.feeds = parser.parser === 'raw' ? ['raw_config'] : feedsOf(r.command);
    if (entry.feeds.length === 0) entry.feeds = ['device'];
    entry.weight = HEAVY.test(r.command) || r.flags.includes('heavy') ? 'heavy' : 'light';
    entry.timeout = entry.weight === 'heavy' ? 120 : 30;
    const v = verifiedOf(os, r, parser);
    entry.verified = v.verified;
    entry.evidence = v.evidence;
    if (r.coreview === 'yes') entry.coreview_reader = true;
    if (r.flags.includes('verify')) entry.note = 'the spec marks this command "verify": its spelling is not confirmed';
    if (r.flags.includes('alternate spelling')) entry.note = 'an older spelling; sent only when the newer one is rejected';
    commands.push(entry);
  }
  // light before heavy, as the spec orders the run
  commands.sort((a, b) => (a.weight === b.weight ? 0 : a.weight === 'light' ? -1 : 1));
  const doc = {
    vendor: meta.vendor,
    os,
    name: meta.name,
    ntc_platform: meta.ntc,
    phase: meta.stub ? 2 : 1,
    fingerprint: meta.fingerprint ? { probe: meta.fingerprint.probe, match_regex: meta.fingerprint.match } : null,
    session: sessionOf(os),
    role_hint: meta.role_hint,
    role_defaults: meta.defaults,
    caps_probe,
    commands,
    live_path,
  };
  if (meta.structured) doc.structured_output = meta.structured;
  if (meta.stub) doc.note = 'Phase-2 stub: the commands are catalogued, the session block is taken from scrapli; parsers come with Phase 2.';
  const header = [
    `# Coreview discovery catalog — ${meta.vendor} ${meta.name} (${os})`,
    '#',
    '# First built 2026-09-29 by scripts/build-catalog.mjs from Coreview\'s discovery',
    '# specification, ntc-templates\' index',
    `# (resources/templates/ntc, ntc-templates 9.3.0), and the scrapli drivers`,
    `# (scrapli ${sessions._versions.scrapli}, scrapli_community ${sessions._versions.scrapli_community}) plus netmiko 4.8.0 where`,
    '# named. Maintained by hand from here on; catalog.test.ts holds every',
    '# command to the ntc index and the read-only allowlist.',
    '#',
    '# verified: lab = a real capture parses (ntc-templates\' tests, or a',
    '# Coreview reader that met real hardware); docs = documented,',
    '# structured, or a template with no fixture; unverified = no template, no',
    '# structured output, no capture yet. Never invent a command.',
    '',
  ].join('\n');
  const path = join(outDir, `${os}.yaml`);
  if (existsSync(path) && !force) {
    console.error(`${path} exists; pass --force to rebuild it from scratch`);
    return;
  }
  writeFileSync(path, header + YAML.stringify(doc, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' }));
  console.log(`${os}: ${commands.length} commands, ${caps_probe.length} probes, ${live_path.length} live-path`);
}

for (const os of Object.keys(OS)) build(os);
