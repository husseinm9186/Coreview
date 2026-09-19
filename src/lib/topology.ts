/**
 * Turning a crawl into a drawn topology.
 *
 * Discovery already knows who is plugged into what: every reached device
 * reports its neighbours with the port at each end. The interface used to
 * throw that away and lay the devices out in a grid with no links, which is a
 * list of devices arranged in rows, not a diagram. This builds the diagram —
 * nodes joined by the adjacencies that were discovered, each link labelled
 * with the interface at both ends.
 *
 * Pure, so the identity, de-duplication and layout rules can be tested without
 * a network or a browser.
 */
import type {
  AttachedDevice,
  CrawledDevice,
  DeviceClassName,
  Neighbor,
  StackInfo,
} from './ipc';
import { chooseHandles } from './routeLinks';
import type { TopoEdge, TopoNode } from '../state/store';
import type { DeviceInventory, DeviceNodeData, DeviceType, LinkData } from '../types/domain';
import { inventoryOf } from './inventory';
import { inferRoles, ROLE_LABEL, ROLE_TYPE, type InferredRole } from './roles';
import { uid } from './id';
import { mergeSerials } from './serials';

/** The glyph each discovered class is drawn with. */
export const CLASS_GLYPH: Record<DeviceClassName, DeviceType> = {
  router: 'router',
  switch: 'core-switch',
  firewall: 'firewall',
  'wireless-controller': 'wireless-controller',
  'access-point': 'access-point',
  // These two were 'endpoint-client' and 'camera-iot', which are not device
  // types. They passed a cast and fell back to the generic box, so every phone
  // and camera on a discovered diagram was drawn as an anonymous rectangle.
  phone: 'endpoint',
  camera: 'camera',
  printer: 'printer',
  server: 'server',
  endpoint: 'endpoint',
  unknown: 'generic',
};


/**
 * The short form of an interface name, as a diagram writes it.
 *
 * CDP reports `GigabitEthernet0/1` and LLDP reports `Gi0/1` for the same port,
 * so a diagram built from both is inconsistent as well as cramped — five long
 * names leaving one switch overlap each other whatever else is done about
 * spacing. The full name is kept on the link's notes, not thrown away.
 */
export function shortInterface(name: string): string {
  const trimmed = name.trim();
  // Longest first: TenGigabitEthernet must not match the Ethernet rule.
  const forms: [RegExp, string][] = [
    [/^TwentyFiveGigE/i, 'Twe'],
    [/^TenGigabitEthernet/i, 'Te'],
    [/^HundredGigE/i, 'Hu'],
    [/^FortyGigabitEthernet/i, 'Fo'],
    [/^GigabitEthernet/i, 'Gi'],
    [/^FastEthernet/i, 'Fa'],
    [/^Port-channel/i, 'Po'],
    [/^TenGigE/i, 'Te'],
    // NX-OS writes its own ports as Eth1/1, and on Nexus every port is an
    // "Ethernet" whatever its speed, so this is the common case rather than
    // the ancient 10Mb one.
    [/^Ethernet/i, 'Eth'],
    [/^Vlan/i, 'Vl'],
    [/^mgmt/i, 'mgmt'],
    [/^Loopback/i, 'Lo'],
  ];
  for (const [pattern, prefix] of forms) {
    if (pattern.test(trimmed)) return trimmed.replace(pattern, prefix);
  }
  return trimmed;
}

export interface TopologySource {
  /** Devices that were logged into. These carry the adjacencies. */
  devices: CrawledDevice[];
  /** Seen as a neighbour but never visited — phones, printers, endpoints. */
  notVisited: Neighbor[];
}

export interface TopologyOptions {
  /** Classes to place. Empty or omitted means everything discovered. */
  include?: DeviceClassName[];
  /** Top-left of the block to lay out in. */
  origin?: { x: number; y: number };
  /** Only reached devices get a probe by default: a crawl of a large flat
   *  network can see hundreds of endpoints, and monitoring all of them is a
   *  decision rather than a side effect of drawing them. */
  probeReachedOnly?: boolean;
  /** What is already drawn. A device found again is the same device: it keeps
   *  its node, and with it the position someone put it in. Without this a
   *  second crawl draws the whole network again beside the first, which makes
   *  discovery a thing you do once. */
  existingNodes?: TopoNode[];
  /** Links already drawn, so a cable found again is not drawn twice. */
  existingEdges?: TopoEdge[];
  /** Silent devices to place, each linked to the port it was learned on.
   *  Nothing is drawn unless it was asked for: a flat /24 can hold two
   *  hundred of these and drawing them all buries the topology. */
  attached?: { device: AttachedDevice; host: string }[];
  /** LT-215: the page's Physical and Logical views, by id. Cabled links go on
   *  the first; layer-3 hops between crawled devices are drawn only when the
   *  second exists, and go on it. */
  views?: { physical?: string; logical?: string };
  /** When the crawl ran, stamped on each device's inventory (LT-200–204).
   *  Defaults to now. */
  collectedAt?: number;
}

export interface BuiltTopology {
  /** Devices not already on the diagram. */
  nodes: TopoNode[];
  /** Links not already on the diagram. */
  edges: TopoEdge[];
  /** LT-216: every link this crawl found, new or already drawn, by the same
   *  signature `edgeSignature` gives a drawn link — so a reconcile can tell
   *  which drawn links the crawl no longer confirms. */
  seenLinks: Set<string>;
  /** Devices already drawn, with what the crawl now knows about them. Their
   *  positions are deliberately absent: the operator arranged those. */
  updated: { id: string; data: Partial<DeviceNodeData> }[];
  /** Adjacencies dropped because one end was filtered out. */
  danglingLinks: number;
}

/**
 * The node already drawn for a device, matched on anything it is known by.
 *
 * The same rule the crawl uses (LT-126/LT-133), exported so the *sweep* can
 * use it too — LT-141 was the sweep not asking this question at all and
 * laying a second block of boxes over the network already on the page.
 *
 * Strongest first: a MAC is assigned once at the factory, an address is lent
 * out by DHCP, a name is whatever somebody typed.
 */
export function findDrawnNode(
  existing: TopoNode[],
  by: { mac?: string | null; address?: string | null; name?: string | null },
): string | undefined {
  const wanted: string[] = [];
  const mac = macKey(by.mac);
  if (mac) wanted.push(`m:${mac}`);
  const address = by.address?.trim();
  if (address) wanted.push(`a:${address}`);
  const name = by.name?.trim();
  if (name) {
    const own = identity(name, '');
    if (own !== 'a:') wanted.push(own);
  }
  if (wanted.length === 0) return undefined;

  const index = new Map<string, string>();
  for (const n of existing) {
    for (const key of identitiesOfNode(n)) {
      if (!index.has(key)) index.set(key, n.id);
    }
  }
  for (const key of wanted) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return undefined;
}

/** How an already-drawn node is recognised as a device found again. */
function identityOfNode(n: TopoNode): string | null {
  if (n.type !== 'device') return null;
  const d = n.data as DeviceNodeData;
  const address = d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address ?? '';
  return identity(d.label ?? '', address);
}

/** Two links are the same cable if they join the same pair on the same ports. */
export function edgeSignature(e: TopoEdge, idOf: (nodeId: string) => string): string {
  const d = (e.data ?? {}) as LinkData;
  return [
    `${idOf(e.source)}/${shortInterface(d.sourcePortLabel ?? '')}`,
    `${idOf(e.target)}/${shortInterface(d.targetPortLabel ?? '')}`,
  ]
    .sort()
    .join('::');
}

/**
 * Which chassis of a pair a port is on (LT-140).
 *
 * Cisco numbers an interface by the member it lives on, so
 * `HundredGigE1/0/25` is chassis 1 and `TenGigabitEthernet2/0/1` is chassis 2.
 * That is the only non-guesswork way to say which half of a StackWise Virtual
 * or VSS pair a downstream link actually lands on, and the crawl already
 * records the interface at both ends of every link.
 *
 * `null` where the name carries no member number — a `Port 4` on a small
 * switch, or an Aruba `lag1`. Those are placed on the first chassis rather
 * than at random, and the caller says so.
 */
export function chassisOfPort(iface: string | null | undefined): string | null {
  if (!iface) return null;
  // The number immediately before the first slash: Gi1/0/5 -> 1.
  const m = /(\d+)\/\d+/.exec(iface);
  return m?.[1] ?? null;
}

/**
 * What a stack puts on a device (LT-148).
 *
 * One line per member — number, role and **serial** — because a stack is one
 * device on a diagram and several boxes an RMA is raised against, so each
 * member has to keep its own number. A pair whose members report no serial
 * still lists them, because "two chassis and I could not read their serials"
 * is a different and more useful statement than nothing at all.
 */
export function stackFields(stack: StackInfo | null | undefined): Partial<DeviceNodeData> {
  if (!stack || stack.members.length === 0) return {};
  return {
    stackKind: STACK_KIND_LABEL[stack.kind] ?? stack.kind,
    stackMembers: stack.members
      .map((m) => [m.id, m.role, m.serial].filter(Boolean).join(' '))
      .join('\n'),
    stackUnverified: stack.unverified,
  };
}

/** The words to show for each technology, matching what the vendors call them. */
const STACK_KIND_LABEL: Record<string, string> = {
  'stack-wise': 'StackWise',
  'stack-wise-virtual': 'StackWise Virtual',
  vss: 'VSS',
  vsf: 'VSF',
  vsx: 'VSX',
  'virtual-chassis': 'Virtual Chassis',
  'vendor-stack': 'Stack',
  'forti-link-stack': 'FortiLink stack',
};

/** A label that is really an address. Not a name, so it must not be cut at
 *  the first dot — see `identity`. */
function looksLikeAddress(name: string): boolean {
  const parts = name.split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => p.length > 0 && p.length <= 3 && /^\d+$/.test(p) && Number(p) <= 255)
  );
}

/** A name that is really just a MAC, which is no name at all on a diagram. */
function looksLikeMac(name: string): boolean {
  const hex = name.replace(/[^0-9a-fA-F]/g, '');
  return hex.length === 12 && /[.:-]/.test(name);
}

/**
 * A MAC reduced to the twelve hex digits, so the spellings agree.
 *
 * Cisco writes `7456.3c00.0001`, the sweep reads `74:56:3c:00:00:01` out of
 * the ARP table, and Windows writes `74-56-3C-00-00-01`. They are one
 * address, and matching them as written is why a swept host and the port a
 * switch learned it on never recognised each other.
 */
export function macKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex.length === 12 ? hex : null;
}

/**
 * Every key a drawn node can be recognised by, strongest first (LT-126).
 *
 * One key was never enough. A sweep places a host it knows by name and
 * address; a crawl meets the same host as a MAC on a switch port and knows
 * neither. Keyed on a single canonical string the two never meet, so the
 * crawl drew a second box and left the first floating — the "disconnected"
 * the operator reported.
 *
 * Order is precedence, and it matters: a MAC is assigned once at the factory,
 * an address is lent out by DHCP, and a name is whatever somebody typed.
 */
export function identitiesOfNode(n: TopoNode): string[] {
  if (n.type !== 'device') return [];
  const d = n.data as DeviceNodeData;
  const keys: string[] = [];
  const mac = macKey(d.mac);
  if (mac) keys.push(`m:${mac}`);
  for (const a of d.addresses ?? []) {
    const address = a.address?.trim();
    if (address) keys.push(`a:${address}`);
  }
  const own = identity(d.label ?? '', '');
  // `a:` with nothing after it is the "no name and no address" case, which
  // identifies nothing and would match every other such node.
  if (own !== 'a:') keys.push(own);
  return keys;
}

/**
 * The identity two sightings of the same device have to agree on.
 *
 * CDP reports a device as `SW1.example.com`, LLDP as `SW1`, and the device's
 * own prompt as `sw1`. Without folding those together the same switch appears
 * three times with a third of its links each.
 */
export function identity(name: string, address: string): string {
  const trimmed = name.trim();
  // LT-132: an address has dots too, and cutting at the first one turned
  // every swept host on a subnet into `n:192` — one identity for the lot.
  // A sweep that found no name labels the node with the address, so this is
  // the common case, not a corner of one. It keys on the address instead.
  if (looksLikeAddress(trimmed)) return `a:${trimmed}`;
  // Cutting at the first dot removes a domain suffix — and mangles a MAC.
  // `7456.3c00.0001` becomes `7456`, which every device from that vendor
  // shares, so a network full of one maker's kit collapsed into one node.
  const short = (looksLikeMac(trimmed) ? trimmed : (trimmed.split('.')[0] ?? '')).toLowerCase();
  // A name that is really a serial or an empty string is no identity at all;
  // the address is the better key then.
  return short && short !== 'unknown' ? `n:${short}` : `a:${address.trim()}`;
}

interface Entry {
  key: string;
  name: string;
  vendor?: string | null;
  address: string;
  klass: DeviceClassName;
  platform: string | null;
  /** The chassis serial, where a device gave one away — CDP carries it in
   *  brackets after the device id. The number an RMA and a support contract
   *  are keyed on, so it is worth landing on the diagram. */
  serial?: string | null;
  /** What the device said it is running (LT-146). */
  osVersion?: string | null;
  /** What holds several boxes together, where this is not one box (LT-148). */
  stack?: StackInfo | null;
  /** Its ports, VLANs, routes and spanning tree (LT-200–204). */
  inventory?: DeviceInventory;
  /** LT-206: its PTR name. */
  dnsName?: string | null;
  /** LT-214: the part it plays, and why that was decided. */
  role?: InferredRole;
  /** How it was reached, in words an operator reads. */
  via?: string | null;
  reached: boolean;
  depth: number;
}

/** One end of a discovered link. */
interface LinkEnd {
  key: string;
  iface: string;
}

function linkKey(a: LinkEnd, b: LinkEnd): string {
  // Sorted, so the same cable reported from both ends collapses to one link.
  // The interface is part of the key: two switches joined by two cables are
  // two links, and dropping the interface would silently merge them.
  const ends = [`${a.key}/${a.iface}`, `${b.key}/${b.iface}`].sort();
  return ends.join('::');
}

export function buildTopology(
  src: TopologySource,
  projectId: string,
  opts: TopologyOptions = {},
): BuiltTopology {
  const include = opts.include?.length ? new Set(opts.include) : null;
  const origin = opts.origin ?? { x: 80, y: 80 };

  const entries = new Map<string, Entry>();
  const note = (e: Entry) => {
    const seen = entries.get(e.key);
    // A reached device knows more about itself than a neighbour's report of
    // it, so it wins; otherwise keep the first sighting and fill in blanks.
    if (!seen) entries.set(e.key, e);
    else if (e.reached && !seen.reached) entries.set(e.key, { ...e, depth: Math.min(e.depth, seen.depth) });
    else {
      if (!seen.address && e.address) seen.address = e.address;
      if (seen.klass === 'unknown' && e.klass !== 'unknown') seen.klass = e.klass;
      if (!seen.platform && e.platform) seen.platform = e.platform;
      if (!seen.vendor && e.vendor) seen.vendor = e.vendor;
      // Union, not first-wins. The same stack can arrive twice from two
      // different neighbours, each advertising a different member's serial,
      // and both are true — keeping the first would name one switch in a
      // stack of four and look complete doing it.
      seen.serial = mergeSerials(seen.serial, e.serial) ?? null;
      seen.depth = Math.min(seen.depth, e.depth);
    }
  };

  const roles = inferRoles(src.devices);
  for (const d of src.devices) {
    note({
      role: roles.get(d.hostname.trim().toLowerCase()),
      key: identity(d.hostname, d.address),
      name: d.hostname || d.address,
      address: d.probeTarget || d.address,
      klass: d.class,
      platform: d.platform,
      serial: d.serial,
      // LT-146: what it runs and how it answered, so both reach the device.
      osVersion: d.version,
      // LT-148: the members and their serials, so a stack can be looked at.
      stack: d.stack,
      inventory: inventoryOf(d, opts.collectedAt ?? Date.now()),
      dnsName: d.dnsName,
      via:
        d.reachedBy === 'ssh'
          ? 'Logged in'
          : d.reachedBy === 'snmp'
            ? 'SNMP'
            : 'Seen by a neighbour',
      reached: true,
      depth: d.hops,
    });
  }

  // Neighbours, from the devices that reported them and from the leftovers.
  const fromNeighbor = (n: Neighbor, depth: number): Entry => ({
    key: identity(n.shortName || n.deviceId, n.addresses[0]?.ip ?? ''),
    name: n.shortName || n.deviceId,
    vendor: n.vendor,
    address: n.addresses[0]?.ip ?? '',
    klass: n.class,
    platform: n.platform,
    serial: n.serial,
    reached: false,
    depth,
  });
  for (const d of src.devices) for (const n of d.neighbors) note(fromNeighbor(n, d.hops + 1));
  for (const n of src.notVisited) note(fromNeighbor(n, 1));

  // Which bundle each member port belongs to, per device (LT-009). Two
  // switches joined by two cables in a LAG are one logical link, and a
  // diagram that draws two says there are two failure domains where there is
  // one. Observation, not inference: this is the switch's own etherchannel
  // table, which is what D-014 asked for instead of guessing from port
  // numbers.
  const bundleOf = new Map<string, Map<string, { name: string; members: string[] }>>();
  for (const d of src.devices) {
    const key = identity(d.hostname, d.address);
    const map = new Map<string, { name: string; members: string[] }>();
    for (const pc of d.portChannels ?? []) {
      for (const m of pc.members) map.set(shortInterface(m), { name: pc.name, members: pc.members });
    }
    if (map.size) bundleOf.set(key, map);
  }

  // Links, before filtering, so a dropped endpoint can be counted.
  const links = new Map<string, { a: LinkEnd; b: LinkEnd; viaBundle?: string[] }>();
  for (const d of src.devices) {
    const from = identity(d.hostname, d.address);
    for (const n of d.neighbors) {
      const to = identity(n.shortName || n.deviceId, n.addresses[0]?.ip ?? '');
      if (to === from) continue;
      // A cable folds into a bundle when either end's table says its port
      // is aggregated — either, because a crawl often reaches only one of
      // the two switches, and the reached one's table must also fold the
      // unreached side's raw reports or the diagram draws the LAG twice.
      // Where only one table answered, its bundle name stands in for both
      // ends, which is also what keeps the two directions collapsing to one
      // key.
      const nearBundle = bundleOf.get(from)?.get(shortInterface(n.localInterface ?? ''));
      const farBundle = bundleOf.get(to)?.get(shortInterface(n.remoteInterface ?? ''));
      const bundle = nearBundle ?? farBundle;
      if (bundle) {
        const end = {
          a: { key: from, iface: nearBundle?.name ?? bundle.name },
          b: { key: to, iface: farBundle?.name ?? bundle.name },
          viaBundle: bundle.members,
        };
        links.set(linkKey(end.a, end.b), end);
        continue;
      }
      const end: { a: LinkEnd; b: LinkEnd } = {
        a: { key: from, iface: n.localInterface ?? '' },
        b: { key: to, iface: n.remoteInterface ?? '' },
      };
      links.set(linkKey(end.a, end.b), end);
    }
  }

  // One more fold, by address. A switch reached over SNMP reports its sysName,
  // which is not always the name it advertises over LLDP — "sw1" against
  // "SW1.corp.local" folds already, but "LAB-ACC-SW" against "USW-Lite-8-PoE"
  // does not, and the same device would be drawn twice. Two things holding one
  // address are one thing.
  const byAddress = new Map<string, string>();
  const merged = new Map<string, string>();
  for (const e of [...entries.values()].sort((a, b) => Number(b.reached) - Number(a.reached))) {
    if (!e.address) continue;
    const seen = byAddress.get(e.address);
    if (seen === undefined) {
      byAddress.set(e.address, e.key);
      continue;
    }
    // Keep the entry that was actually reached; it knows more about itself.
    merged.set(e.key, seen);
    const keep = entries.get(seen);
    const drop = entries.get(e.key);
    if (keep && drop) {
      if (keep.klass === 'unknown' && drop.klass !== 'unknown') keep.klass = drop.klass;
      if (!keep.platform && drop.platform) keep.platform = drop.platform;
      if (!keep.vendor && drop.vendor) keep.vendor = drop.vendor;
      keep.depth = Math.min(keep.depth, drop.depth);
    }
    entries.delete(e.key);
  }
  // Links pointed at a folded entry follow it, or they dangle against a node
  // that is no longer there.
  if (merged.size > 0) {
    const follow = (k: string) => merged.get(k) ?? k;
    const rebuilt = new Map<string, { a: LinkEnd; b: LinkEnd }>();
    for (const { a, b } of links.values()) {
      const end = {
        a: { key: follow(a.key), iface: a.iface },
        b: { key: follow(b.key), iface: b.iface },
      };
      if (end.a.key === end.b.key) continue;
      rebuilt.set(linkKey(end.a, end.b), end);
    }
    links.clear();
    for (const [k, v] of rebuilt) links.set(k, v);
  }

  // LT-131: which way is out, per device. Collected before layout because
  // the link loop below needs it, and keyed by address because that is what
  // a default route names — a next hop is an address, not a hostname.
  const nextHopOf = new Map<string, string>();
  for (const d of src.devices) {
    const hop = d.defaultNextHop;
    if (!hop) continue;
    nextHopOf.set(identity(d.hostname, d.address), hop.trim());
  }
  /** The entry that owns an address, so a next hop can name a device. */
  const ownerOfAddress = new Map<string, string>();
  for (const d of src.devices) {
    const key = identity(d.hostname, d.address);
    for (const a of [d.address, ...(d.addresses ?? []).map((x) => x.ip)]) {
      const ip = a?.trim();
      if (ip && !ownerOfAddress.has(ip)) ownerOfAddress.set(ip, key);
    }
  }

  const placed = [...entries.values()].filter((e) => !include || include.has(e.klass));
  const placedKeys = new Set(placed.map((e) => e.key));

  // A device already on the diagram is the same device found again. It keeps
  // its node and its position; only what the crawl newly knows is written.
  const alreadyDrawn = new Map<string, string>();
  /** What that node already carries, for the fields that merge rather than
   *  overwrite — a serial list being the one that must. */
  const alreadyDrawnData = new Map<string, DeviceNodeData>();
  for (const n of opts.existingNodes ?? []) {
    const key = identityOfNode(n);
    if (key) {
      alreadyDrawn.set(key, n.id);
      alreadyDrawnData.set(key, n.data as DeviceNodeData);
    }
  }

  // LT-126: the same nodes again, indexed by *every* identifier they carry
  // rather than by the one canonical key. This is what lets a device the
  // sweep placed be recognised as the device a switch reports on a port.
  // First writer wins, so an earlier node is never stolen by a later one
  // that happens to share an address.
  const drawnByAnyKey = new Map<string, string>();
  const drawnDataById = new Map<string, DeviceNodeData>();
  for (const n of opts.existingNodes ?? []) {
    drawnDataById.set(n.id, n.data as DeviceNodeData);
    for (const key of identitiesOfNode(n)) {
      if (!drawnByAnyKey.has(key)) drawnByAnyKey.set(key, n.id);
    }
  }
  /** The node already drawn for any of these identifiers, if there is one. */
  const findDrawn = (keys: (string | null)[]): string | undefined => {
    for (const key of keys) {
      if (!key) continue;
      const hit = drawnByAnyKey.get(key);
      if (hit) return hit;
    }
    return undefined;
  };

  // Layered by how far each device is from the seed, which is the shape a
  // network actually has. The old grid said nothing about the topology.
  const byDepth = new Map<number, Entry[]>();
  for (const e of placed) {
    const row = byDepth.get(e.depth) ?? [];
    row.push(e);
    byDepth.set(e.depth, row);
  }
  const widest = Math.max(1, ...[...byDepth.values()].map((r) => r.length));
  const COL = 240;
  const ROW = 210;

  const nodeFor = new Map<string, string>();
  const nodes: TopoNode[] = [];
  const edgesFromAttached: TopoEdge[] = [];
  const updated: { id: string; data: Partial<DeviceNodeData> }[] = [];
  for (const [depth, row] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    row.sort((a, b) => a.name.localeCompare(b.name));
    // Each row centred against the widest, so the diagram reads as a tree
    // rather than everything crammed to the left.
    const indent = ((widest - row.length) * COL) / 2;
    row.forEach((e, i) => {
      // LT-133: the same multi-key lookup the attached devices got in LT-126.
      // Keyed on one canonical string, `LAB-CORE-SW1` never recognised the
      // `192.168.77.7` a sweep had already drawn, so the crawl kept both --
      // which is the "disconnected" diagram, reported twice.
      const seen =
        alreadyDrawn.get(e.key) ??
        findDrawn([e.key, e.address ? `a:${e.address}` : null, identity(e.name, '')]);
      if (seen) {
        nodeFor.set(e.key, seen);
        // Only what a crawl can newly establish. The label is left alone: a
        // name someone corrected by hand should not be overwritten by the one
        // a neighbour advertises.
        const patch: Partial<DeviceNodeData> = {};
        if (e.address) {
          patch.addresses = [
            { id: uid(), label: 'Discovered', address: e.address, isPrimary: true },
          ];
        }
        if (e.platform) patch.model = e.platform;
        // LT-146: the OS the device reported and how it was reached. Both
        // were known and both were thrown away.
        //
        // The hostname too, and it earns its place twice over: the label is
        // deliberately left alone so a name someone corrected survives a
        // re-crawl, which means a switch the sweep drew as `192.168.77.7`
        // has the crawl's name nowhere — and `switchPort` on the hosts
        // hanging off it names it `ACC-SW1`. Without this the two never meet
        // and the layout cannot tell what is plugged into what (LT-145).
        if (e.name && !looksLikeAddress(e.name)) patch.hostname = e.name;
        if (e.osVersion) patch.osVersion = e.osVersion;
        Object.assign(patch, stackFields(e.stack));
        if (e.inventory) patch.inventory = e.inventory;
        if (e.dnsName) patch.dnsName = e.dnsName;
        // LT-214: a role only where nobody has written one; the glyph a person
        // chose is left alone.
        if (e.role && !(drawnDataById.get(seen)?.role ?? alreadyDrawnData.get(e.key)?.role)) {
          patch.role = ROLE_LABEL[e.role.role];
          patch.roleEvidence = e.role.reasons.join('; ');
        }
        if (e.via) patch.discoveredVia = e.via;
        // Merged with whatever is already on the node, so a re-crawl that
        // reaches a stack through a different neighbour adds a member rather
        // than replacing the one already recorded.
        if (e.serial) {
          // By node id, because the node may have been found by an address or
          // a name rather than by this entry's own key.
          const already = drawnDataById.get(seen)?.serial ?? alreadyDrawnData.get(e.key)?.serial;
          patch.serial = mergeSerials(already, e.serial);
        }
        if (Object.keys(patch).length > 0) updated.push({ id: seen, data: patch });
        return;
      }
      const id = uid();
      nodeFor.set(e.key, id);
      // "Ubiquiti device" beats "7456.3c00.0001" on a diagram. The identity
      // key stays the MAC, so two devices from the same maker remain two
      // devices — only what is drawn changes.
      const label = looksLikeMac(e.name) && e.vendor ? `${e.vendor} device` : e.name;
      const data: DeviceNodeData = {
        label,
        // LT-214: a role, where the evidence decided one, draws with its own
        // glyph, so arranging top to bottom (LT-145) puts it on its row.
        deviceType: e.role ? ROLE_TYPE[e.role.role] : (CLASS_GLYPH[e.klass] ?? 'generic'),
        tags: [e.reached ? 'discovered' : 'seen-only'],
        ...(e.role ? { role: ROLE_LABEL[e.role.role], roleEvidence: e.role.reasons.join('; ') } : {}),
        addresses: e.address
          ? [{ id: uid(), label: 'Discovered', address: e.address, isPrimary: true }]
          : [],
        locked: false,
        maintenance: false,
        showDetails: true,
        ...(e.platform ? { model: e.platform } : e.vendor ? { model: e.vendor } : {}),
        ...(e.serial ? { serial: e.serial } : {}),
        ...(e.osVersion ? { osVersion: e.osVersion } : {}),
        ...(e.via ? { discoveredVia: e.via } : {}),
        ...stackFields(e.stack),
        ...(e.inventory ? { inventory: e.inventory } : {}),
        ...(e.dnsName ? { dnsName: e.dnsName } : {}),
        // The name the network gave it, kept apart from a label someone may
        // rename — the same field a re-crawl writes (LT-146), so finding it
        // again is not reported as a change (LT-216).
        ...(e.name && !looksLikeAddress(e.name) && !looksLikeMac(e.name) ? { hostname: e.name } : {}),
      };
      nodes.push({
        id,
        type: 'device',
        position: { x: origin.x + indent + i * COL, y: origin.y + depth * ROW },
        width: 176,
        height: 96,
        data,
      } as TopoNode);
    });
  }

  // ---------------------------------------------------------------- LT-140
  //
  // A StackWise Virtual or VSS pair answers on one address with one hostname,
  // so everything above has drawn it as one node. It is two chassis, and the
  // whole reason it exists is that either can fail — so it is split here, and
  // the inter-switch link drawn between the halves.
  //
  // VSX and a FortiSwitch MCLAG pair are *not* split: each half is its own
  // SSH target, so a crawl already reached them as two devices. Splitting
  // those would invent two more.
  const splitInto = new Map<string, { first: string; byChassis: Map<string, string> }>();
  for (const d of src.devices) {
    const stack = d.stack;
    if (!stack || stack.kind === 'vsx' || stack.kind === 'forti-link-stack') continue;
    if (stack.members.length < 2) continue;
    // Only the one-management-plane pairs need splitting.
    if (stack.kind !== 'stack-wise-virtual' && stack.kind !== 'vss') continue;

    const key = identity(d.hostname, d.address);
    const drawnId = nodeFor.get(key);
    if (!drawnId) continue;
    const anchor = nodes.find((n) => n.id === drawnId);
    if (!anchor) continue;

    const byChassis = new Map<string, string>();
    // The node already drawn becomes the first member, keeping its position
    // and anything the operator has done to it.
    byChassis.set(stack.members[0]!.id, drawnId);
    const base = anchor.data as DeviceNodeData;
    anchor.data = {
      ...base,
      label: `${base.label} (${stack.members[0]!.id})`,
      stackSplit: true,
      notes: [base.notes, `${stack.kind.toUpperCase()} member ${stack.members[0]!.id}`]
        .filter(Boolean)
        .join(' — '),
    } as DeviceNodeData;

    for (const [i, member] of stack.members.slice(1).entries()) {
      const id = uid();
      byChassis.set(member.id, id);
      nodes.push({
        id,
        type: 'device',
        position: { x: anchor.position.x + (i + 1) * 260, y: anchor.position.y },
        width: anchor.width,
        height: anchor.height,
        data: {
          ...base,
          label: `${base.label} (${member.id})`,
          stackSplit: true,
          // The second chassis is not reachable at the pair's address: the
          // pair answers on one. Giving it the same address would put two
          // probes on one box and call a dead chassis healthy.
          addresses: [],
          notes: `${stack.kind.toUpperCase()} member ${member.id}`,
          ...(member.serial ? { serial: member.serial } : {}),
        } as DeviceNodeData,
      } as TopoNode);

      // The link that makes it a pair rather than two switches.
      edgesFromAttached.push({
        id: uid(),
        source: drawnId,
        target: id,
        sourceHandle: 'r',
        targetHandle: 'l',
        type: 'live',
        data: {
          sourcePortLabel: '',
          targetPortLabel: '',
          label: stack.interSwitchLink ?? 'ISL',
          notes: `${stack.kind.toUpperCase()} inter-switch link${
            stack.interSwitchLink ? `: ${stack.interSwitchLink}` : ''
          }`,
          enabled: true,
          maintenance: false,
          healthRule: { type: 'both-endpoints' },
        } as LinkData,
      } as TopoEdge);
    }
    splitInto.set(key, { first: drawnId, byChassis });
  }

  /** The node a link should land on, once a pair has been split. */
  const endpointFor = (key: string, iface: string): string | undefined => {
    const split = splitInto.get(key);
    const drawn = nodeFor.get(key);
    if (!split) return drawn;
    const chassis = chassisOfPort(iface);
    // A port with no member number in it stays on the first chassis rather
    // than being placed at random.
    return (chassis && split.byChassis.get(chassis)) ?? split.first;
  };

  // Cables already drawn, keyed the same way the new ones are, so a second
  // crawl does not draw every link a second time on top of the first.
  const drawnLinks = new Set(
    (opts.existingEdges ?? []).map((e) => edgeSignature(e, (id) => id)),
  );
  const seenLinks = new Set<string>();

  // Silent devices, hung off the port each was learned on. Placed after the
  // topology so they sit under the switch that sees them rather than in the
  // layered rows, which are about distance from the seed.
  const attachedRows = new Map<string, number>();
  for (const { device: a, host } of opts.attached ?? []) {
    const parent = endpointFor(identity(host, ''), a.port);
    if (parent === undefined) continue;
    // The switch may be a node this run created, or one already on the
    // diagram that the crawl recognised (LT-133). Looking only at the new
    // ones meant that the moment the join started working, the switch a
    // sweep had already drawn anchored nothing and its ports went unlinked.
    const anchor =
      nodes.find((n) => n.id === parent) ??
      (opts.existingNodes ?? []).find((n) => n.id === parent);
    if (!anchor) continue;
    const note = `Learned on ${host} ${a.port}, MAC ${a.mac}${a.vlan ? `, VLAN ${a.vlan}` : ''}`;

    // LT-126: is this already on the diagram? A ping sweep places hosts it
    // knows by name and address, and this is the moment the crawl can say
    // which switch port one of them hangs off. Matching on the MAC first is
    // what joins the two: the sweep read it out of the ARP table, the switch
    // learned it on a port, and it is the same twelve digits.
    const mac = macKey(a.mac);
    const existing = findDrawn([
      mac ? `m:${mac}` : null,
      a.address ? `a:${a.address}` : null,
      a.hostname ? identity(a.hostname, '') : null,
    ]);

    let id: string;
    if (existing) {
      // Keep the node, and with it wherever the operator dragged it. Only
      // what the crawl newly establishes is written, and the MAC is written
      // so the next crawl recognises it without needing the address again.
      id = existing;
      const had = drawnDataById.get(existing);
      // LT-146: the switch and port get their own field. They used to be
      // written into `notes`, which clobbered anything a person had typed
      // there — and a re-crawl did it every time.
      const patch: Partial<DeviceNodeData> = {
        switchPort: `${host} ${shortInterface(a.port)}`,
        discoveredVia: 'Seen on a switch port',
      };
      if (!had?.notes) patch.notes = note;
      if (!macKey(had?.mac)) patch.mac = a.mac;
      if (a.vlan && !had?.vlan) patch.vlan = a.vlan;
      if (a.vendor && !had?.vendor) patch.vendor = a.vendor;
      updated.push({ id: existing, data: patch });
    } else {
      id = uid();
      // Only a new node needs a place to sit, so the row counter advances
      // here rather than for every attached device: a host that was already
      // drawn keeps the position it was given and leaves no gap behind it.
      const index = attachedRows.get(parent) ?? 0;
      attachedRows.set(parent, index + 1);
      // A name the device gave beats a maker inferred from its MAC: "HPLJ-3rdfloor"
      // is findable on a floor, "Hewlett Packard device" is not.
      const label = a.hostname || (a.vendor ? `${a.vendor} device` : a.mac);
      nodes.push({
        id,
        type: 'device',
        position: {
          x: anchor.position.x + (index % 4) * 200 - 300,
          y: anchor.position.y + ROW + Math.floor(index / 4) * 150,
        },
        width: 176,
        height: 96,
        data: {
          // A glyph only where a device that could actually tell us said so. An
          // OUI says who built something, not what it does, and a wrong glyph is
          // worse than a plain one.
          label,
          deviceType: a.class ? (CLASS_GLYPH[a.class] ?? 'generic') : 'generic',
          tags: ['seen-only', 'attached'],
          addresses: a.address
            ? [{ id: uid(), label: 'Learned', address: a.address, isPrimary: true }]
            : [],
          locked: false,
          maintenance: false,
          showDetails: true,
          mac: a.mac,
          switchPort: `${host} ${shortInterface(a.port)}`,
          discoveredVia: 'Seen on a switch port',
          ...(a.vendor ? { vendor: a.vendor } : {}),
          ...(a.vlan ? { vlan: a.vlan } : {}),
          notes: note,
        } as DeviceNodeData,
      } as TopoNode);
    }

    // A host already cabled to this port on this switch is not a second
    // cable. Without this a re-crawl stacked a fresh link on the old one
    // every time, which is the same fault the discovered links were already
    // guarded against.
    const cable = [`${parent}/${shortInterface(a.port)}`, `${id}/`].sort().join('::');
    seenLinks.add(cable);
    if (drawnLinks.has(cable)) continue;
    drawnLinks.add(cable);

    edgesFromAttached.push({
      id: uid(),
      source: parent,
      target: id,
      sourceHandle: 'b',
      targetHandle: 't',
      type: 'live',
      data: {
        sourcePortLabel: shortInterface(a.port),
        targetPortLabel: '',
        label: '',
        enabled: true,
        maintenance: false,
        healthRule: { type: 'follow-source' },
      } as LinkData,
    } as TopoEdge);
  }

  const edges: TopoEdge[] = [];
  let danglingLinks = 0;
  for (const { a, b, viaBundle } of links.values()) {
    const source = endpointFor(a.key, a.iface);
    const target = endpointFor(b.key, b.iface);
    if (!source || !target) {
      // One end was filtered off the diagram. Counted rather than dropped
      // silently, so the interface can say the picture is incomplete.
      if (!placedKeys.has(a.key) || !placedKeys.has(b.key)) danglingLinks += 1;
      continue;
    }
    const already = [
      `${source}/${shortInterface(a.iface)}`,
      `${target}/${shortInterface(b.iface)}`,
    ]
      .sort()
      .join('::');
    seenLinks.add(already);
    if (drawnLinks.has(already)) continue;

    const full = [a.iface, b.iface].filter(Boolean).join(' \u2194 ');
    const bundleNote = viaBundle?.length
      ? ` — ${viaBundle.length} bundled ports: ${viaBundle.join(', ')}`
      : '';
    // No path type, colour, direction or width: those are style, and
    // `store.addEdge` fills them from the document's default (LT-130). Naming
    // them here is how every discovered link came out smooth-step no matter
    // what the default said.
    // LT-131: an arrow only where a device's own forwarding decision says
    // which way is out. `a` sends unknown traffic to an address `b` owns, so
    // the traffic leaves a towards b — and the reverse for the other end.
    // Where neither end has a default route pointing at the other the link
    // stays undirected, because a guessed arrow is worse than none.
    const aHop = nextHopOf.get(a.key);
    const bHop = nextHopOf.get(b.key);
    let direction: LinkData['direction'] | undefined;
    if (aHop && ownerOfAddress.get(aHop) === b.key) direction = 'forward';
    else if (bHop && ownerOfAddress.get(bHop) === a.key) direction = 'reverse';

    const data: Partial<LinkData> = {
      sourcePortLabel: shortInterface(a.iface),
      targetPortLabel: shortInterface(b.iface),
      label: '',
      notes: full ? `Discovered: ${full}${bundleNote}` : undefined,
      ...(direction ? { direction } : {}),
      enabled: true,
      maintenance: false,
      healthRule: { type: 'both-endpoints' },
    };
    edges.push({
      id: uid(),
      source,
      target,
      sourceHandle: 'b',
      targetHandle: 't',
      type: 'live',
      data,
    } as TopoEdge);
  }

  void projectId;

  // ---------------------------------------------------------------- LT-215
  //
  // The same devices, a second kind of link. A cable says what is plugged into
  // what; a route whose next hop is another crawled device's address says
  // where traffic is *sent*, which on a routed estate is not the same picture.
  // Both are drawn on one set of devices, each on its own view, so either can
  // be shown, hidden or printed without two diagrams to keep in step.
  const logicalView = opts.views?.logical;
  if (logicalView) {
    const l3Drawn = new Set(
      (opts.existingEdges ?? [])
        .filter((e) => (e.data as LinkData | undefined)?.layer3)
        .map((e) => [e.source, e.target].sort().join('::')),
    );
    const hops = new Map<string, { from: string; to: string; prefixes: string[] }>();
    for (const d of src.devices) {
      const from = identity(d.hostname, d.address);
      for (const r of d.routes ?? []) {
        for (const hop of r.nextHops) {
          const to = ownerOfAddress.get(hop.trim());
          if (!to || to === from) continue;
          const k = `${from}>${to}`;
          const entry = hops.get(k) ?? { from, to, prefixes: [] };
          if (!entry.prefixes.includes(r.prefix)) entry.prefixes.push(r.prefix);
          hops.set(k, entry);
        }
      }
    }
    for (const { from, to, prefixes } of hops.values()) {
      const source = endpointFor(from, '');
      const target = endpointFor(to, '');
      if (!source || !target || source === target) continue;
      const pair = [source, target].sort().join('::');
      seenLinks.add(`l3:${pair}`);
      if (l3Drawn.has(pair)) continue;
      l3Drawn.add(pair);
      const back = hops.get(`${to}>${from}`);
      const shown = prefixes.slice(0, 3).join(', ') + (prefixes.length > 3 ? ` and ${prefixes.length - 3} more` : '');
      edges.push({
        id: uid(),
        source,
        target,
        sourceHandle: 'b',
        targetHandle: 't',
        type: 'live',
        data: {
          sourcePortLabel: '',
          targetPortLabel: '',
          label: 'L3',
          notes: `Routes ${shown} via this device${back ? `; it routes ${back.prefixes.length} prefix${back.prefixes.length === 1 ? '' : 'es'} back` : ''}.`,
          direction: back ? 'both' : 'forward',
          lineStyle: 'dashed',
          layer3: true,
          layers: [logicalView],
          enabled: true,
          maintenance: false,
          healthRule: { type: 'both-endpoints' },
        } as Partial<LinkData>,
      } as TopoEdge);
    }
  }
  // Cables belong to the physical view.
  if (opts.views?.physical) {
    for (const e of [...edges, ...edgesFromAttached]) {
      const d = e.data as Partial<LinkData>;
      if (!d.layer3) d.layers = [opts.views.physical];
    }
  }

  // Every link above was written bottom-to-top, which is right for a tier
  // above a tier and wrong for two devices placed side by side. Now that the
  // positions are settled, each one leaves the nearer side.
  const positioned = new Map<string, TopoNode>(
    [...nodes, ...(opts.existingNodes ?? [])].map((n) => [n.id, n]),
  );
  const routed = [...edges, ...edgesFromAttached].map((e) => {
    const source = positioned.get(e.source);
    const target = positioned.get(e.target);
    if (!source || !target) return e;
    return { ...e, ...chooseHandles(source, target) };
  });

  return { nodes, edges: routed, updated, danglingLinks, seenLinks };
}
