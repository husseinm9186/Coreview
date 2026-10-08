#!/usr/bin/env node
/**
 * Every command in docs/DISCOVERY-SPEC.md against ntc-templates'
 * index, the way ntc-templates itself matches — the index's `[[...]]`
 * shorthand expanded, the Platform column a regex, matched from the start
 * of the command, first row in file order wins (the index is kept
 * longest-match-first for that reason).
 *
 *   node scripts/reconcile-ntc.mjs [--ntc resources/templates/ntc] [--out docs/DISCOVERY-RECONCILIATION.md]
 *
 * Reads the spec's per-OS catalog sections, tokenises each command line,
 * and writes one table: spec command → matched ntc template | native
 * structured output (`| json` / `| display xml` / REST / XML API) | none.
 * The rows with neither are the list — the only captures asked for.
 * Also written: `<out>.json`, which the catalog build reads.
 *
 * Rerun when ntc-templates is updated; `reconcile.test.ts` checks the
 * checked-in table is what the script would write.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allowlistVerdict } from './allowlist.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const ntcDir = resolve(root, opt('--ntc', 'resources/templates/ntc'));
const testsDir = resolve(ntcDir, '..', 'tests');
const out = resolve(root, opt('--out', 'docs/DISCOVERY-RECONCILIATION.md'));
const specPath = resolve(root, 'docs/DISCOVERY-SPEC.md');

/** Spec section heading → ntc platform names, in the order to try. */
export const PLATFORMS = {
  cisco_ios: ['cisco_ios', 'cisco_xe'],
  cisco_nxos: ['cisco_nxos'],
  cisco_iosxr: ['cisco_xr'],
  arista_eos: ['arista_eos'],
  juniper_junos: ['juniper_junos'],
  fortios: ['fortinet'],
  panos: ['paloalto_panos'],
  aoscx: ['aruba_aoscx'],
  aoss: ['hp_procurve'],
  cisco_asa: ['cisco_asa', 'cisco_ftd'],
  cisco_wlc_aireos: ['cisco_wlc_ssh'],
  meraki: [],
  hosts: ['linux'],
  // ESXi and Windows have catalogs of their own.
  esxi: [],
  windows: [],
  huawei_vrp: ['huawei_vrp'],
  hpe_comware: ['hp_comware'],
  mikrotik_routeros: ['mikrotik_routeros'],
  dell_os10: ['dell_os10'],
  extreme_exos: ['extreme_exos'],
  // ICX is FastIron; the brocade set carries LLDP, LAGs and spanning tree.
  ruckus_icx: ['brocade_fastiron', 'ruckus_fastiron'],
  ubiquiti_edgeos: ['ubiquiti_edgerouter', 'ubiquiti_edgeswitch'],
  cisco_s300: ['cisco_s300'],
  cisco_viptela: ['cisco_viptela'],
  aruba_os: ['aruba_os'],
  vyos: ['vyos'],
};

/**
 * Native structured output, per OS: a predicate over the command. Where
 * the platform answers structured for everything the spec asks, the
 * template is the shadow-mode comparison, not the parser of record.
 */
const NATIVE = {
  cisco_nxos: (c) => (c.startsWith('show ') ? '`| json`' : null),
  arista_eos: (c) => (c.startsWith('show ') ? '`| json` / eAPI' : null),
  juniper_junos: (c) => (c.startsWith('show ') ? '`| display xml`' : null),
  panos: (c) => (c.startsWith('show ') || c.startsWith('test ') ? 'XML API `type=op`' : null),
  fortios: (c) => (FORTIOS_REST[c] ? `REST ${FORTIOS_REST[c]}` : null),
  aoscx: (c) => (AOSCX_REST[c] ? `REST ${AOSCX_REST[c]}` : null),
  meraki: () => 'Dashboard API',
  hosts: (c) => (/(^ip -j |^bridge -j |-f json$|ConvertTo-Json)/.test(c) ? 'JSON' : null),
  esxi: (c) => (/--formatter=json/.test(c) ? 'JSON' : null),
  windows: (c) => (/ConvertTo-Json/.test(c) ? 'JSON' : null),
};

const FORTIOS_REST = {
  'get system status': '/api/v2/monitor/system/status',
  'get system ha status': '/api/v2/monitor/system/ha-peer',
  'get system interface physical': '/api/v2/monitor/system/interface',
  'get system interface': '/api/v2/monitor/system/interface',
  'show system interface': '/api/v2/cmdb/system/interface',
  'show system zone': '/api/v2/cmdb/system/zone',
  'get system arp': '/api/v2/monitor/network/arp',
  'diagnose lldprx neighbors summary': '/api/v2/monitor/network/lldp/neighbors',
  'diagnose lldprx neighbors': '/api/v2/monitor/network/lldp/neighbors',
  'get router info routing-table all': '/api/v2/monitor/router/ipv4',
  'show router static': '/api/v2/cmdb/router/static',
  'show router policy': '/api/v2/cmdb/router/policy',
  'get router info ospf neighbor': '/api/v2/monitor/router/ospf/neighbors',
  'get router info bgp summary': '/api/v2/monitor/router/bgp/neighbors',
  'show firewall policy': '/api/v2/cmdb/firewall/policy',
  'show firewall address': '/api/v2/cmdb/firewall/address',
  'show firewall addrgrp': '/api/v2/cmdb/firewall/addrgrp',
  'show firewall vip': '/api/v2/cmdb/firewall/vip',
  'show firewall ippool': '/api/v2/cmdb/firewall/ippool',
  'get vpn ipsec tunnel summary': '/api/v2/monitor/vpn/ipsec',
  'diagnose vpn tunnel list': '/api/v2/monitor/vpn/ipsec',
  'show vpn ipsec phase1-interface': '/api/v2/cmdb/vpn.ipsec/phase1-interface',
  'show vpn ipsec phase2-interface': '/api/v2/cmdb/vpn.ipsec/phase2-interface',
  'show system sdwan': '/api/v2/cmdb/system/sdwan',
  'diagnose sys sdwan member': '/api/v2/monitor/virtual-wan/members',
  'diagnose sys sdwan health-check': '/api/v2/monitor/virtual-wan/health-check',
  'execute switch-controller get-conn-status': '/api/v2/monitor/switch-controller/managed-switch/status',
  'diagnose sys vd list': '/api/v2/cmdb/system/vdom',
  'show router ospf': '/api/v2/cmdb/router/ospf',
  'show router bgp': '/api/v2/cmdb/router/bgp',
};

const AOSCX_REST = {
  'show system': '/rest/v10.xx/system',
  'show hostname': '/rest/v10.xx/system',
  'show version': '/rest/v10.xx/firmware',
  'show interface': '/rest/v10.xx/system/interfaces',
  'show interface brief': '/rest/v10.xx/system/interfaces',
  'show ip interface brief': '/rest/v10.xx/system/interfaces',
  'show vlan': '/rest/v10.xx/system/vlans',
  'show vrf': '/rest/v10.xx/system/vrfs',
  'show ip route all-vrfs': '/rest/v10.xx/system/vrfs/{vrf}/routes',
  'show ipv6 route all-vrfs': '/rest/v10.xx/system/vrfs/{vrf}/routes',
  'show lldp neighbor-info': '/rest/v10.xx/system/interfaces/{if}/lldp_neighbors',
  'show lldp neighbor-info detail': '/rest/v10.xx/system/interfaces/{if}/lldp_neighbors',
  'show arp all-vrfs': '/rest/v10.xx/system/vrfs/{vrf}/neighbors',
  'show ipv6 neighbors all-vrfs': '/rest/v10.xx/system/vrfs/{vrf}/neighbors',
  'show mac-address-table': '/rest/v10.xx/system/vlans/{vlan}/macs',
  'show lag brief': '/rest/v10.xx/system/interfaces',
  'show vsx status': '/rest/v10.xx/system/vsx',
  'show vsx brief': '/rest/v10.xx/system/vsx',
  'show vsf': '/rest/v10.xx/system/vsf',
};

/** Placeholders the spec writes into live-path commands, as sample values. */
const SAMPLES = {
  vrf: 'X', ri: 'X', vr: 'default', vsys: 'vsys1', ctx: 'X', vdom: 'root', instance: 'X',
  dst: '192.0.2.1', src: '192.0.2.2', nh: '192.0.2.3', mac: '0000.0000.0001', ip: '192.0.2.1',
  p: 'tcp', proto: 'tcp', dp: '443', dport: '443', sp: '1024', sport: '1024',
  zone: 'Z', z1: 'Z', z2: 'Z', in_if: 'inside', if: '1/1/1', vlan: '10', org: 'O', net: 'N', serial: 'S', id: 'I',
};

/** A running configuration, or a grep over one. */
const CONFIG = /^(show (running-config|run\b|configuration|config running)|display current-configuration)/;

/**
 * Commands the existing crawl (`crates/coreview-discover`) already reads,
 * per OS — the Rust side of shadow mode, from `dialect.rs` and its
 * neighbours. Kept by hand; `dialectCommands.test.ts` checks it.
 */
const COREVIEW = {
  cisco_ios: ['show version', 'show inventory', 'show cdp neighbors detail', 'show lldp neighbors detail', 'show mac address-table', 'show etherchannel summary', 'show ip interface brief', 'show ip arp', 'show arp', 'show ip route', 'show ip policy', 'show switch', 'show switch detail', 'show switch virtual', 'show stackwise-virtual', 'show interfaces status', 'show vrf', 'show ip vrf', 'show nve vni', 'show nve peers', 'show bgp l2vpn evpn'],
  cisco_nxos: ['show version', 'show inventory', 'show cdp neighbors detail', 'show lldp neighbors detail', 'show mac address-table', 'show port-channel summary', 'show ip interface brief', 'show ip arp', 'show ip route', 'show vpc', 'show fex', 'show vrf', 'show nve vni', 'show nve peers', 'show bgp l2vpn evpn', 'show otv', 'show otv adjacency', 'show otv route'],
  arista_eos: ['show version', 'show lldp neighbors detail', 'show port-channel summary', 'show ip interface brief', 'show ip arp', 'show ip route', 'show mlag'],
  juniper_junos: ['show version', 'show chassis hardware', 'show lldp neighbors', 'show ethernet-switching table', 'show lacp interfaces', 'show interfaces terse', 'show arp no-resolve', 'show route', 'show virtual-chassis'],
  fortios: ['get system status', 'get system interface physical', 'get system arp', 'get router info routing-table all', 'diagnose lldprx neighbors summary', 'show router policy', 'execute switch-controller get-conn-status', 'get switch lldp neighbors-summary'],
  panos: ['show system info', 'show lldp neighbors all', 'show interface all', 'show arp all', 'show routing route', 'show pbf rule all'],
  aoscx: ['show version', 'show system', 'show lldp neighbor-info detail', 'show mac-address-table', 'show ip interface brief', 'show arp all-vrfs', 'show ip route all-vrfs', 'show vsf', 'show vsx brief'],
  aoss: ['show version', 'show system', 'show cdp neighbors', 'show lldp info remote-device', 'show lldp info remote-device detail', 'show mac-address', 'show trunks', 'show ip', 'show arp', 'show ip route', 'show stacking', 'show vsf'],
  cisco_asa: ['show version', 'show inventory', 'show interface ip brief', 'show arp', 'show route'],
  cisco_wlc_aireos: ['show sysinfo', 'show inventory', 'show ap summary', 'show ap cdp neighbors all'],
  hpe_comware: ['display version', 'display device manuinfo', 'display lldp neighbor-information list', 'display mac-address', 'display link-aggregation verbose', 'display ip interface brief', 'display arp', 'display ip routing-table'],
  huawei_vrp: ['display version', 'display esn', 'display lldp neighbor brief', 'display eth-trunk', 'display ip interface brief', 'display arp', 'display ip routing-table'],
  mikrotik_routeros: ['/system resource print', '/system routerboard print', '/ip neighbor print detail without-paging', '/interface bridge host print without-paging', '/ip address print without-paging', '/ip arp print without-paging', '/ip route print without-paging'],
  ubiquiti_edgeos: ['show version', 'show lldp neighbors detail', 'show interfaces', 'show arp', 'show ip route', 'lldpctl'],
  hosts: ['ip -4 -o addr show', 'bridge fdb show', 'net show lldp', 'net show interface bonds', 'lldpctl'],
};

/** Session steps the spec writes inline; they belong to the catalog's `session:` block. */
const SESSION = /^(set system setting target-vsys|changeto context|config (global|vdom)|edit |end$|set cli |terminal |no page|config paging|screen-length)/;
/** A gate marker at the start of an entry, when a line carries several. */
const GATE = /^((?:cap|role)\.[\w/]+|always|live-path|caps_probe|stub|api)( \([^)]*\))?:\s*(.*)$/;

function readSpec() {
  const text = readFileSync(specPath, 'utf8');
  const start = text.indexOf('## Command catalog');
  const end = text.indexOf('## Discovery tables');
  const body = text.slice(start, end);
  const sections = [];
  let current = null;
  for (const line of body.split('\n')) {
    const h = /^### ([a-z0-9_]+)/.exec(line);
    if (h) {
      current = { os: h[1] === 'phase' ? 'phase2' : h[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current && line.trim()) current.lines.push(line.trim());
  }
  return sections;
}

/** One spec line → [{gate, command, flags}] */
function tokenise(line) {
  const m = /^([^:]+?):\s*(.*)$/.exec(line);
  if (!m) return [];
  let gate = m[1].trim();
  let rest = m[2];
  if (/^(prep|role_hint)$/.test(gate)) return [];
  if (gate === 'fp') rest = rest.split('→')[0];
  const rows = [];
  for (let entry of rest.split(' · ')) {
    entry = entry.trim();
    if (!entry) continue;
    const g0 = GATE.exec(entry);
    if (g0) { gate = g0[1] + (g0[2] ?? ''); entry = g0[3]; }
    if (/^(if |use |or )/.test(entry) || entry.includes('`')) continue; // prose
    const flags = [];
    if (/\((?:verify|unverified)[^)]*\)/.test(entry)) flags.push('verify');
    if (/\(heavy[^)]*\)/.test(entry)) flags.push('heavy');
    // "show vrf (legacy: show ip vrf)" and "(12.2: show mac-address-table)" are two spellings.
    const alt = /\((?:legacy|12\.2|6\.x): ([^)]+)\)/.exec(entry);
    entry = entry.replace(/\s*\([^)]*\)/g, '');
    // "A → foreach vrf: B" — A is a command, B is a foreach-expanded one.
    let subgate = gate;
    for (const part of entry.split(/\s*→\s*/)) {
      let p = part;
      const fe = /^foreach (\w+):\s*(.*)$/.exec(p);
      if (fe) { subgate = `${gate} foreach ${fe[1]}`; p = fe[2]; }
      if (/queries$/.test(p)) continue;
      // "A ; B" is a sequence; "A | display eth-trunk" is two spellings — but
      // "| display set" and "| display xml" are Junos output filters.
      const cmds = p.split(' ; ').flatMap((c) => (/ \| (display (?!set|xml|json)|show|get) /.test(c) ? c.split(/ \| (?=(?:display|show|get) )/) : [c]));
      for (let cmd of cmds) {
        cmd = cmd.trim();
        const g = /^\[([^\]]+)\]\s*(.*)$/.exec(cmd);
        let gg = subgate;
        if (g) { gg = `${subgate} && ${g[1]}`; cmd = g[2]; }
        cmd = cmd.replace(/\s*\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
        if (!cmd) continue;
        rows.push({ gate: gg, command: cmd, flags: [...flags] });
      }
    }
    if (alt) rows.push({ gate, command: alt[1].trim(), flags: ['alternate spelling'] });
  }
  return rows;
}

/** `sh[[ow]]` → `sh(o(w)?)?`, the way textfsm's clitable expands it. */
export function expandIndexCommand(cmd) {
  return cmd.replace(/\[\[(.+?)\]\]/g, (_, s) => '(' + s.split('').join('(') + ')?'.repeat(s.length));
}

export function loadIndex(dir = ntcDir) {
  const path = join(dir, 'index');
  if (!existsSync(path)) {
    console.error(`no index at ${path}; vendor ntc-templates first (scripts/vendor-ntc.sh)`);
    process.exit(2);
  }
  const rows = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('Template,')) continue;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length < 4) continue;
    const [template, , platform, ...cmd] = cells;
    const command = cmd.join(',');
    rows.push({ template, platform, platformRe: new RegExp('^' + platform + '$'), command, re: new RegExp('^' + expandIndexCommand(command)) });
  }
  return rows;
}

/**
 * ntc-templates matches: platform regex, then command prefix (`re.match`,
 * unanchored at the end), first row wins. One thing tighter than ntc: the
 * prefix must end at a word boundary, so `show stackwise-virtual` is not
 * handed `show st[[andby]]`'s template the way clitable would hand it.
 * Arguments after a full command (`show ip route vrf X`) still match the
 * base command's template, as they do in ntc.
 */
export function matchIndex(index, platform, command) {
  for (const r of index) {
    if (!r.platformRe.test(platform)) continue;
    const m = r.re.exec(command);
    if (!m) continue;
    const end = m[0].length;
    if (end === command.length || command[end] === ' ' || m[0].endsWith(' ')) return r;
  }
  return null;
}

let testPlatforms = null;
function fixturesFor(template) {
  testPlatforms ??= existsSync(testsDir) ? readdirSync(testsDir).sort((a, b) => b.length - a.length) : [];
  const base = template.replace(/\.textfsm$/, '');
  const platform = testPlatforms.find((p) => base.startsWith(p + '_'));
  if (!platform) return 0;
  const dir = join(testsDir, platform, base.slice(platform.length + 1));
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.raw')).length;
}

function sample(command) {
  return command.replace(/\{(\w+)\}/g, (_, k) => SAMPLES[k] ?? 'X');
}

function main() {
  const index = loadIndex();
  const sections = readSpec();
  const table = [];
  const seen = new Set();
  const push = (row) => {
    if (row.gate === 'fp') return; // the fingerprint probe is the catalog's own block, not a command
    // A command may be a capability probe and a collection command and a live-path lookup; each is its own row.
    const cls = /^caps_probe/.test(row.gate) ? 'caps' : /^live-path/.test(row.gate) ? 'live' : 'cmd';
    const key = `${row.os}\u0000${row.command}\u0000${cls}`;
    if (seen.has(key)) return;
    seen.add(key);
    table.push(row);
  };
  for (const section of sections) {
    if (section.os === 'snmp') continue;
    if (section.os === 'phase2') {
      for (const line of section.lines) {
        const m = /^([a-z_/]+):\s*(.*)$/.exec(line);
        if (!m) continue;
        for (const os of m[1].split('/')) for (const row of tokenise(`stub: ${m[2]}`)) push(classify(os, row, index));
      }
      continue;
    }
    for (const line of section.lines) {
      let l = line;
      // The spec's hosts section names three platforms; each has its own catalog.
      let os = section.os;
      if (os === 'hosts' && /^ESXi:/.test(l)) os = 'esxi';
      if (os === 'hosts' && /^Windows:/.test(l)) os = 'windows';
      if (section.os === 'meraki' && l.startsWith('GET ')) l = 'api: ' + l.slice(4);
      if (section.os === 'hosts') l = l.replace(/^(Linux\/Proxmox|ESXi|Windows):/, (_, k) => `role.${k.toLowerCase().replace('/', '-')}:`);
      if (/^REST/.test(l)) l = 'api: ' + l.replace(/^REST[^:]*:\s*/, '');
      if (/^FTD extra:/.test(l)) l = 'role.ftd: ' + l.replace(/^FTD extra:\s*/, '').replace('FMC REST: ', 'api: ');
      for (const row of tokenise(l)) push(classify(os, row, index));
    }
  }
  write(table);
}

function classify(os, row, index) {
  const { command } = row;
  const result = { os, ...row, template: null, fixtures: 0, native: null, kind: 'none', note: '' };
  if (row.gate.startsWith('api') || (command.startsWith('/') && !/ print$/.test(command))) {
    result.kind = 'native';
    result.native = os === 'meraki' ? 'Dashboard API' : 'REST';
    return result;
  }
  if (SESSION.test(command)) { result.kind = 'session'; result.note = 'session step, lives in `session:`'; return result; }
  const verdict = allowlistVerdict(command);
  if (verdict !== 'ok') { result.kind = 'refused'; result.note = verdict; return result; }
  result.coreview = COREVIEW[os]?.includes(command) ? 'yes' : '';
  if (CONFIG.test(command)) {
    // A configuration is kept scrubbed and read for capability flags; it is never parsed into rows.
    result.kind = row.gate === 'caps_probe' ? 'caps' : 'raw';
    result.note = row.gate === 'caps_probe' ? 'capability flags from line prefixes (`parser: regex`)' : 'kept scrubbed, not parsed (`parser: raw`)';
    return result;
  }
  const probe = sample(command);
  for (const platform of PLATFORMS[os] ?? []) {
    const hit = matchIndex(index, platform, probe);
    if (hit) {
      // `a.textfsm:b.textfsm` — ntc runs both templates over the same output.
      const list = hit.template.split(':');
      result.template = list[0];
      if (list.length > 1) result.templates_also = list.slice(1);
      result.fixtures = fixturesFor(list[0]);
      break;
    }
  }
  const native = NATIVE[os]?.(command) ?? null;
  result.native = native;
  result.kind = result.template && native ? 'both' : result.template ? 'template' : native ? 'native' : 'none';
  if (result.template && result.fixtures === 0) result.note = 'template has no test fixture in ntc-templates';
  return result;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');

function write(table) {
  const counts = {};
  for (const r of table) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  const lines = [];
  lines.push('# Discovery spec ↔ ntc-templates reconciliation');
  lines.push('');
  lines.push(`Generated by \`node scripts/reconcile-ntc.mjs\` from \`docs/DISCOVERY-SPEC.md\` and \`${ntcDir.replace(root + '/', '')}/index\`. Do not edit by hand.`);
  lines.push('');
  lines.push('| kind | rows |');
  lines.push('|---|---|');
  for (const k of ['both', 'template', 'native', 'none', 'raw', 'caps', 'session', 'refused']) lines.push(`| ${k} | ${counts[k] ?? 0} |`);
  lines.push('');
  lines.push('**kind**: `template` = an ntc-templates template matches, with that many `.raw` fixtures in its tests; `native` = the platform answers structured (`| json`, `| display xml`, REST, XML API) and that is the parser of record; `both` = native first, the template is the shadow comparison; `none` = neither, waiting on a capture; `raw` = a configuration, kept scrubbed and never parsed into rows; `caps` = a grep over the configuration whose only output is capability flags; `session` = not a collection command, belongs in the catalog\'s `session:` block; `refused` = the read-only allowlist (`scripts/allowlist.mjs`) will not send it, and the note says why. **Coreview reads it** = the existing crawl already parses this command on this OS, so shadow mode has a Rust side from day one.');
  lines.push('');
  let os = null;
  for (const r of table) {
    if (r.os !== os) {
      os = r.os;
      lines.push('');
      lines.push(`## ${os}`);
      lines.push('');
      lines.push('| gate | command | ntc template | fixtures | native | Coreview reads it | kind | note |');
      lines.push('|---|---|---|---|---|---|---|---|');
    }
    lines.push(`| ${cell(r.gate)} | \`${cell(r.command)}\` | ${r.template ? `\`${r.template}\`` : ''} | ${r.template ? r.fixtures : ''} | ${cell(r.native)} | ${r.coreview ?? ''} | ${r.kind} | ${cell([...r.flags, r.note].filter(Boolean).join('; '))} |`);
  }
  lines.push('');
  lines.push('## the capture list: no template and no native structured output');
  lines.push('');
  lines.push('Each catalog entry below is `verified: unverified` until a capture arrives. Phase-2 stubs are listed separately and are not asked for now.');
  const none = table.filter((r) => r.kind === 'none');
  let last = null;
  for (const r of none) {
    if (r.os !== last) { last = r.os; lines.push(''); lines.push(`**${r.os}**${r.gate === 'stub' ? ' (phase-2 stub)' : ''}`); }
    lines.push(`- \`${r.command}\`${r.flags.includes('verify') ? ' (the spec marks this *verify*)' : ''}`);
  }
  lines.push('');
  lines.push('## Refused by the allowlist');
  lines.push('');
  for (const r of table.filter((x) => x.kind === 'refused')) lines.push(`- ${r.os}: \`${cell(r.command)}\` — ${r.note}`);
  lines.push('');
  writeFileSync(out, lines.join('\n'));
  writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(table, null, 1));
  console.log(`${table.length} commands → ${out}`);
  for (const k of Object.keys(counts)) console.log(`  ${k}: ${counts[k]}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
