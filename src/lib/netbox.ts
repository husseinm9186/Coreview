/**
 * A NetBox export read from a file (LT-247) — not from the API, so nothing
 * here holds a token or reaches a server.
 *
 * What people save is the REST API's own JSON: `curl …/api/dcim/devices/`, a
 * `pynetbox` dump, or the same records as YAML. So this accepts a list
 * response (`{count, results}`), a bare array, or an object holding
 * `devices`, `cables` and `ip_addresses` lists, in either format, and tells
 * records apart by their fields rather than by the file's name.
 *
 * **Built from NetBox's serializers** (`dcim/api/serializers_/devices.py`,
 * `cables.py`, `ipam/api/serializers_/ip.py` on the main branch, and the
 * `termination_a` / `device_role` fields of releases before 3.3 and 3.6), not
 * from an export of a real instance — none was available. The roadmap says
 * so until one has been read.
 */
import { parse as parseYaml } from 'yaml';

import type { LinkCsvRow, NodeCsvRow } from './csv';

export interface NetboxImport {
  devices: NodeCsvRow[];
  links: LinkCsvRow[];
  problems: string[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
/** A nested brief object's name, or the plain value. */
const nameOf = (v: unknown): string => (isObj(v) ? str(v.name) || str(v.display) || str(v.model) : str(v));
const withoutPrefix = (address: string) => address.replace(/\/\d+$/, '');

/** The records in whatever shape the file holds them. */
function records(data: unknown): Json[] {
  if (Array.isArray(data)) return data.flatMap(records);
  if (!isObj(data)) return [];
  if (Array.isArray(data.results)) return data.results.filter(isObj);
  const lists = Object.values(data).filter((v) => Array.isArray(v) || (isObj(v) && Array.isArray(v.results)));
  if (lists.length && !('id' in data) && !('name' in data)) return lists.flatMap(records);
  return [data];
}

const isDevice = (r: Json) => 'device_type' in r || (('role' in r || 'device_role' in r) && 'site' in r);
const isCable = (r: Json) => 'a_terminations' in r || 'termination_a' in r;
const isAddress = (r: Json) => 'assigned_object' in r && typeof r.address === 'string';

/** A device glyph from a NetBox role, then its model, by the words in it. */
export function typeFromRole(role: string, model = ''): string {
  const t = `${role} ${model}`.toLowerCase();
  const rules: [RegExp, string][] = [
    [/firewall|\bfw\b|fortigate|palo|asa\b/, 'firewall'],
    [/wireless.?controller|\bwlc\b/, 'wireless-controller'],
    [/access.?point|\bap\b|wifi|wireless/, 'access-point'],
    [/router|\brtr\b|\bwan\b/, 'router'],
    [/core/, 'core-switch'],
    [/distribution|aggregation|\bdist\b/, 'distribution-switch'],
    [/access/, 'access-switch'],
    [/l3|layer.?3/, 'l3-switch'],
    [/switch|leaf|spine|tor\b/, 'l2-switch'],
    [/load.?balancer|\badc\b/, 'load-balancer'],
    [/patch|panel/, 'patch-panel'],
    [/\bpdu\b|power.?distribution/, 'pdu'],
    [/\bups\b/, 'ups'],
    [/storage|\bnas\b|\bsan\b/, 'storage'],
    [/hypervisor|vm.?host|esxi/, 'vm-host'],
    [/server|compute/, 'server'],
    [/camera|cctv/, 'camera'],
    [/printer/, 'printer'],
    [/phone|voip/, 'ip-phone'],
    [/console/, 'generic'],
  ];
  return rules.find(([re]) => re.test(t))?.[1] ?? 'generic';
}

function device(r: Json): NodeCsvRow | null {
  const name = str(r.name) || str(r.display);
  if (!name) return null;
  const dt = isObj(r.device_type) ? r.device_type : {};
  const role = nameOf(r.role) || nameOf(r.device_role);
  const model = str(dt.model) || nameOf(r.device_type);
  const ip = [r.primary_ip4, r.primary_ip, r.oob_ip].map((v) => (isObj(v) ? str(v.address) : '')).find(Boolean) ?? '';
  const tags = Array.isArray(r.tags) ? r.tags.map(nameOf).filter(Boolean) : [];
  const position = Number(r.position);
  return {
    name,
    type: typeFromRole(role, model),
    address: withoutPrefix(ip),
    probeType: 'icmp',
    notes: str(r.comments) || str(r.description),
    tags,
    vendor: nameOf(dt.manufacturer) || undefined,
    model: model || undefined,
    serial: str(r.serial) || undefined,
    assetTag: str(r.asset_tag) || undefined,
    role: role || undefined,
    site: nameOf(r.site) || undefined,
    rack: nameOf(r.rack) || undefined,
    rackU: Number.isFinite(position) && position > 0 ? Math.floor(position) : undefined,
  };
}

/** One end of a cable: the device and the port, from either API generation. */
function ends(r: Json, side: 'a' | 'b'): { device: string; port: string }[] {
  const many = r[`${side}_terminations`];
  const list: unknown[] = Array.isArray(many) ? many.map((t) => (isObj(t) && isObj(t.object) ? t.object : t)) : [r[`termination_${side}`]];
  return list
    .filter(isObj)
    .map((o) => ({ device: nameOf(o.device), port: str(o.name) }))
    .filter((e) => e.device);
}

export function readNetbox(text: string): NetboxImport {
  const problems: string[] = [];
  let data: unknown;
  const trimmed = text.trimStart();
  try {
    data = trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 });
  } catch (e) {
    return { devices: [], links: [], problems: [`This is neither JSON nor YAML that could be read: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const all = records(data);
  const devices: NodeCsvRow[] = [];
  const links: LinkCsvRow[] = [];
  const addressFor = new Map<string, string>();
  let unnamed = 0;
  for (const r of all) {
    if (isDevice(r)) {
      const d = device(r);
      if (d) devices.push(d);
      else unnamed += 1;
    } else if (isCable(r)) {
      const a = ends(r, 'a');
      const b = ends(r, 'b');
      if (!a.length || !b.length) {
        problems.push(`Cable ${str(r.label) || str(r.id) || '(no id)'} does not end on a device at both sides; skipped.`);
        continue;
      }
      // A breakout cable has several terminations a side; they pair in order.
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const x = a[Math.min(i, a.length - 1)]!;
        const y = b[Math.min(i, b.length - 1)]!;
        links.push({ source: x.device, target: y.device, sourcePort: x.port, targetPort: y.port, label: str(r.label), healthRule: 'both-endpoints' });
      }
    } else if (isAddress(r)) {
      const owner = isObj(r.assigned_object) ? nameOf(r.assigned_object.device) : '';
      if (owner && !addressFor.has(owner.toLowerCase())) addressFor.set(owner.toLowerCase(), withoutPrefix(str(r.address)));
    }
  }
  // An address assigned to a device's interface fills in a device that has no
  // primary address set.
  for (const d of devices) if (!d.address) d.address = addressFor.get(d.name.toLowerCase()) ?? '';
  if (unnamed) problems.push(`${unnamed} device${unnamed === 1 ? ' has' : 's have'} no name; skipped.`);
  if (!devices.length && !links.length) problems.push('No NetBox devices or cables were found in this file. Save the API output of /api/dcim/devices/ or /api/dcim/cables/.');
  return { devices, links, problems };
}
