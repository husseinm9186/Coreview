/**
 * Templates (LT-187): a diagram to start drawing from rather than a blank page.
 *
 * Not samples. A sample (src/lib/samples.ts) is a demonstration of validation,
 * with probes that go out and ping things. A template is a drawing: the usual
 * shape of a branch office, a spine-leaf fabric, a DMZ, laid out the way an
 * engineer would draw it, with nothing monitored until someone says what to
 * monitor.
 *
 * Every name is invented and every address comes from the documentation
 * ranges — 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24 (RFC 5737),
 * 2001:db8::/32 (RFC 3849) — and every AS number from 64496–64511 (RFC 5398),
 * so nothing in a template can point at anyone's real network (D-027).
 * `templates.test.ts` holds every template to that.
 */
import { emptyDocument, type ProjectDocument, type TopoEdge } from '../state/store';
import { DEFAULTS } from '../theme';
import type { DeviceNodeData, DeviceType, LinkData, LinkLineStyle } from '../types/domain';
import { uid } from './id';

interface DeviceSpec {
  key: string;
  label: string;
  type: DeviceType;
  x: number;
  y: number;
  /** Management address first; `Label=address` for any other. */
  addresses?: string[];
  vlan?: string;
  model?: string;
  /** Rack name, lowest U and height; face and depth when not front, full. */
  rack?: { name: string; u: number; units: number; face?: 'rear'; depth?: 'half' };
}

interface SectionSpec {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  boundaryKind?: DeviceNodeData['boundaryKind'];
  boundaryId?: string;
}

interface LinkSpec {
  from: string;
  to: string;
  label?: string;
  sourcePort?: string;
  targetPort?: string;
  lineStyle?: LinkLineStyle;
  cableType?: LinkData['cableType'];
}

interface TextSpec {
  text: string;
  x: number;
  y: number;
  type?: 'text' | 'callout';
  w?: number;
  h?: number;
}

interface TemplateSpec {
  devices: DeviceSpec[];
  links: LinkSpec[];
  sections?: SectionSpec[];
  texts?: TextSpec[];
  racks?: { name: string; units: number }[];
}

const DEVICE = 76;

function build(spec: TemplateSpec): ProjectDocument {
  const doc = emptyDocument();
  const page = doc.pages[0]!;
  const ids = new Map<string, string>();
  const base = { tags: [], locked: false, maintenance: false, showDetails: true };

  // Sections first, so they sit under what stands in them.
  for (const s of spec.sections ?? []) {
    page.nodes.push({
      id: uid(),
      type: 'device',
      position: { x: s.x, y: s.y },
      width: s.w,
      height: s.h,
      data: {
        ...base,
        label: s.label,
        deviceType: 'zone',
        addresses: [],
        ...(s.boundaryKind ? { boundaryKind: s.boundaryKind, boundaryId: s.boundaryId ?? '' } : {}),
      } satisfies DeviceNodeData,
    });
  }

  for (const d of spec.devices) {
    const id = uid();
    ids.set(d.key, id);
    const addresses = (d.addresses ?? []).map((a, i) => {
      const [label, address] = a.includes('=') ? (a.split('=', 2) as [string, string]) : ['Management', a];
      return { id: uid(), label, address, isPrimary: i === 0 };
    });
    page.nodes.push({
      id,
      type: 'device',
      position: { x: d.x, y: d.y },
      width: DEVICE,
      height: DEVICE,
      data: {
        ...base,
        label: d.label,
        deviceType: d.type,
        addresses,
        ...(d.vlan ? { vlan: d.vlan } : {}),
        ...(d.model ? { model: d.model } : {}),
        ...(d.rack
          ? {
              rack: d.rack.name,
              rackU: d.rack.u,
              rackUnits: d.rack.units,
              ...(d.rack.face ? { rackFace: d.rack.face } : {}),
              ...(d.rack.depth ? { rackDepth: d.rack.depth } : {}),
            }
          : {}),
      } satisfies DeviceNodeData,
    });
  }

  for (const t of spec.texts ?? []) {
    const type = t.type ?? 'text';
    page.nodes.push({
      id: uid(),
      type: 'device',
      position: { x: t.x, y: t.y },
      width: t.w ?? (type === 'callout' ? 190 : 220),
      height: t.h ?? (type === 'callout' ? 64 : 44),
      data: { ...base, label: t.text, deviceType: type, addresses: [], showDetails: false } satisfies DeviceNodeData,
    });
  }

  for (const l of spec.links) {
    const source = ids.get(l.from);
    const target = ids.get(l.to);
    if (!source || !target) throw new Error(`template link ${l.from}–${l.to} names a device that is not there`);
    const edge: TopoEdge = {
      id: uid(),
      source,
      target,
      sourceHandle: 'b',
      targetHandle: 't',
      type: 'live',
      data: {
        sourcePortLabel: l.sourcePort ?? '',
        targetPortLabel: l.targetPort ?? '',
        label: l.label ?? '',
        pathType: 'smoothstep',
        direction: 'none',
        width: 2,
        color: DEFAULTS.linkColor,
        enabled: true,
        maintenance: false,
        healthRule: { type: 'both-endpoints' },
        ...(l.lineStyle ? { lineStyle: l.lineStyle } : {}),
        ...(l.cableType ? { cableType: l.cableType } : {}),
      },
    };
    page.edges.push(edge);
  }
  if (spec.racks) doc.racks = spec.racks.map((r) => ({ id: uid(), ...r }));
  return doc;
}

/** Branch office: two circuits, a firewall, one switch and what hangs off it. */
const branchOffice = (): TemplateSpec => ({
  sections: [
    { label: 'WAN edge', x: 160, y: 120, w: 520, h: 250 },
    { label: 'Office LAN', x: 20, y: 400, w: 820, h: 360, boundaryKind: 'subnet', boundaryId: '192.0.2.0/24' },
  ],
  devices: [
    { key: 'net', label: 'Internet', type: 'internet', x: 382, y: 0 },
    { key: 'isp1', label: 'Primary circuit', type: 'router', x: 220, y: 160, addresses: ['203.0.113.2'] },
    { key: 'isp2', label: 'Backup circuit', type: 'router', x: 540, y: 160, addresses: ['198.51.100.2'] },
    { key: 'fw', label: 'BR-FW1', type: 'firewall', x: 382, y: 270, addresses: ['192.0.2.1', 'IPv6=2001:db8:10::1'] },
    { key: 'sw', label: 'BR-SW1', type: 'access-switch', x: 382, y: 440, addresses: ['192.0.2.2'] },
    { key: 'ap1', label: 'BR-AP1', type: 'access-point', x: 80, y: 600, addresses: ['192.0.2.11'] },
    { key: 'ap2', label: 'BR-AP2', type: 'access-point', x: 230, y: 600, addresses: ['192.0.2.12'] },
    { key: 'phone', label: 'Reception phone', type: 'ip-phone', x: 380, y: 600, vlan: '30' },
    { key: 'print', label: 'Office printer', type: 'printer', x: 530, y: 600, addresses: ['192.0.2.40'] },
    { key: 'pc', label: 'Workstations', type: 'endpoint', x: 680, y: 600, vlan: '10' },
  ],
  links: [
    { from: 'net', to: 'isp1', cableType: 'wan' },
    { from: 'net', to: 'isp2', cableType: 'wan', lineStyle: 'dashed', label: 'Backup' },
    { from: 'isp1', to: 'fw', sourcePort: 'Gi0/1', targetPort: 'wan1', cableType: 'copper' },
    { from: 'isp2', to: 'fw', sourcePort: 'Gi0/1', targetPort: 'wan2', cableType: 'copper' },
    { from: 'fw', to: 'sw', sourcePort: 'port1', targetPort: 'Gi1/0/48', label: 'Trunk VLAN 10,20,30', cableType: 'trunk' },
    { from: 'sw', to: 'ap1', sourcePort: 'Gi1/0/1', label: 'PoE' },
    { from: 'sw', to: 'ap2', sourcePort: 'Gi1/0/2', label: 'PoE' },
    { from: 'sw', to: 'phone', sourcePort: 'Gi1/0/10', label: 'Voice VLAN 30' },
    { from: 'sw', to: 'print', sourcePort: 'Gi1/0/20', label: 'VLAN 10' },
    { from: 'sw', to: 'pc', sourcePort: 'Gi1/0/11-19', label: 'VLAN 10' },
  ],
});

/** Data centre spine-leaf: two spines, four leaves, a border leaf pair out. */
const spineLeaf = (): TemplateSpec => {
  const leaves = [0, 1, 2, 3];
  const devices: DeviceSpec[] = [
    { key: 'edge', label: 'DC-EDGE-FW', type: 'firewall', x: 470, y: 0, addresses: ['198.51.100.1'] },
    { key: 'bl1', label: 'BORDER-LEAF-1', type: 'l3-switch', x: 380, y: 150, addresses: ['198.51.100.21', 'Loopback0=2001:db8:ff::21'] },
    { key: 'bl2', label: 'BORDER-LEAF-2', type: 'l3-switch', x: 560, y: 150, addresses: ['198.51.100.22', 'Loopback0=2001:db8:ff::22'] },
    { key: 'sp1', label: 'SPINE-1', type: 'core-switch', x: 300, y: 330, addresses: ['198.51.100.11', 'Loopback0=2001:db8:ff::11'] },
    { key: 'sp2', label: 'SPINE-2', type: 'core-switch', x: 640, y: 330, addresses: ['198.51.100.12', 'Loopback0=2001:db8:ff::12'] },
  ];
  const links: LinkSpec[] = [
    { from: 'edge', to: 'bl1', label: 'eBGP', cableType: 'fiber-mm' },
    { from: 'edge', to: 'bl2', label: 'eBGP', cableType: 'fiber-mm' },
    { from: 'bl1', to: 'sp1', sourcePort: 'Eth1/49', cableType: 'fiber-mm' },
    { from: 'bl1', to: 'sp2', sourcePort: 'Eth1/50', cableType: 'fiber-mm' },
    { from: 'bl2', to: 'sp1', sourcePort: 'Eth1/49', cableType: 'fiber-mm' },
    { from: 'bl2', to: 'sp2', sourcePort: 'Eth1/50', cableType: 'fiber-mm' },
  ];
  for (const i of leaves) {
    const n = i + 1;
    devices.push(
      { key: `lf${n}`, label: `LEAF-${n}`, type: 'l3-switch', x: 140 + i * 220, y: 540, addresses: [`198.51.100.${30 + n}`, `Loopback0=2001:db8:ff::${30 + n}`] },
      { key: `srv${n}`, label: `Rack ${n} servers`, type: 'server', x: 140 + i * 220, y: 720, vlan: String(100 + n) },
    );
    links.push(
      { from: 'sp1', to: `lf${n}`, sourcePort: `Eth1/${n}`, targetPort: 'Eth1/49', label: '100G', cableType: 'fiber-mm' },
      { from: 'sp2', to: `lf${n}`, sourcePort: `Eth1/${n}`, targetPort: 'Eth1/50', label: '100G', cableType: 'fiber-mm' },
      { from: `lf${n}`, to: `srv${n}`, sourcePort: 'Eth1/1-48', label: `VLAN ${100 + n}`, cableType: 'copper' },
    );
  }
  return {
    sections: [
      { label: 'Fabric underlay', x: 100, y: 290, w: 780, h: 390, boundaryKind: 'bgp-as', boundaryId: '64501' },
    ],
    devices,
    links,
    texts: [{ text: 'One AS for the whole fabric here; many fabrics give each leaf its own.', x: 900, y: 440, type: 'callout', w: 220, h: 80 }],
  };
};

/** Campus three-tier: a core pair, a distribution pair per building, access. */
const campus = (): TemplateSpec => {
  const devices: DeviceSpec[] = [
    { key: 'fw', label: 'CAMPUS-FW', type: 'firewall', x: 520, y: 0, addresses: ['203.0.113.1'] },
    { key: 'c1', label: 'CORE-1', type: 'core-switch', x: 400, y: 150, addresses: ['203.0.113.11'] },
    { key: 'c2', label: 'CORE-2', type: 'core-switch', x: 640, y: 150, addresses: ['203.0.113.12'] },
  ];
  const links: LinkSpec[] = [
    { from: 'fw', to: 'c1', label: '10G', cableType: 'fiber-mm' },
    { from: 'fw', to: 'c2', label: '10G', cableType: 'fiber-mm' },
    { from: 'c1', to: 'c2', label: 'Port-channel 1', cableType: 'fiber-mm' },
  ];
  const sections: SectionSpec[] = [];
  for (const [b, name] of [[0, 'A'], [1, 'B']] as const) {
    const left = 60 + b * 560;
    sections.push({ label: `Building ${name}`, x: left, y: 290, w: 480, h: 470 });
    const d1 = `d${name}1`;
    const d2 = `d${name}2`;
    devices.push(
      { key: d1, label: `DIST-${name}1`, type: 'distribution-switch', x: left + 110, y: 340, addresses: [`203.0.113.${21 + b * 10}`] },
      { key: d2, label: `DIST-${name}2`, type: 'distribution-switch', x: left + 290, y: 340, addresses: [`203.0.113.${22 + b * 10}`] },
    );
    links.push(
      { from: 'c1', to: d1, cableType: 'fiber-sm' },
      { from: 'c2', to: d1, cableType: 'fiber-sm' },
      { from: 'c1', to: d2, cableType: 'fiber-sm' },
      { from: 'c2', to: d2, cableType: 'fiber-sm' },
    );
    for (const f of [1, 2]) {
      const acc = `a${name}${f}`;
      const ap = `ap${name}${f}`;
      const x = left + 40 + (f - 1) * 250;
      devices.push(
        { key: acc, label: `ACC-${name}-FL${f}`, type: 'access-switch', x: x + 60, y: 510, addresses: [`203.0.113.${40 + b * 10 + f}`] },
        { key: ap, label: `AP-${name}-FL${f}`, type: 'access-point', x: x + 60, y: 660 },
      );
      links.push(
        { from: d1, to: acc, label: 'Trunk', cableType: 'fiber-mm' },
        { from: d2, to: acc, label: 'Trunk', cableType: 'fiber-mm' },
        { from: acc, to: ap, sourcePort: 'Gi1/0/1', label: 'PoE', cableType: 'copper' },
      );
    }
  }
  return { sections, devices, links };
};

/** DMZ: an outer and an inner firewall with the public services between. */
const dmz = (): TemplateSpec => ({
  sections: [
    { label: 'DMZ', x: 60, y: 260, w: 700, h: 200, boundaryKind: 'security-zone', boundaryId: 'DMZ' },
    { label: 'Inside', x: 60, y: 640, w: 700, h: 200, boundaryKind: 'security-zone', boundaryId: 'Inside' },
  ],
  devices: [
    { key: 'net', label: 'Internet', type: 'internet', x: 372, y: 0 },
    { key: 'ofw', label: 'OUTER-FW', type: 'firewall', x: 372, y: 130, addresses: ['203.0.113.1'] },
    { key: 'lb', label: 'Load balancer', type: 'load-balancer', x: 120, y: 330, addresses: ['198.51.100.10'] },
    { key: 'web', label: 'Web servers', type: 'server', x: 290, y: 330, addresses: ['198.51.100.20'] },
    { key: 'mail', label: 'Mail relay', type: 'server', x: 460, y: 330, addresses: ['198.51.100.25'] },
    { key: 'waf', label: 'WAF', type: 'waf', x: 630, y: 330, addresses: ['198.51.100.30'] },
    { key: 'ifw', label: 'INNER-FW', type: 'firewall', x: 372, y: 520, addresses: ['192.0.2.1'] },
    { key: 'app', label: 'Application servers', type: 'server', x: 200, y: 710, addresses: ['192.0.2.50'] },
    { key: 'db', label: 'Database', type: 'database', x: 372, y: 710, addresses: ['192.0.2.60'] },
    { key: 'users', label: 'Staff network', type: 'endpoint', x: 544, y: 710 },
  ],
  links: [
    { from: 'net', to: 'ofw', cableType: 'wan' },
    { from: 'ofw', to: 'waf', label: 'HTTPS', sourcePort: 'dmz' },
    { from: 'waf', to: 'lb', label: 'HTTPS' },
    { from: 'lb', to: 'web', label: 'HTTP' },
    { from: 'ofw', to: 'mail', label: 'SMTP', sourcePort: 'dmz' },
    { from: 'web', to: 'ifw', label: 'App traffic only' },
    { from: 'mail', to: 'ifw', label: 'SMTP inbound' },
    { from: 'ifw', to: 'app', sourcePort: 'inside' },
    { from: 'app', to: 'db', label: 'SQL' },
    { from: 'ifw', to: 'users', sourcePort: 'inside' },
  ],
});

/** SD-WAN overlay: a hub and three branches over two transports, with the
 *  tunnels drawn dashed over the circuits that carry them. */
const sdWan = (): TemplateSpec => {
  const devices: DeviceSpec[] = [
    { key: 'orch', label: 'SD-WAN orchestrator', type: 'application', x: 180, y: 0, addresses: ['192.0.2.5'] },
    { key: 'hub', label: 'HUB-EDGE', type: 'router', x: 480, y: 0, addresses: ['192.0.2.1', 'Tunnel=198.51.100.1'] },
    { key: 'mpls', label: 'MPLS transport', type: 'mpls-cloud', x: 300, y: 250 },
    { key: 'inet', label: 'Internet transport', type: 'internet', x: 660, y: 250 },
  ];
  const links: LinkSpec[] = [
    { from: 'orch', to: 'hub', label: 'Control', lineStyle: 'dotted' },
    { from: 'hub', to: 'mpls', label: 'MPLS', cableType: 'wan' },
    { from: 'hub', to: 'inet', label: 'Internet', cableType: 'wan' },
  ];
  for (const n of [1, 2, 3]) {
    const b = `br${n}`;
    devices.push({ key: b, label: `BRANCH-${n}-EDGE`, type: 'router', x: 180 + (n - 1) * 300, y: 500, addresses: [`192.0.2.${10 + n}`, `Tunnel=198.51.100.${10 + n}`] });
    links.push(
      { from: 'mpls', to: b, cableType: 'wan' },
      { from: 'inet', to: b, cableType: 'wan' },
      { from: 'hub', to: b, label: 'Overlay tunnel', lineStyle: 'dashed' },
    );
  }
  return {
    devices,
    links,
    texts: [{ text: 'Dashed: overlay tunnels. Solid: the transports that carry them.', x: 960, y: 260, type: 'callout', w: 220, h: 80 }],
  };
};

/** MPLS L3VPN: a provider core, PEs, and two customer VRFs across sites. */
const mplsL3vpn = (): TemplateSpec => ({
  sections: [
    { label: 'Provider core', x: 180, y: 180, w: 640, h: 300, boundaryKind: 'bgp-as', boundaryId: '64500' },
  ],
  devices: [
    { key: 'pe1', label: 'PE1', type: 'router', x: 240, y: 230, addresses: ['Loopback0=203.0.113.1'] },
    { key: 'pe2', label: 'PE2', type: 'router', x: 700, y: 230, addresses: ['Loopback0=203.0.113.2'] },
    { key: 'pe3', label: 'PE3', type: 'router', x: 470, y: 380, addresses: ['Loopback0=203.0.113.3'] },
    { key: 'p1', label: 'P1', type: 'router', x: 470, y: 230, addresses: ['Loopback0=203.0.113.11'] },
    { key: 'ce1', label: 'SITE-A-CE (VRF BLUE)', type: 'router', x: 40, y: 20, addresses: ['192.0.2.1'] },
    { key: 'ce2', label: 'SITE-B-CE (VRF BLUE)', type: 'router', x: 900, y: 20, addresses: ['192.0.2.65'] },
    { key: 'ce3', label: 'SITE-C-CE (VRF GREEN)', type: 'router', x: 40, y: 580, addresses: ['198.51.100.1'] },
    { key: 'ce4', label: 'SITE-D-CE (VRF GREEN)', type: 'router', x: 900, y: 580, addresses: ['198.51.100.65'] },
  ],
  links: [
    { from: 'pe1', to: 'p1', label: 'LDP', cableType: 'fiber-sm' },
    { from: 'p1', to: 'pe2', label: 'LDP', cableType: 'fiber-sm' },
    { from: 'p1', to: 'pe3', label: 'LDP', cableType: 'fiber-sm' },
    { from: 'pe1', to: 'pe3', label: 'LDP', cableType: 'fiber-sm' },
    { from: 'pe1', to: 'pe2', label: 'MP-BGP VPNv4', lineStyle: 'dotted' },
    { from: 'ce1', to: 'pe1', label: 'eBGP AS 64510', cableType: 'wan' },
    { from: 'ce2', to: 'pe2', label: 'eBGP AS 64510', cableType: 'wan' },
    { from: 'ce3', to: 'pe1', label: 'eBGP AS 64511', cableType: 'wan' },
    { from: 'ce4', to: 'pe2', label: 'eBGP AS 64511', cableType: 'wan' },
  ],
});

/** Wireless survey: a floor with rooms, the access points placed in them with
 *  their channel and power, and what feeds them. */
const wirelessSurvey = (): TemplateSpec => ({
  sections: [
    { label: 'Floor 1', x: 0, y: 140, w: 1000, h: 600 },
    { label: 'Open office', x: 30, y: 180, w: 560, h: 330 },
    { label: 'Meeting rooms', x: 620, y: 180, w: 350, h: 330 },
    { label: 'Reception', x: 30, y: 540, w: 400, h: 170 },
    { label: 'Comms room', x: 460, y: 540, w: 510, h: 170 },
  ],
  devices: [
    { key: 'ap1', label: 'FL1-AP1', type: 'access-point', x: 140, y: 300, addresses: ['192.0.2.21'] },
    { key: 'ap2', label: 'FL1-AP2', type: 'access-point', x: 420, y: 300, addresses: ['192.0.2.22'] },
    { key: 'ap3', label: 'FL1-AP3', type: 'access-point', x: 760, y: 300, addresses: ['192.0.2.23'] },
    { key: 'ap4', label: 'FL1-AP4', type: 'access-point', x: 270, y: 590, addresses: ['192.0.2.24'] },
    { key: 'sw', label: 'FL1-SW', type: 'access-switch', x: 560, y: 590, addresses: ['192.0.2.2'] },
    { key: 'wlc', label: 'WLC', type: 'wireless-controller', x: 800, y: 590, addresses: ['192.0.2.3'] },
  ],
  links: [
    { from: 'sw', to: 'ap1', sourcePort: 'Gi1/0/1', label: 'PoE+', cableType: 'copper' },
    { from: 'sw', to: 'ap2', sourcePort: 'Gi1/0/2', label: 'PoE+', cableType: 'copper' },
    { from: 'sw', to: 'ap3', sourcePort: 'Gi1/0/3', label: 'PoE+', cableType: 'copper' },
    { from: 'sw', to: 'ap4', sourcePort: 'Gi1/0/4', label: 'PoE+', cableType: 'copper' },
    { from: 'sw', to: 'wlc', sourcePort: 'Te1/1/1', label: 'Trunk', cableType: 'fiber-mm' },
  ],
  texts: [
    { text: 'Survey: floor plan, AP placement, channel and power', x: 0, y: 40, w: 460, h: 44 },
    { text: 'Ch 1 / 36 · 14 dBm', x: 98, y: 440, type: 'callout', w: 160, h: 44 },
    { text: 'Ch 6 / 52 · 14 dBm', x: 378, y: 440, type: 'callout', w: 160, h: 44 },
    { text: 'Ch 11 / 100 · 11 dBm', x: 713, y: 440, type: 'callout', w: 170, h: 44 },
    { text: 'Ch 1 / 149 · 11 dBm', x: 60, y: 606, type: 'callout', w: 160, h: 44 },
  ],
});

/** Rack elevation: two racks drawn on the diagram and in the Racks tab —
 *  patch panels and switches at the top, servers and storage below, power at
 *  the bottom, a cable manager on the rear. */
const rackElevation = (): TemplateSpec => {
  const A = 'RACK-A01';
  const B = 'RACK-A02';
  return {
    racks: [
      { name: A, units: 42 },
      { name: B, units: 42 },
    ],
    sections: [
      { label: A, x: 0, y: 120, w: 420, h: 560 },
      { label: B, x: 460, y: 120, w: 420, h: 560 },
    ],
    devices: [
      { key: 'fw', label: 'FW-01', type: 'firewall', x: 402, y: 0, addresses: ['192.0.2.1'] },
      { key: 'ppa', label: 'PP-A01', type: 'patch-panel', x: 40, y: 170, rack: { name: A, u: 42, units: 1, depth: 'half' } },
      { key: 'swa', label: 'SW-A01', type: 'access-switch', x: 180, y: 170, addresses: ['192.0.2.11'], rack: { name: A, u: 41, units: 1 } },
      { key: 'cma', label: 'Cable manager', type: 'generic', x: 300, y: 170, rack: { name: A, u: 42, units: 1, face: 'rear', depth: 'half' } },
      { key: 'srv1', label: 'SRV-01', type: 'server', x: 40, y: 330, addresses: ['192.0.2.21'], rack: { name: A, u: 30, units: 2 } },
      { key: 'srv2', label: 'SRV-02', type: 'server', x: 180, y: 330, addresses: ['192.0.2.22'], rack: { name: A, u: 28, units: 2 } },
      { key: 'host', label: 'HOST-01', type: 'vm-host', x: 300, y: 330, addresses: ['192.0.2.23'], rack: { name: A, u: 25, units: 2 } },
      { key: 'upsa', label: 'UPS-A', type: 'ups', x: 110, y: 510, rack: { name: A, u: 1, units: 2 } },
      { key: 'pdua', label: 'PDU-A', type: 'pdu', x: 250, y: 510 },
      { key: 'ppb', label: 'PP-A02', type: 'patch-panel', x: 500, y: 170, rack: { name: B, u: 42, units: 1, depth: 'half' } },
      { key: 'swb', label: 'SW-A02', type: 'access-switch', x: 640, y: 170, addresses: ['192.0.2.12'], rack: { name: B, u: 41, units: 1 } },
      { key: 'stor', label: 'STORAGE-01', type: 'storage', x: 520, y: 330, addresses: ['192.0.2.31'], rack: { name: B, u: 20, units: 2 } },
      { key: 'blade', label: 'BLADE-01', type: 'blade-chassis', x: 700, y: 330, addresses: ['192.0.2.41'], rack: { name: B, u: 8, units: 10 } },
      { key: 'upsb', label: 'UPS-B', type: 'ups', x: 640, y: 510, rack: { name: B, u: 1, units: 2 } },
    ],
    links: [
      { from: 'fw', to: 'swa', sourcePort: 'port1', targetPort: 'Te1/1/1', cableType: 'fiber-mm', label: 'C-0001' },
      { from: 'fw', to: 'swb', sourcePort: 'port2', targetPort: 'Te1/1/1', cableType: 'fiber-mm', label: 'C-0002' },
      { from: 'swa', to: 'ppa', sourcePort: 'Gi1/0/1', targetPort: '1', cableType: 'copper', label: 'C-0003' },
      { from: 'swa', to: 'srv1', sourcePort: 'Gi1/0/10', targetPort: 'NIC 1', cableType: 'copper', label: 'C-0004' },
      { from: 'swa', to: 'srv2', sourcePort: 'Gi1/0/11', targetPort: 'NIC 1', cableType: 'copper', label: 'C-0005' },
      { from: 'swa', to: 'host', sourcePort: 'Gi1/0/12', targetPort: 'NIC 1', cableType: 'copper', label: 'C-0006' },
      { from: 'swb', to: 'ppb', sourcePort: 'Gi1/0/1', targetPort: '1', cableType: 'copper', label: 'C-0007' },
      { from: 'swb', to: 'stor', sourcePort: 'Te1/1/2', targetPort: 'Port 1', cableType: 'fiber-mm', label: 'C-0008' },
      { from: 'swb', to: 'blade', sourcePort: 'Te1/1/3', targetPort: 'Uplink 1', cableType: 'fiber-mm', label: 'C-0009' },
    ],
    texts: [{ text: 'Open the Racks tab to see these racks front and rear.', x: 900, y: 140, type: 'callout', w: 200, h: 64 }],
  };
};

export interface Template {
  id: string;
  name: string;
  description: string;
  build: () => ProjectDocument;
}

export const TEMPLATES: Template[] = [
  { id: 'blank', name: 'Blank', description: 'An empty page.', build: emptyDocument },
  { id: 'branch-office', name: 'Branch office', description: 'Two circuits, a firewall, one switch, wireless, phones and printers.', build: () => build(branchOffice()) },
  { id: 'spine-leaf', name: 'Data centre spine-leaf', description: 'Two spines, four leaves, a border leaf pair and a firewall.', build: () => build(spineLeaf()) },
  { id: 'campus', name: 'Campus three-tier', description: 'A core pair, distribution pairs in two buildings, access and APs.', build: () => build(campus()) },
  { id: 'dmz', name: 'DMZ', description: 'Outer and inner firewalls with the public services between them.', build: () => build(dmz()) },
  { id: 'sd-wan', name: 'SD-WAN overlay', description: 'A hub and three branches over MPLS and internet, tunnels on top.', build: () => build(sdWan()) },
  { id: 'mpls-l3vpn', name: 'MPLS L3VPN', description: 'A provider core with PE and P routers and two customer VRFs.', build: () => build(mplsL3vpn()) },
  { id: 'wireless-survey', name: 'Wireless survey', description: 'A floor with rooms, AP placement, channels and power.', build: () => build(wirelessSurvey()) },
  { id: 'rack-elevation', name: 'Rack elevation', description: 'Two racks of switches, servers, storage and power, placed by U front and rear, with a cable schedule.', build: () => build(rackElevation()) },
];

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
