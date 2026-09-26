/**
 * The project as NetBox and Nautobot read it (LT-436).
 *
 * The same shape LT-247's reader accepts — the REST API's own records, as a
 * JSON object of lists or the same records as YAML — so a file written here
 * reads straight back in, and so an operator moving an estate into NetBox
 * has a file `pynetbox` or the bulk importer will take: devices with their
 * type, role, site, rack and primary address; an interface per port the
 * crawl saw; an address per interface; a cable per link with both ends; and
 * the VLANs. Nothing is invented: a device with no site has no site, a link
 * with no ports has terminations that name only the devices.
 *
 * **Built from NetBox's serializers, like the reader** (D-032): no live
 * instance was available to import into, and this says so until one has.
 */
import { stringify } from 'yaml';

import { allEdges, allNodes } from './pages';
import type { ProjectDocument } from '../state/store';
import type { DeviceNodeData, LinkData, ProjectMeta } from '../types/domain';

type Rec = Record<string, unknown>;

export interface NetboxExport {
  /** Where it came from, so a reader can tell this from an API dump. */
  _coreview: { project: string; exported: string; note: string };
  devices: Rec[];
  interfaces: Rec[];
  ip_addresses: Rec[];
  cables: Rec[];
  vlans: Rec[];
}

const brief = (name: string | undefined | null) => (name && name.trim() ? { name: name.trim() } : null);
const withPrefix = (address: string) => (address.includes('/') ? address : `${address}/32`);

export function netboxExport(doc: ProjectDocument, meta: Pick<ProjectMeta, 'name' | 'site'>, exportedAt = new Date()): NetboxExport {
  const nodes = allNodes(doc).filter((n) => n.type !== 'note');
  const nameOf = new Map<string, string>();
  // Every record carries an id, as the API's own output does. The reader
  // tells a record from a container by that: a cable's terminations are
  // arrays, and without an id a reader walking arrays would step into them.
  let next = 0;
  const id = () => {
    next += 1;
    return next;
  };
  const devices: Rec[] = [];
  const interfaces: Rec[] = [];
  const ip_addresses: Rec[] = [];
  const vlans = new Map<string, Rec>();

  for (const n of nodes) {
    const d = n.data as DeviceNodeData;
    const name = (d.hostname?.trim() || d.label?.trim() || '').trim();
    if (!name) continue;
    nameOf.set(n.id, name);
    const site = d.site?.trim() || meta.site?.trim() || '';
    const primary = d.addresses?.find((a) => a.isPrimary) ?? d.addresses?.[0];
    devices.push({
      id: id(),
      name,
      device_type: { model: d.model?.trim() || d.deviceType, manufacturer: brief(d.vendor) },
      role: { name: d.role?.trim() || d.deviceType },
      site: brief(site),
      rack: brief(d.rack),
      ...(d.rackU != null ? { position: d.rackU } : {}),
      ...(d.rackFace ? { face: d.rackFace } : {}),
      serial: d.serial?.trim() || '',
      asset_tag: d.assetTag?.trim() || null,
      primary_ip4: primary?.address ? { address: withPrefix(primary.address) } : null,
      comments: d.notes?.trim() || '',
      tags: (d.tags ?? []).map((t) => ({ name: t })),
    });
    for (const a of d.addresses ?? []) {
      if (!a.address?.trim()) continue;
      ip_addresses.push({
        id: id(),
        address: withPrefix(a.address.trim()),
        status: 'active',
        assigned_object_type: 'dcim.interface',
        assigned_object: { device: { name }, name: a.label?.trim() || 'management' },
        description: a.label?.trim() || '',
      });
    }
    for (const p of d.inventory?.ports ?? []) {
      const mbps = Number(p.speed);
      interfaces.push({
        id: id(),
        device: { name },
        name: p.port,
        enabled: p.status !== 'disabled',
        ...(Number.isFinite(mbps) && mbps > 0 ? { speed: mbps * 1000 } : {}),
        ...(p.mode === 'trunk' ? { mode: 'tagged' } : p.mode === 'access' ? { mode: 'access' } : {}),
        ...(p.mode === 'access' && p.vlan != null ? { untagged_vlan: { vid: p.vlan } } : {}),
        ...(p.description ? { description: p.description } : {}),
      });
    }
    for (const v of d.inventory?.vlans ?? []) {
      const key = `${site}|${v.id}`;
      if (!vlans.has(key)) vlans.set(key, { id: id(), vid: v.id, name: v.name, site: brief(site), status: 'active' });
    }
  }

  const cables: Rec[] = [];
  for (const e of allEdges(doc)) {
    const a = nameOf.get(e.source);
    const b = nameOf.get(e.target);
    if (!a || !b) continue;
    const l = (e.data ?? {}) as Partial<LinkData>;
    if (l.kind === 'leader') continue;
    cables.push({
      id: id(),
      label: l.label?.trim() || '',
      a_terminations: [{ object_type: 'dcim.interface', object: { device: { name: a }, name: l.sourcePortLabel?.trim() || '' } }],
      b_terminations: [{ object_type: 'dcim.interface', object: { device: { name: b }, name: l.targetPortLabel?.trim() || '' } }],
      status: 'connected',
    });
  }

  return {
    _coreview: {
      project: meta.name,
      exported: exportedAt.toISOString(),
      note: 'Devices, interfaces, addresses, cables and VLANs as NetBox and Nautobot read them. Written by Coreview; nothing here was fetched from a server.',
    },
    devices,
    interfaces,
    ip_addresses,
    cables,
    vlans: [...vlans.values()],
  };
}

export function netboxJson(doc: ProjectDocument, meta: Pick<ProjectMeta, 'name' | 'site'>): string {
  return `${JSON.stringify(netboxExport(doc, meta), null, 2)}\n`;
}

export function netboxYaml(doc: ProjectDocument, meta: Pick<ProjectMeta, 'name' | 'site'>): string {
  return stringify(netboxExport(doc, meta), { lineWidth: 0 });
}
