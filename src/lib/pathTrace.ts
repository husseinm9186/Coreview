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
 * - A VRF other than the default reports `insufficient`. Routes are collected
 *   from the global table only; using them to answer a question about a VRF
 *   would be confidently wrong, which is the worst kind (D-050).
 * - VXLAN and EVPN report `insufficient`. Nothing in the crawler collects
 *   VTEPs, VNIs or EVPN routes, so an overlay path would be invented.
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
  /** Its routing table. Absent — not empty — when it was never collected. */
  routes?: PathRoute[];
  /** Who is on the other end of each of its interfaces. */
  neighbours?: { localInterface?: string | null; name: string }[];
}

export interface PathRoute {
  family?: number;
  prefix: string;
  /** The device's own word: `connected`, `static`, `ospf`, `bgp`. */
  protocol: string;
  /** Where it sends traffic. Several means equal-cost (ECMP). */
  nextHops: string[];
  interface?: string | null;
  distance?: number | null;
  metric?: number | null;
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
  /** Recursive resolution: a BGP next-hop resolved through the IGP, and so
   *  on. Empty when the next hop was directly connected. */
  via: { prefix: string; protocol: string; nextHop: string | null }[];
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
  /** LT-346: devices and links to pretend are down. Nothing is changed on any
   *  device — this is a filter over the graph we already hold. */
  without?: { devices?: string[] };
}

const isDefaultVrf = (vrf: string | undefined) =>
  !vrf || ['', 'default', 'global', 'inet.0', 'main'].includes(vrf.trim().toLowerCase());

/**
 * Follow the routing decisions from one device to an address.
 *
 * Every branch of an ECMP route is followed, up to `MAX_PATHS`. A path that
 * ends at the destination is `delivered`; one that runs out of routes is
 * `unreachable` and says where and why.
 */
export function tracePath(request: TraceRequest): TraceResult {
  const { devices, to, vrf } = request;

  // D-050: routes are collected from the global table only. Answering a VRF
  // question from the global table is confidently wrong.
  if (!isDefaultVrf(vrf)) {
    return {
      kind: 'insufficient',
      paths: [],
      reason:
        `Routes are collected from the global table only, so a path through VRF "${vrf}" cannot be worked out. ` +
        'Nothing here guesses it from the default table.',
    };
  }

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
  } = { failure: null, looped: null };

  /** One branch of the walk. `seen` is per-branch: two ECMP legs may
   *  legitimately pass through the same device without that being a loop. */
  const walk = (device: PathDevice, path: Hop[], seen: Set<string>) => {
    if (done.length >= MAX_PATHS) return;

    // Arrived: the destination is one of this device's own addresses, or sits
    // in something it is directly connected to.
    if (device.addresses.some((a) => a.ip.trim() === to.trim())) {
      done.push(path);
      return;
    }

    if (device.routes === undefined) {
      first.failure ??= {
        at: device.hostname,
        reason: `${device.hostname} was reached but its routing table was not collected, so the path cannot be followed past it. Run a crawl with "Routing table" ticked.`,
        path,
      };
      return;
    }

    // Best first. Normally only the first is used; while simulating a failure
    // the next one is tried when the best route's next hop is on a device that
    // has been taken out — that alternate is in the device's own table, so
    // using it is reading routing rather than inventing reconvergence.
    const candidates = rankedRoutes(device.routes, to);
    const onRemovedDevice = (nextHop: string) =>
      down.size > 0 && down.has((deviceAt(devices, nextHop)?.hostname ?? '\u0000').trim().toLowerCase());
    const usable = candidates.filter(
      (r) => r.nextHops.length === 0 || r.nextHops.some((h) => !onRemovedDevice(h)),
    );
    const route = usable[0] ?? candidates[0];
    if (!route) {
      first.failure ??= {
        at: device.hostname,
        reason: `${device.hostname} has no route to ${to}, not even a default. It would drop the packet.`,
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
      ? `${reasonFor(route, device.routes, to)} Taken because the preferred route's next hop is on a device this simulation removed; it is already in ${device.hostname}'s table.`
      : reasonFor(route, device.routes, to);
    // Connected: the destination is on a network this device is attached to,
    // which is as far as routing goes.
    if (route.nextHops.length === 0) {
      done.push([
        ...path,
        {
          device: device.hostname,
          prefix: route.prefix,
          protocol: route.protocol,
          nextHop: null,
          outInterface: route.interface ?? null,
          distance: route.distance ?? null,
          metric: route.metric ?? null,
          why: `${why} It is connected, so ${to} is on a network ${device.hostname} is attached to.`,
          via: [],
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
      const { interface: out, via, resolved } = resolveNextHop(device.routes, nextHop);
      const hop: Hop = {
        device: device.hostname,
        prefix: route.prefix,
        protocol: route.protocol,
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
      walk(onward, next, new Set([...seen, key]));
    }
  };

  walk(start, [], new Set());

  if (done.length > 0) return { kind: 'delivered', paths: done };
  if (first.looped) return { kind: 'loop', paths: [first.looped.path], at: first.looped.at };
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
