/**
 * Choosing which silent devices belong on the diagram.
 *
 * A switch knows about everything plugged into it, and on a flat /24 that can
 * be two hundred things. Drawing all of them buries the topology the diagram
 * exists to show, so nothing is drawn unless it is asked for.
 *
 * The filter is deliberately about what someone is looking for — a vendor, a
 * subnet, a particular port — rather than a count. "Show me the Axis cameras"
 * is a question about a network; "show me the first fifty" is not.
 */
import type { AttachedDevice, CrawledDevice } from './ipc';
import { subnetOf } from './subnetGroups';

export interface AttachedFilter {
  /** Substring of the maker's name, case-insensitive. Empty matches any. */
  vendor?: string;
  /** Only devices whose address is in this /24. Empty matches any. */
  subnet?: string;
  /** Substring of the port name, case-insensitive. Empty matches any. */
  port?: string;
  /** Skip anything on a port carrying more than this many addresses. A port
   *  with twenty leads to another switch, and what is behind it belongs to
   *  that switch's diagram rather than this one. */
  maxPerPort?: number;
  /** Only devices whose address is known. Something with no address can be
   *  drawn but never checked. */
  addressedOnly?: boolean;
}

/** One silent device, and which switch port it hangs off. */
export interface AttachedOn {
  device: AttachedDevice;
  /** Hostname of the switch that learned it. */
  host: string;
}

/** Everything the crawl saw attached, before any filtering. */
export function allAttached(devices: CrawledDevice[]): AttachedOn[] {
  return devices.flatMap((d) => (d.attached ?? []).map((a) => ({ device: a, host: d.hostname })));
}

/**
 * What someone typed, as a /24 to compare against.
 *
 * People write a subnet three ways — "192.168.77.0/24", "192.168.77.0" and
 * just "192.168.77" — and `subnetOf` only understands the middle one, because
 * a prefix length is not an octet.
 */
function asSubnet(query: string): string | null {
  const bare = query.trim().split('/')[0]?.trim() ?? '';
  if (!bare) return null;
  const octets = bare.split('.').filter((p) => p !== '');
  if (octets.length === 3) return subnetOf(`${octets.join('.')}.0`);
  if (octets.length === 4) return subnetOf(bare);
  return null;
}

/** Whether one device answers the question being asked. */
export function matchesFilter(a: AttachedDevice, filter: AttachedFilter): boolean {
  const { vendor, subnet, port, maxPerPort, addressedOnly } = filter;

  if (vendor?.trim()) {
    const want = vendor.trim().toLowerCase();
    if (!(a.vendor ?? '').toLowerCase().includes(want)) return false;
  }
  if (subnet?.trim()) {
    const want = asSubnet(subnet);
    if (!want) return false;
    if (!a.address || subnetOf(a.address) !== want) return false;
  }
  if (port?.trim()) {
    if (!a.port.toLowerCase().includes(port.trim().toLowerCase())) return false;
  }
  if (maxPerPort !== undefined && a.portPopulation > maxPerPort) return false;
  if (addressedOnly && !a.address) return false;
  return true;
}

/**
 * Which sighting of one MAC to believe (LT-339).
 *
 * A MAC is learned by every switch between it and the seed, so the same
 * printer is reported by three of them. Something has to choose, and what this
 * used to choose was *the first sighting*, meaning the switch nearest the
 * seed — which is a fact about where the crawl started rather than about where
 * the printer is plugged in.
 *
 * **The rule, and it is the one every network management system uses: the
 * switch that sees it on the quietest port wins.** A switch seeing a MAC among
 * thirty others is seeing it through something; a switch seeing it alone on a
 * port has it in front of it. Port population is a count the switch itself
 * reported, so this is arithmetic over evidence rather than a guess.
 *
 * Ties are broken towards the sighting that knows more — an address resolved
 * from ARP — and then by host name, so the answer does not depend on the order
 * devices happened to be crawled in.
 */
export function bestSighting(sightings: AttachedOn[]): AttachedOn {
  return sightings.reduce((best, one) => {
    if (one.device.portPopulation !== best.device.portPopulation) {
      return one.device.portPopulation < best.device.portPopulation ? one : best;
    }
    const knows = (s: AttachedOn) => (s.device.address ? 1 : 0);
    if (knows(one) !== knows(best)) return knows(one) > knows(best) ? one : best;
    return one.host.localeCompare(best.host) < 0 ? one : best;
  });
}

/** Every sighting of every MAC, grouped. */
export function sightingsByMac(devices: CrawledDevice[]): Map<string, AttachedOn[]> {
  const byMac = new Map<string, AttachedOn[]>();
  for (const entry of allAttached(devices)) {
    const list = byMac.get(entry.device.mac);
    if (list) list.push(entry);
    else byMac.set(entry.device.mac, [entry]);
  }
  return byMac;
}

/**
 * The devices to draw, one place each.
 *
 * **Resolved before filtered**, which is the order that matters: filtering
 * first and deduplicating afterwards lets a filter knock out the true sighting
 * and leave a worse one standing, so a device would attach to the switch that
 * happened to survive rather than the switch it is on. A MAC that is only ever
 * seen on crowded ports is genuinely behind something — that is LT-336's
 * inferred switch, not an endpoint to draw here.
 */
export function selectAttached(
  devices: CrawledDevice[],
  filter: AttachedFilter,
): AttachedOn[] {
  const out: AttachedOn[] = [];
  for (const sightings of sightingsByMac(devices).values()) {
    const best = bestSighting(sightings);
    if (matchesFilter(best.device, filter)) out.push(best);
  }
  return out;
}

/** Every maker seen, with how many of each, for offering as choices. */
export function vendorCounts(devices: CrawledDevice[]): { vendor: string; count: number }[] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const { device } of allAttached(devices)) {
    if (seen.has(device.mac)) continue;
    seen.add(device.mac);
    const name = device.vendor ?? 'Unknown maker';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([vendor, count]) => ({ vendor, count }))
    // Commonest first: the thing someone wants is usually the thing there is
    // a lot of.
    .sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor));
}

/**
 * How many devices behind one port before it is a switch rather than a socket
 * (LT-336).
 *
 * Two is the honest lower bound — two MACs on one access port means something
 * is bridging — but the commonest cause of exactly two is a desk phone with a
 * PC plugged into its back, and a phone *is* a three-port switch. Calling that
 * "an unmanaged switch" is true and useless. Three is where it starts being
 * worth drawing.
 */
export const INFERRED_MINIMUM = 3;

/** A switch nobody manages, deduced from a crowded port (LT-336). */
export interface InferredSwitch {
  /** The crawled switch that sees the crowd. */
  host: string;
  /** Its port, as the switch writes it. */
  port: string;
  /** The MACs behind it, in the order they were learned. */
  macs: string[];
}

/**
 * Ports with several devices behind them and no neighbour that announced
 * itself (LT-336).
 *
 * **The "no neighbour" half is already decided by the time this runs**, and
 * that is what makes the inference safe: the crawler excludes every port with
 * an LLDP or CDP neighbour from `attached` before the front end sees it, so a
 * crowded port still in this list is one where the crawl asked and nothing
 * answered. The count is a number the switch itself reported. Neither half is
 * a guess; what stays unknown is what the box *is*, and the drawn node says so.
 *
 * Takes the already-resolved sightings, so it agrees with LT-339 about where
 * each MAC lives rather than counting the same device on three switches.
 */
export function inferredSwitches(chosen: AttachedOn[], atLeast = INFERRED_MINIMUM): InferredSwitch[] {
  const byPort = new Map<string, InferredSwitch>();
  for (const { device, host } of chosen) {
    const key = `${host} :: ${device.port}`;
    const held = byPort.get(key);
    if (held) held.macs.push(device.mac);
    else byPort.set(key, { host, port: device.port, macs: [device.mac] });
  }
  return [...byPort.values()]
    .filter((s) => s.macs.length >= atLeast)
    .sort((a, b) => b.macs.length - a.macs.length || a.host.localeCompare(b.host) || a.port.localeCompare(b.port));
}

/** Whether this sighting sits behind one of the inferred switches. */
export function behindInferred(entry: AttachedOn, inferred: InferredSwitch[]): InferredSwitch | undefined {
  return inferred.find((s) => s.host === entry.host && s.port === entry.device.port);
}

/** LT-464: one attached device as a row somebody can read, before it is
 *  drawn. The subnet is the /24 its address is in, the way the filter
 *  reads it; a device with no address has none. */
export interface AttachedRow {
  address: string;
  mac: string;
  vendor: string;
  hostname: string;
  subnet: string;
  host: string;
  port: string;
  vlan: string;
}

export type AttachedColumn = keyof AttachedRow;

export function attachedRows(chosen: readonly AttachedOn[]): AttachedRow[] {
  return chosen.map(({ device, host }) => ({
    address: device.address ?? '',
    mac: device.mac,
    vendor: device.vendor ?? '',
    hostname: device.hostname ?? '',
    subnet: (device.address ? subnetOf(device.address) : null) ?? '',
    host,
    port: device.port,
    vlan: device.vlan ?? '',
  }));
}

/** Addresses sort as addresses (10.0.0.9 before 10.0.0.10); everything else
 *  as text, case-insensitively; an empty cell always sorts last. */
export function sortAttachedRows(rows: readonly AttachedRow[], key: AttachedColumn, dir: 1 | -1): AttachedRow[] {
  const ip = (s: string) => s.split('.').map(Number);
  const compare = (a: string, b: string) => {
    if (key === 'address' || key === 'subnet') {
      const [x, y] = [ip(a), ip(b)];
      if (x.length === 4 && y.length === 4 && x.every(Number.isFinite) && y.every(Number.isFinite)) {
        for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
        return 0;
      }
    }
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  };
  return [...rows].sort((a, b) => {
    const [x, y] = [a[key], b[key]];
    // An empty cell is last whichever way the column is sorted.
    if (!x || !y) return !x && !y ? 0 : !x ? 1 : -1;
    return dir * compare(x, y);
  });
}

