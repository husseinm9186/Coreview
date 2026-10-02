/**
 * Where a packet actually goes (LT-346).
 *
 * The diagram shows cables. This answers a different question: given a source
 * and a destination, which routing decision does each device make, and what is
 * the resulting path? It is the question an engineer asks when something is
 * reachable from one place and not another.
 *
 * **It is arithmetic over data already collected.** `show ip route` is parsed
 * per device by LT-200 and reaches the front end as `RouteRow`; addresses,
 * interfaces and neighbours come from the crawl. Nothing here touches a
 * network, and nothing is inferred that a device did not report.
 *
 * **What it refuses to do matters as much as what it does.** A path built from
 * missing data is worse than no path, because it looks like an answer. So:
 *
 * - A device that was never crawled, or was crawled without its routing table,
 *   stops the trace with `insufficient` and names the device. It does not
 *   guess the next hop from the diagram's cables.
 * - A VRF is answered **from that VRF's own table** (LT-347), or not at all.
 *   A device holding no table for the VRF asked about reports `insufficient`
 *   rather than falling back to the global table — answering one tenant's
 *   question out of another's table is the worst kind of wrong (D-050).
 * - An overlay hop is drawn only where the device's own route said it crossed
 *   one (LT-347): `segid: N … encap: VXLAN` in the table, and a VTEP the crawl
 *   actually holds. Where the far end is unknown the trace refuses rather than
 *   inventing a remote leaf.
 *
 * Protocol support is whatever the device itself printed in its routing table
 * — `connected`, `static`, `ospf`, `bgp`, `eigrp` — because that is the word
 * the device used, not a word this file decided.
 */
import { parseCidr, toValue } from './ipam';

/** One device, as the engine needs it. Built from a `CrawledDevice`. */
export interface PathDevice {
  hostname: string;
  /** Every address it holds, with the interface where known. */
  addresses: { ip: string; interface?: string | null }[];
  /** Its global routing table. Absent — not empty — when it was never
   *  collected. */
  routes?: PathRoute[];
  /** Per-VRF tables, by VRF name. A device with a table for a VRF routes that
   *  VRF's traffic from it and from nothing else — that isolation is the whole
   *  point of a VRF, and it is enforced here rather than assumed. */
  vrfRoutes?: Record<string, PathRoute[]>;
  /** Who is on the other end of each of its interfaces. */
  neighbours?: { localInterface?: string | null; name: string }[];
  /** LT-348: this device is a VXLAN tunnel endpoint. */
  vtep?: Vtep;
  /** LT-479: policy routing applied on this device. The engine does not
   *  evaluate a policy; a hop through a device that has one says so. */
  policyRoutes?: { interface?: string | null; name: string }[];
  /** LT-480: OTV on this device — the VLANs it extends and which far edge
   *  owns each MAC — and the MACs it learned per address, so a destination
   *  on an extended VLAN can be sent to the edge that owns it. */
  otv?: {
    overlays: { name: string; extendedVlans: number[] }[];
    routes: { vlan: number; mac: string; owner: string; nextHop: string }[];
  } | null;
  /** Address → MAC, from what the device learned on its ports. */
  macs?: Record<string, string>;
  /** LT-348: address translation it performs, checked on arrival. */
  nat?: NatRule[];
  /** LT-348: virtual addresses it answers for, and what is behind them. */
  vips?: Vip[];
}

/** A VXLAN tunnel endpoint, and the segments it carries. */
export interface Vtep {
  /** The address other VTEPs tunnel to — usually a loopback. */
  address: string;
  /** Each segment this VTEP is a member of. */
  segments: { vni: number; vlan?: number | null; prefix?: string | null }[];
}

/** One translation. `matches` is the address as it arrives. */
export interface NatRule {
  kind: 'destination' | 'source';
  matches: string;
  becomes: string;
  /** Only for this port, when the rule is port-specific. */
  port?: number | null;
  description?: string;
}

/** A virtual address and the real servers behind it. */
export interface Vip {
  address: string;
  port?: number | null;
  /** Real server addresses. Several is a pool; each is a possible path. */
  members: string[];
  description?: string;
}

export interface PathRoute {
  family?: number;
  prefix: string;
  /** The device's own word: `connected`, `static`, `ospf`, `isis`, `eigrp`,
   *  `bgp`. Whatever it printed — not a word this file decided. */
  protocol: string;
  /** Where it sends traffic. Several means equal-cost (ECMP). */
  nextHops: string[];
  interface?: string | null;
  distance?: number | null;
  metric?: number | null;
  /** LT-348: BGP's tie-breakers, when this is a BGP route and the device
   *  reported them. */
  bgp?: BgpAttributes;
  /** LT-347: the table the *next hop* is resolved in, when the device said it
   *  is not this one. NX-OS writes `*via 203.0.113.4%default` for a tenant
   *  route whose next hop is a VTEP address in the underlay. Looking that
   *  address up in the tenant's own table finds nothing. */
  nextHopVrf?: string | null;
  /** LT-347: the VXLAN segment this route crosses, from
   *  `segid: 50000 … encap: VXLAN`. The device stating, in its own routing
   *  table, that this prefix is reached over the overlay. */
  segmentId?: number | null;
}

/** One routing decision, on one device. */
export interface Hop {
  device: string;
  /** The prefix that won the lookup. */
  prefix: string;
  protocol: string;
  /** Where the winning route points. Null for a connected route. */
  nextHop: string | null;
  /** The interface it leaves by, where the device said. */
  outInterface: string | null;
  distance: number | null;
  metric: number | null;
  /** In one sentence, why this route and not another. */
  why: string;
  /** LT-679: which of the device's tables answered — the forwarding table
   *  (CEF/FIB, what it really forwards by), its routing table, or a policy.
   *  The classic engine walks routing tables; the collected path says
   *  which it had (D-063). Absent for a step that is not a lookup. */
  table?: 'forwarding' | 'routing' | 'policy';
  /** Recursive resolution: a BGP next-hop resolved through the IGP, and so
   *  on. Empty when the next hop was directly connected. */
  via: { prefix: string; protocol: string; nextHop: string | null }[];
  /** LT-348: what kind of step this is, when it is not a plain routed hop.
   *  A drawing that shows an L2 extension as an L3 hop is wrong in the way
   *  that matters most. */
  segment?: HopSegment;
  /** The VRF this decision was made in, when it was not the global table. */
  vrf?: string;
  /** LT-348: BGP's own tie-breakers, where the device reported them. */
  bgp?: BgpAttributes;
  /** LT-478: how many equal-cost next hops the winning route has, when more
   *  than one — the device's hash decides which, and only the device can say. */
  ecmp?: number;
  /** LT-479: what this decision did not take into account, in sentences. */
  notes?: string[];
}

export type HopSegment =
  /** Address translation performed on arrival at this device. */
  | { kind: 'nat'; was: string; now: string; description?: string }
  /** A virtual address answered here, and the member chosen. */
  | { kind: 'vip'; vip: string; member: string; description?: string }
  /** Into the overlay: this VTEP encapsulates for a remote one. */
  | { kind: 'overlay'; vni: number; vlan?: number | null; localVtep: string; remoteVtep: string; remote: string }
  /** A hop of the underlay carrying that tunnel. */
  | { kind: 'underlay'; vni: number; localVtep: string; remoteVtep: string }
  /** Out of the overlay at the far end. */
  | { kind: 'decapsulate'; vni: number; localVtep: string }
  /** LT-480: across an OTV extension, to the edge that owns the MAC. */
  | { kind: 'otv'; vlan: number; overlay: string; mac: string; remote: string };

/** What BGP used to choose, where the device said. */
export interface BgpAttributes {
  localPreference?: number | null;
  asPath?: string | null;
  med?: number | null;
  communities?: string[];
}

export type TraceResult =
  /** Reached the destination. One path, or several if they are equal-cost. */
  | { kind: 'delivered'; paths: Hop[][] }
  /** A device made a decision that goes nowhere. */
  | { kind: 'unreachable'; paths: Hop[][]; at: string; reason: string }
  /** We do not hold the data to answer. Never a guess. */
  | { kind: 'insufficient'; reason: string; paths: Hop[][] }
  /** The routes point in a circle. */
  | { kind: 'loop'; paths: Hop[][]; at: string };

/** LT-479: a policy route is consulted before the table, and the engine
 *  does not read it. Said on the hop rather than left silent. */
export function policyNotes(device: PathDevice): string[] {
  const routes = device.policyRoutes ?? [];
  if (routes.length === 0) return [];
  const where = routes.map((r) => (r.interface ? `${r.interface} (${r.name})` : r.name)).join(', ');
  return [`Policy routing is configured on ${device.hostname} — ${where} — and was not evaluated; this is the routing table's decision.`];
}

/** LT-480: the OTV overlay extending the VLAN a connected route sits on,
 *  when there is one. The VLAN is read off the interface name (`Vlan100`). */
export function otvExtension(device: PathDevice, route: PathRoute): { vlan: number; overlay: string } | undefined {
  if (!device.otv || !route.interface) return undefined;
  const m = /^vlan\s*(\d+)$/i.exec(route.interface.trim());
  if (!m) return undefined;
  const vlan = Number(m[1]);
  const overlay = device.otv.overlays.find((o) => o.extendedVlans.includes(vlan));
  return overlay ? { vlan, overlay: overlay.name } : undefined;
}

/** How many equal-cost branches to follow before stopping. */
const MAX_PATHS = 8;
/** How many hops before calling it a loop, whatever the visited set says. */
const MAX_HOPS = 32;
/** How deep a next-hop may resolve through other routes. */
const MAX_RECURSION = 8;

/** Whether an address falls inside a prefix. Null for anything unparseable. */
export function inPrefix(address: string, prefix: string): boolean | null {
  const value = toValue(address.trim());
  const block = parseCidr(prefix.trim());
  if (value === null || !block) return null;
  if (block.prefix === 0) return true;
  const mask = block.prefix === 32 ? 0xffffffff : ~(2 ** (32 - block.prefix) - 1) >>> 0;
  return ((value & mask) >>> 0) === ((block.network & mask) >>> 0);
}

/**
 * The route a device would use for an address: longest prefix first, then the
 * lowest administrative distance, then the lowest metric.
 *
 * That order is the one routers use and it is not interchangeable — a /32
 * static beats a /8 OSPF route however good the metric is, because the mask
 * is consulted before anything else.
 */
export function longestPrefixMatch(routes: readonly PathRoute[], address: string): PathRoute | null {
  let best: PathRoute | null = null;
  let bestLength = -1;
  for (const route of routes) {
    // IPv6 tables are collected but this resolves IPv4; mixing them silently
    // would match a v4 address against a v6 prefix's arithmetic.
    if (route.family !== undefined && route.family !== 4) continue;
    if (inPrefix(address, route.prefix) !== true) continue;
    const length = parseCidr(route.prefix)?.prefix ?? -1;
    if (length > bestLength) {
      best = route;
      bestLength = length;
      continue;
    }
    if (length !== bestLength || !best) continue;
    const distance = (r: PathRoute) => r.distance ?? Number.MAX_SAFE_INTEGER;
    const metric = (r: PathRoute) => r.metric ?? Number.MAX_SAFE_INTEGER;
    if (distance(route) < distance(best) || (distance(route) === distance(best) && metric(route) < metric(best))) {
      best = route;
    }
  }
  return best;
}

/**
 * Every route that covers an address, best first.
 *
 * Same order as `longestPrefixMatch`, which is the first of these. It exists
 * for the failure simulation: when the best route's next hop is on a device
 * that has been taken out, the *next* route is one the device already holds,
 * and using it is reading its table rather than inventing a reconvergence.
 */
export function rankedRoutes(routes: readonly PathRoute[], address: string): PathRoute[] {
  const value = (r: PathRoute) => [
    -(parseCidr(r.prefix)?.prefix ?? -1),
    r.distance ?? Number.MAX_SAFE_INTEGER,
    r.metric ?? Number.MAX_SAFE_INTEGER,
  ];
  return routes
    .filter((r) => (r.family === undefined || r.family === 4) && inPrefix(address, r.prefix) === true)
    .sort((a, b) => {
      const [al, ad, am] = value(a);
      const [bl, bd, bm] = value(b);
      return al! - bl! || ad! - bd! || am! - bm!;
    });
}

/** Why one route won, said plainly. */
function reasonFor(route: PathRoute, among: readonly PathRoute[], address: string): string {
  const candidates = among.filter((r) => inPrefix(address, r.prefix) === true);
  const length = parseCidr(route.prefix)?.prefix ?? 0;
  const longer = candidates.filter((r) => (parseCidr(r.prefix)?.prefix ?? 0) === length);
  if (candidates.length === 1) return `${route.prefix} is the only route covering ${address}.`;
  if (longer.length === 1) {
    return `${route.prefix} is the longest prefix covering ${address}, out of ${candidates.length} that do.`;
  }
  const byDistance = longer.filter((r) => (r.distance ?? Number.MAX_SAFE_INTEGER) === (route.distance ?? Number.MAX_SAFE_INTEGER));
  if (byDistance.length === 1) {
    return `${route.prefix} via ${route.protocol}: same prefix length as ${longer.length - 1} other, lower administrative distance (${route.distance}).`;
  }
  return `${route.prefix} via ${route.protocol}: chosen on metric (${route.metric ?? 'none reported'}) among ${longer.length} equal routes.`;
}

/** The device holding this address, if the crawl found one. */
function deviceAt(devices: readonly PathDevice[], address: string): PathDevice | undefined {
  const want = address.trim();
  return devices.find((d) => d.addresses.some((a) => a.ip.trim() === want));
}

/** The device on the other end of an interface, by name. */
function neighbourOn(devices: readonly PathDevice[], device: PathDevice, iface: string | null): PathDevice | undefined {
  if (!iface) return undefined;
  const want = iface.trim().toLowerCase();
  const named = (device.neighbours ?? []).find(
    (n) => (n.localInterface ?? '').trim().toLowerCase() === want,
  );
  if (!named) return undefined;
  const key = named.name.trim().toLowerCase();
  return devices.find(
    (d) => d.hostname.trim().toLowerCase() === key || d.hostname.split('.')[0]!.trim().toLowerCase() === key.split('.')[0],
  );
}

/**
 * Resolve a next hop down to an interface, following routes as far as it takes
 * (LT-346).
 *
 * This is what makes a BGP path real: `10.40.50.0/24 via 10.255.2.1` says
 * nothing about which cable the packet leaves by. 10.255.2.1 is looked up in
 * the same table, which gives an IGP route, which gives another next hop, and
 * so on until something is connected and names an interface.
 */
export function resolveNextHop(
  routes: readonly PathRoute[],
  nextHop: string,
): { interface: string | null; via: Hop['via']; resolved: boolean } {
  const via: Hop['via'] = [];
  let address = nextHop;
  for (let depth = 0; depth < MAX_RECURSION; depth += 1) {
    const route = longestPrefixMatch(routes, address);
    if (!route) return { interface: null, via, resolved: false };
    via.push({ prefix: route.prefix, protocol: route.protocol, nextHop: route.nextHops[0] ?? null });
    // Connected, or any route that names the interface it leaves by: that is
    // the end of the recursion.
    if (route.interface) return { interface: route.interface, via, resolved: true };
    const onward = route.nextHops[0];
    // A route with neither an interface nor a next hop resolves to nothing.
    if (!onward || onward === address) return { interface: null, via, resolved: false };
    address = onward;
  }
  return { interface: null, via, resolved: false };
}

export interface TraceRequest {
  devices: readonly PathDevice[];
  /** Hostname or address of the device to start from. */
  from: string;
  /** The address being traced to. */
  to: string;
  /** Default table unless told otherwise. */
  vrf?: string;
  /** LT-348: the destination port, so a NAT or VIP rule that is specific to
   *  one can be matched. */
  port?: number | null;
  /** LT-346: devices and links to pretend are down. Nothing is changed on any
   *  device — this is a filter over the graph we already hold. */
  without?: { devices?: string[] };
  /** LT-348: trace the underlay only, with the overlay switched off.
   *
   *  Set when this call *is* the underlay of a tunnel. Without it the walk
   *  reaches for the overlay again the moment it is asked for a remote VTEP's
   *  own address — that address belongs to a device sharing the VNI — and
   *  recurses until the stack gives out. A tunnel is not carried by itself. */
  underlayOnly?: boolean;
}

/** The destination translation this device performs on arrival, if any. */
export function natFor(device: PathDevice, address: string, port?: number | null): NatRule | undefined {
  return (device.nat ?? []).find(
    (r) =>
      r.kind === 'destination' &&
      r.matches.trim() === address.trim() &&
      (r.port === undefined || r.port === null || port === undefined || port === null || r.port === port),
  );
}

/** The virtual address this device answers for, if the traffic is aimed at one. */
export function vipFor(device: PathDevice, address: string, port?: number | null): Vip | undefined {
  return (device.vips ?? []).find(
    (v) =>
      v.address.trim() === address.trim() &&
      (v.port === undefined || v.port === null || port === undefined || port === null || v.port === port),
  );
}

/**
 * The VXLAN segment that carries an address, and the VTEP behind which it
 * lives (LT-348).
 *
 * An address inside a segment a remote VTEP carries is **not** an L3 hop away
 * — it is one bridged hop across a tunnel. Drawing that as a routed hop is the
 * mistake that makes a stretched layer 2 unreadable, so it is found here and
 * kept as its own kind of step.
 */
export function segmentFor(
  devices: readonly PathDevice[],
  local: PathDevice,
  address: string,
): { vni: number; vlan?: number | null; remote: PathDevice } | undefined {
  if (!local.vtep) return undefined;
  for (const mine of local.vtep.segments) {
    for (const other of devices) {
      if (other === local || !other.vtep) continue;
      const theirs = other.vtep.segments.find((sg) => sg.vni === mine.vni);
      if (!theirs) continue;
      // The address has to be in the far end's own segment prefix, or be an
      // address that end actually holds. Membership of the VNI alone says
      // nothing about where inside it a host is.
      const inTheirs = theirs.prefix ? inPrefix(address, theirs.prefix) === true : false;
      const holdsIt = other.addresses.some((a) => a.ip.trim() === address.trim());
      if (inTheirs || holdsIt) return { vni: mine.vni, vlan: mine.vlan ?? theirs.vlan, remote: other };
    }
  }
  return undefined;
}

const isDefaultVrf = (vrf: string | undefined) =>
  !vrf || ['', 'default', 'global', 'inet.0', 'main'].includes(vrf.trim().toLowerCase());

/**
 * The table a next hop is resolved in (LT-347).
 *
 * Usually the one the route came from. NX-OS names another when it is not —
 * `*via 203.0.113.4%default` in a tenant VRF means the VTEP address lives in
 * the underlay — and honouring that is the difference between following an
 * overlay path and reporting it unresolvable. A table the device does not
 * hold falls back to the route's own rather than answering from nothing.
 */
export function resolutionTable(
  device: PathDevice,
  table: readonly PathRoute[],
  nextHopVrf: string | null | undefined,
): readonly PathRoute[] {
  if (nextHopVrf === undefined || nextHopVrf === null) return table;
  if (isDefaultVrf(nextHopVrf)) return device.routes ?? table;
  return device.vrfRoutes?.[nextHopVrf.trim()] ?? table;
}

/**
 * Follow the routing decisions from one device to an address.
 *
 * Every branch of an ECMP route is followed, up to `MAX_PATHS`. A path that
 * ends at the destination is `delivered`; one that runs out of routes is
 * `unreachable` and says where and why.
 */
export function tracePath(request: TraceRequest): TraceResult {
  const { devices, to, vrf } = request;

  // D-050: a VRF is answered from that VRF's own table, or not at all. Falling
  // back to the global table would be confidently wrong, which is the worst
  // kind — so a VRF nothing holds a table for stops here by name.
  const named = !isDefaultVrf(vrf);
  if (named && !devices.some((d) => d.vrfRoutes?.[vrf!.trim()])) {
    return {
      kind: 'insufficient',
      paths: [],
      reason:
        `No device in this data holds a routing table for VRF "${vrf}", so a path through it cannot be worked out. ` +
        'Nothing here falls back to the global table.',
    };
  }
  /** The table this trace routes from, on one device. */
  const tableOf = (d: PathDevice): PathRoute[] | undefined =>
    named ? d.vrfRoutes?.[vrf!.trim()] : d.routes;

  const down = new Set((request.without?.devices ?? []).map((d) => d.trim().toLowerCase()));
  const up = devices.filter((d) => !down.has(d.hostname.trim().toLowerCase()));

  const start =
    up.find((d) => d.hostname.trim().toLowerCase() === request.from.trim().toLowerCase()) ??
    deviceAt(up, request.from);
  if (!start) {
    return {
      kind: 'insufficient',
      paths: [],
      reason: `${request.from} is not a device this project has crawled, so its routing table is not held.`,
    };
  }
  if (inPrefix(to, '0.0.0.0/0') !== true) {
    return { kind: 'insufficient', paths: [], reason: `${to} is not an IPv4 address.` };
  }

  const done: Hop[][] = [];
  // A holder rather than two `let`s: these are written inside `walk` and read
  // after it, and TypeScript narrows a closure-assigned `let` back to its
  // initial `null` at the read. Property narrowing is reset by a call, which
  // is exactly the behaviour wanted here.
  const first: {
    failure: { at: string; reason: string; path: Hop[] } | null;
    looped: { at: string; path: Hop[] } | null;
    /** LT-480: a refusal for want of data, which outranks an unreachable. */
    insufficient: { reason: string; path: Hop[] } | null;
  } = { failure: null, looped: null, insufficient: null };

  /** A routed hop across an L3 VNI, as three steps: into the overlay, the
   *  underlay that carries it, and out at the far end (LT-347).
   *
   *  The same three the bridged case builds. What differs is where the
   *  evidence comes from — a `segid` on a route rather than two devices
   *  sharing a VLAN-backed segment — and that the VRF travels with it, which
   *  is the whole reason an L3 VNI exists. */
  const crossOverlay = (a: {
    device: PathDevice;
    remote: PathDevice;
    vni: number;
    localVtep: string;
    remoteVtep: string;
    route: PathRoute;
    target: string;
    why: string;
  }) => {
    const overlay: Hop = {
      device: a.device.hostname,
      prefix: a.route.prefix,
      protocol: a.route.protocol,
      nextHop: a.remoteVtep,
      outInterface: null,
      distance: a.route.distance ?? null,
      metric: a.route.metric ?? null,
      why:
        `${a.why} ${a.device.hostname} carries it across VNI ${a.vni} to VTEP ${a.remoteVtep} ` +
        `(${a.remote.hostname}) — its own table says so: the next hop is resolved in ` +
        `${isDefaultVrf(a.route.nextHopVrf ?? undefined) ? 'the global table' : `VRF ${a.route.nextHopVrf}`}, ` +
        'and the route is encapsulated, not forwarded on a wire.',
      via: [],
      segment: {
        kind: 'overlay',
        vni: a.vni,
        localVtep: a.localVtep,
        remoteVtep: a.remoteVtep,
        remote: a.remote.hostname,
      },
      ...(named ? { vrf: vrf!.trim() } : {}),
    };
    // The underlay runs in the global table, which is where a VXLAN underlay
    // lives, and is traced with the same engine rather than assumed.
    const underlay = tracePath({
      devices: up,
      from: a.device.hostname,
      to: a.remoteVtep,
      without: request.without,
      underlayOnly: true,
    });
    const carried: Hop[] = (underlay.paths[0] ?? []).map((h) => ({
      ...h,
      segment: { kind: 'underlay' as const, vni: a.vni, localVtep: a.localVtep, remoteVtep: a.remoteVtep },
      why: `Underlay for VNI ${a.vni}: ${h.why}`,
    }));
    const decap: Hop = {
      device: a.remote.hostname,
      prefix: `VNI ${a.vni}`,
      protocol: 'vxlan',
      nextHop: null,
      outInterface: null,
      distance: null,
      metric: null,
      why: `${a.remote.hostname} takes the packet out of VNI ${a.vni} and routes ${a.target} on from there.`,
      via: [],
      segment: { kind: 'decapsulate', vni: a.vni, localVtep: a.remoteVtep },
      ...(named ? { vrf: vrf!.trim() } : {}),
    };
    return { overlay, underlay, carried, decap };
  };

  /** One branch of the walk. `seen` is per-branch: two ECMP legs may
   *  legitimately pass through the same device without that being a loop.
   *
   *  `target` is the destination *as it stands at this point in the path* —
   *  NAT and a load balancer both change it, and the lookups after them have
   *  to use the new one or the rest of the path is worked out for an address
   *  the packet no longer carries. */
  const walk = (device: PathDevice, path: Hop[], seen: Set<string>, target: string = to) => {
    if (done.length >= MAX_PATHS) return;

    // Arrived: the destination is one of this device's own addresses.
    if (device.addresses.some((a) => a.ip.trim() === target.trim())) {
      done.push(path);
      return;
    }

    // LT-348: a destination translation happens on arrival, before any route
    // is looked up — the lookup that follows is for the translated address.
    const nat = natFor(device, target, request.port);
    if (nat && !path.some((h) => h.segment?.kind === 'nat' && h.segment.now === nat.becomes)) {
      const hop: Hop = {
        device: device.hostname,
        prefix: nat.matches,
        protocol: 'nat',
        nextHop: nat.becomes,
        outInterface: null,
        distance: null,
        metric: null,
        why: `${device.hostname} translates ${nat.matches} to ${nat.becomes}${nat.description ? ` (${nat.description})` : ''}. Everything after this is routed for ${nat.becomes}.`,
        via: [],
        segment: { kind: 'nat', was: nat.matches, now: nat.becomes, description: nat.description },
        ...(named ? { vrf: vrf!.trim() } : {}),
      };
      walk(device, [...path, hop], seen, nat.becomes);
      return;
    }

    // LT-348: a virtual address is answered here; each member behind it is a
    // path of its own, because any of them may serve the connection.
    const vip = vipFor(device, target, request.port);
    if (vip && !path.some((h) => h.segment?.kind === 'vip' && h.segment.vip === vip.address)) {
      for (const member of vip.members) {
        if (done.length >= MAX_PATHS) return;
        const hop: Hop = {
          device: device.hostname,
          prefix: vip.address,
          protocol: 'load-balancer',
          nextHop: member,
          outInterface: null,
          distance: null,
          metric: null,
          why:
            `${device.hostname} answers for ${vip.address}${vip.description ? ` (${vip.description})` : ''} and sends this connection to ${member}` +
            (vip.members.length > 1 ? `, one of ${vip.members.length} members in the pool.` : '.'),
          via: [],
          segment: { kind: 'vip', vip: vip.address, member, description: vip.description },
          ...(named ? { vrf: vrf!.trim() } : {}),
        };
        walk(device, [...path, hop], seen, member);
      }
      return;
    }

    // LT-348: the destination is inside a VXLAN segment this device shares
    // with a remote VTEP. That is one bridged hop across a tunnel, not an L3
    // hop, and drawing it as the latter is what makes a stretched layer 2
    // impossible to read. The underlay that carries the tunnel is traced
    // separately and kept as its own steps.
    const segment = !request.underlayOnly && device.vtep && segmentFor(up, device, target);
    if (segment && !path.some((h) => h.segment?.kind === 'overlay' && h.segment.vni === segment.vni)) {
      const localVtep = device.vtep!.address;
      const remoteVtep = segment.remote.vtep!.address;
      const overlay: Hop = {
        device: device.hostname,
        prefix: `VNI ${segment.vni}`,
        protocol: 'vxlan',
        nextHop: remoteVtep,
        outInterface: null,
        distance: null,
        metric: null,
        why:
          `${target} is in VNI ${segment.vni}${segment.vlan ? ` (VLAN ${segment.vlan})` : ''}, which ${device.hostname} ` +
          `and ${segment.remote.hostname} both carry. It is bridged across the overlay from VTEP ${localVtep} to ${remoteVtep}, not routed.`,
        via: [],
        segment: {
          kind: 'overlay',
          vni: segment.vni,
          vlan: segment.vlan,
          localVtep,
          remoteVtep,
          remote: segment.remote.hostname,
        },
        ...(named ? { vrf: vrf!.trim() } : {}),
      };

      // The underlay: how the encapsulated packet actually gets from one VTEP
      // to the other. Traced with the same engine, in the global table, which
      // is where a VXLAN underlay lives.
      const carried = tracePath({
        devices: up,
        from: device.hostname,
        to: remoteVtep,
        without: request.without,
        underlayOnly: true,
      });
      const underlay: Hop[] = (carried.paths[0] ?? []).map((h) => ({
        ...h,
        segment: { kind: 'underlay', vni: segment.vni, localVtep, remoteVtep },
        why: `Underlay for VNI ${segment.vni}: ${h.why}`,
      }));

      const decap: Hop = {
        device: segment.remote.hostname,
        prefix: `VNI ${segment.vni}`,
        protocol: 'vxlan',
        nextHop: null,
        outInterface: null,
        distance: null,
        metric: null,
        why: `${segment.remote.hostname} takes the packet out of VNI ${segment.vni} and delivers it to ${target} on the local segment.`,
        via: [],
        segment: { kind: 'decapsulate', vni: segment.vni, localVtep: remoteVtep },
        ...(named ? { vrf: vrf!.trim() } : {}),
      };

      if (carried.kind !== 'delivered') {
        first.failure ??= {
          at: device.hostname,
          reason: `The overlay between ${localVtep} and ${remoteVtep} could not be followed: ${
            carried.kind === 'unreachable' || carried.kind === 'insufficient' ? carried.reason : 'the underlay loops'
          }`,
          path: [...path, overlay],
        };
        return;
      }
      done.push([...path, overlay, ...underlay, decap]);
      return;
    }

    const table = tableOf(device);
    if (table === undefined) {
      first.failure ??= {
        at: device.hostname,
        reason: named
          ? `${device.hostname} holds no routing table for VRF ${vrf}, so the path cannot be followed past it.`
          : `${device.hostname} was reached but its routing table was not collected, so the path cannot be followed past it. Run a crawl with "Routing table" ticked.`,
        path,
      };
      return;
    }

    // Best first. Normally only the first is used; while simulating a failure
    // the next one is tried when the best route's next hop is on a device that
    // has been taken out — that alternate is in the device's own table, so
    // using it is reading routing rather than inventing reconvergence.
    const candidates = rankedRoutes(table, target);
    const onRemovedDevice = (nextHop: string) =>
      down.size > 0 && down.has((deviceAt(devices, nextHop)?.hostname ?? '\u0000').trim().toLowerCase());
    const usable = candidates.filter(
      (r) => r.nextHops.length === 0 || r.nextHops.some((h) => !onRemovedDevice(h)),
    );
    const route = usable[0] ?? candidates[0];
    if (!route) {
      first.failure ??= {
        at: device.hostname,
        reason: `${device.hostname} has no route to ${target}, not even a default. It would drop the packet.`,
        path,
      };
      return;
    }
    // When an alternate was taken, say so — it is not what the device is doing
    // right now, it is what its table says it would do next.
    const alternate = candidates.length > 0 && route !== candidates[0];

    const key = `${device.hostname}|${route.prefix}`;
    if (seen.has(key) || path.length >= MAX_HOPS) {
      first.looped ??= { at: device.hostname, path };
      return;
    }

    const why = alternate
      ? `${reasonFor(route, table, target)} Taken because the preferred route's next hop is on a device this simulation removed; it is already in ${device.hostname}'s table.`
      : reasonFor(route, table, target);
    // LT-480: connected, but on a VLAN this device extends over OTV. The
    // edge that owns the destination's MAC is in the device's own OTV route
    // table; a MAC nobody learned, or an edge this run never reached, is
    // refused rather than guessed (D-050).
    const extended = route.nextHops.length === 0 ? otvExtension(device, route) : undefined;
    if (extended) {
      const mac = device.macs?.[target.trim()];
      const owner = mac ? device.otv?.routes.find((r) => r.vlan === extended.vlan && r.mac === mac) : undefined;
      if (!mac || !owner) {
        first.insufficient ??= {
          reason: `${device.hostname} has ${route.prefix} on VLAN ${extended.vlan}, which ${extended.overlay} extends over OTV to other sites. ${
            mac ? `Its OTV route table names no edge for ${mac}` : `This run holds no MAC for ${target} on ${device.hostname}`
          }, so which site holds ${target} is not known.`,
          path,
        };
        return;
      }
      if (owner.owner !== 'site') {
        const remote = devices.find((d) => d.hostname.trim().toLowerCase() === owner.nextHop.trim().toLowerCase());
        if (!remote) {
          first.insufficient ??= {
            reason: `${device.hostname}'s OTV route table sends ${target} (${mac}) on VLAN ${extended.vlan} to ${owner.nextHop}, which this run did not reach.`,
            path,
          };
          return;
        }
        const hop: Hop = {
          device: device.hostname,
          prefix: route.prefix,
          protocol: route.protocol,
          table: 'routing',
          nextHop: null,
          outInterface: route.interface ?? null,
          distance: route.distance ?? null,
          metric: route.metric ?? null,
          why: `${why} VLAN ${extended.vlan} is extended over OTV (${extended.overlay}); ${device.hostname}'s OTV route table says ${mac} is behind ${owner.nextHop}, so the frame crosses the extension rather than being delivered here.`,
          via: [],
          segment: { kind: 'otv', vlan: extended.vlan, overlay: extended.overlay, mac, remote: remote.hostname },
        };
        const key2 = `${device.hostname}|otv|${extended.vlan}`;
        if (seen.has(key2)) {
          first.looped ??= { at: device.hostname, path };
          return;
        }
        walk(remote, [...path, hop], new Set([...seen, key2]), target);
        return;
      }
    }

    // Connected: the destination is on a network this device is attached to,
    // which is as far as routing goes.
    if (route.nextHops.length === 0) {
      done.push([
        ...path,
        {
          device: device.hostname,
          prefix: route.prefix,
          protocol: route.protocol,
          table: 'routing',
          nextHop: null,
          outInterface: route.interface ?? null,
          distance: route.distance ?? null,
          metric: route.metric ?? null,
          why: `${why} It is connected, so ${target} is on a network ${device.hostname} is attached to.`,
          via: [],
          ...(policyNotes(device).length ? { notes: policyNotes(device) } : {}),
        },
      ]);
      return;
    }

    // Every next hop: one is a single path, several is ECMP.
    for (const nextHop of route.nextHops) {
      if (done.length >= MAX_PATHS) return;
      // A next hop on a removed device is skipped when the same route offers
      // another; if it is the only one, it falls through to the report below.
      if (onRemovedDevice(nextHop) && route.nextHops.some((h) => !onRemovedDevice(h))) continue;

      // LT-347: the device's own table says this prefix is reached across the
      // overlay — `segid: 50000 tunnelid: 0x… encap: VXLAN`, with the next
      // hop a VTEP resolved in the underlay. That is a **routed** L3 VNI, and
      // `segmentFor` above cannot see it: an L3 VNI carries a VRF rather than
      // a VLAN, so there is no segment prefix for an address to fall inside.
      // The route is the evidence, which is why it is read here.
      const carriedVni = route.segmentId ?? null;
      const remoteEnd =
        carriedVni && device.vtep
          ? up.find((d) => d.vtep?.address.trim() === nextHop.trim())
          : undefined;
      if (
        carriedVni &&
        device.vtep &&
        remoteEnd &&
        !path.some((h) => h.segment?.kind === 'overlay' && h.segment.vni === carriedVni)
      ) {
        const localVtep = device.vtep.address;
        const routed = crossOverlay({
          device,
          remote: remoteEnd,
          vni: carriedVni,
          localVtep,
          remoteVtep: nextHop,
          route,
          target,
          why,
        });
        if (routed.underlay.kind !== 'delivered') {
          first.failure ??= {
            at: device.hostname,
            reason: `${device.hostname} reaches ${route.prefix} over VNI ${carriedVni} to VTEP ${nextHop}, and the underlay between ${localVtep} and ${nextHop} could not be followed: ${
              routed.underlay.kind === 'unreachable' || routed.underlay.kind === 'insufficient'
                ? routed.underlay.reason
                : 'it loops'
            }`,
            path: [...path, routed.overlay],
          };
          continue;
        }
        walk(remoteEnd, [...path, routed.overlay, ...routed.carried, routed.decap], new Set([...seen, key]), target);
        continue;
      }
      // LT-347: the next hop may not live in the table the route does.
      // NX-OS writes `*via 203.0.113.4%default` for a tenant route pointing at
      // a VTEP, and resolving that address in the tenant's table finds
      // nothing — so a path the device is perfectly happy with was reported
      // as "no route resolves this next hop".
      const hopTable = resolutionTable(device, table, route.nextHopVrf);
      const { interface: out, via, resolved } = resolveNextHop(hopTable, nextHop);
      const hop: Hop = {
        device: device.hostname,
        prefix: route.prefix,
        protocol: route.protocol,
        table: 'routing',
        nextHop,
        outInterface: route.interface ?? out,
        distance: route.distance ?? null,
        metric: route.metric ?? null,
        why:
          route.nextHops.length > 1
            ? `${why} One of ${route.nextHops.length} equal-cost next hops.`
            : why,
        // Only the recursive steps are interesting; a directly connected next
        // hop resolving in one step is noise.
        via: via.length > 1 ? via : [],
        ...(named ? { vrf: vrf!.trim() } : {}),
        ...(route.bgp ? { bgp: route.bgp } : {}),
        ...(route.nextHops.length > 1 ? { ecmp: route.nextHops.length } : {}),
        ...(policyNotes(device).length ? { notes: policyNotes(device) } : {}),
      };
      const next = [...path, hop];

      if (!resolved && !route.interface) {
        first.failure ??= {
          at: device.hostname,
          reason: `${device.hostname} points ${route.prefix} at ${nextHop}, and has no route that resolves ${nextHop} to an interface.`,
          path: next,
        };
        continue;
      }

      // Who is on the other end? By the address first — the next hop is an
      // address some device holds — and by the neighbour on that interface
      // when the address belongs to nothing we crawled.
      const onward = deviceAt(up, nextHop) ?? neighbourOn(up, device, hop.outInterface);
      if (!onward) {
        const wasDown = down.has(
          (deviceAt(devices, nextHop)?.hostname ?? '').trim().toLowerCase(),
        );
        first.failure ??= {
          at: device.hostname,
          reason: wasDown
            ? `The next hop ${nextHop} is on a device this simulation has taken out, and ${device.hostname} has no other route.`
            : `${device.hostname} sends ${to} to ${nextHop}${hop.outInterface ? ` out of ${hop.outInterface}` : ''}, and no crawled device holds that address. The path is not followed past here rather than guessed.`,
          path: next,
        };
        continue;
      }
      walk(onward, next, new Set([...seen, key]), target);
    }
  };

  walk(start, [], new Set());

  if (done.length > 0) return { kind: 'delivered', paths: done };
  if (first.looped) return { kind: 'loop', paths: [first.looped.path], at: first.looped.at };
  if (first.insufficient) return { kind: 'insufficient', paths: [first.insufficient.path], reason: first.insufficient.reason };
  if (first.failure) {
    return { kind: 'unreachable', paths: [first.failure.path], at: first.failure.at, reason: first.failure.reason };
  }
  return {
    kind: 'insufficient',
    paths: [],
    reason: `No routing decision could be made on ${start.hostname} for ${to}.`,
  };
}

/** Every device named by a result, for highlighting it on the diagram. */
export function devicesOnPath(result: TraceResult): string[] {
  const names = new Set<string>();
  for (const path of result.paths) for (const hop of path) names.add(hop.device);
  return [...names];
}
