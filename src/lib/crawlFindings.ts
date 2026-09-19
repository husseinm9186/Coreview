/**
 * What is wrong with the network a crawl found (LT-213): the things an
 * engineer would otherwise find by staring at the diagram.
 *
 * - **One-way links** — A reports B as a neighbour and B, also logged into,
 *   does not report A: a duplex or cabling fault, or CDP/LLDP off on one end.
 * - **Links not seen** — drawn on the diagram between two devices this crawl
 *   reached, but neither reported them. Unplugged, or never there.
 * - **Unidentified links** — a trunk port that is up with no neighbour on it:
 *   something is connected that did not say what it is.
 * - **Loops** — links forming a cycle with no port on it blocked by spanning
 *   tree. A cycle that *is* broken by a blocked port is a redundant path, not a
 *   loop, and is reported as a blocked link instead.
 * - **Blocked links** — a link whose port spanning tree has blocked.
 * - **Orphans** — a device reached with no link to anything.
 * - **Duplicate MACs** — one MAC learned as the only device on two different
 *   switch ports: a cloned VM, a MAC someone typed, or a bridge loop.
 *
 * Observation only. Nothing here is inferred from names or port numbers; each
 * finding says which devices and ports it is about.
 */
import type { CrawledDevice, CrawlResult } from './ipc';
import { macKey, shortInterface } from './topology';

export type FindingKind = 'one-way' | 'not-seen' | 'unidentified' | 'loop' | 'blocked' | 'orphan' | 'duplicate-mac';

export interface Finding {
  kind: FindingKind;
  severity: 'warning' | 'info';
  message: string;
  devices: string[];
}

/** A link drawn on the diagram, by device hostname and port. */
export interface DrawnLink {
  a: string;
  b: string;
}

export const FINDING_LABEL: Record<FindingKind, string> = {
  'one-way': 'One-way link',
  'not-seen': 'Link not seen',
  unidentified: 'Unidentified link',
  loop: 'Loop',
  blocked: 'Blocked by spanning tree',
  orphan: 'Orphan',
  'duplicate-mac': 'Duplicate MAC',
};

const key = (name: string) => name.trim().toLowerCase();
const port = (name: string | null | undefined) => (name ? shortInterface(name).toLowerCase() : '');

/** The bundle a port belongs to on a device, or the port itself. */
function bundleOf(d: CrawledDevice, p: string): string {
  const pc = (d.portChannels ?? []).find((c) => c.members.some((m) => port(m) === p));
  return pc ? port(pc.name) : p;
}

/** The same, as a diagram writes it: `Po1`, `Gi0/2`. */
function bundleShown(d: CrawledDevice | undefined, raw: string | null | undefined): string {
  const p = port(raw);
  const pc = d && (d.portChannels ?? []).find((c) => c.members.some((m) => port(m) === p));
  return pc ? shortInterface(pc.name) : shortInterface(raw ?? '');
}

function blockedPorts(d: CrawledDevice): Set<string> {
  const out = new Set<string>();
  for (const i of d.spanningTree ?? []) {
    for (const p of i.ports) {
      if (['BLK', 'DIS', 'BKN'].includes(p.state) || ['Altn', 'Back'].includes(p.role)) out.add(port(p.port));
    }
  }
  return out;
}

interface Link {
  a: string;
  b: string;
  aPort: string;
  bPort: string;
  aShown: string;
  bShown: string;
}

export function crawlFindings(result: Pick<CrawlResult, 'devices'>, drawn: readonly DrawnLink[] = []): Finding[] {
  const findings: Finding[] = [];
  const reached = new Map<string, CrawledDevice>();
  for (const d of result.devices) if (d.reachedBy !== 'reported') reached.set(key(d.hostname), d);
  const all = new Map<string, CrawledDevice>();
  for (const d of result.devices) all.set(key(d.hostname), d);

  // Every reported adjacency, and the physical links they make, once each.
  const links = new Map<string, Link>();
  const reports = new Set<string>();
  for (const d of result.devices) {
    const self = key(d.hostname);
    for (const n of d.neighbors) {
      const other = key(n.shortName || n.deviceId);
      if (!other || other === self) continue;
      reports.add(`${self}>${other}`);
      const aPort = bundleOf(d, port(n.localInterface));
      const peer = all.get(other);
      const bPort = peer ? bundleOf(peer, port(n.remoteInterface)) : port(n.remoteInterface);
      const [x, y] = [`${self}|${aPort}`, `${other}|${bPort}`].sort();
      const k = `${x}::${y}`;
      const aShown = bundleShown(d, n.localInterface);
      const bShown = bundleShown(peer, n.remoteInterface);
      if (!links.has(k)) {
        links.set(k, self < other
          ? { a: self, b: other, aPort, bPort, aShown, bShown }
          : { a: other, b: self, aPort: bPort, bPort: aPort, aShown: bShown, bShown: aShown });
      }
    }
  }

  // One-way links.
  for (const d of reached.values()) {
    const self = key(d.hostname);
    for (const n of d.neighbors) {
      const other = key(n.shortName || n.deviceId);
      const peer = reached.get(other);
      if (!peer || peer.reachedBy === 'snmp' || d.reachedBy === 'snmp') continue;
      if (!reports.has(`${other}>${self}`)) {
        findings.push({
          kind: 'one-way',
          severity: 'warning',
          message: `${d.hostname} sees ${peer.hostname} on ${shortInterface(n.localInterface ?? '?')}, but ${peer.hostname} does not see ${d.hostname}.`,
          devices: [d.hostname, peer.hostname],
        });
      }
    }
  }

  // Links on the diagram that neither end reported.
  const linked = new Set([...links.values()].map((l) => [l.a, l.b].sort().join('|')));
  for (const l of drawn) {
    const a = reached.get(key(l.a));
    const b = reached.get(key(l.b));
    if (!a || !b || a === b) continue;
    if (!linked.has([key(l.a), key(l.b)].sort().join('|'))) {
      findings.push({
        kind: 'not-seen',
        severity: 'warning',
        message: `The diagram links ${a.hostname} and ${b.hostname}, but neither reported the other.`,
        devices: [a.hostname, b.hostname],
      });
    }
  }

  // Up trunks with nothing identified on them.
  for (const d of reached.values()) {
    const withNeighbour = new Set(d.neighbors.map((n) => bundleOf(d, port(n.localInterface))));
    const modes = new Map((d.portVlans ?? []).map((p) => [port(p.port), p.mode]));
    for (const p of d.ports ?? []) {
      const name = port(p.port);
      if (p.status !== 'connected' || modes.get(name) !== 'trunk') continue;
      if (withNeighbour.has(name) || withNeighbour.has(bundleOf(d, name))) continue;
      findings.push({
        kind: 'unidentified',
        severity: 'info',
        message: `${d.hostname} ${p.port} is an up trunk with no neighbour reporting on it.`,
        devices: [d.hostname],
      });
    }
  }

  // Blocked links, and loops nothing blocks.
  const blocked = new Map([...all.values()].map((d) => [key(d.hostname), blockedPorts(d)]));
  const isBlocked = (l: Link) => blocked.get(l.a)?.has(l.aPort) || blocked.get(l.b)?.has(l.bPort);
  const list = [...links.values()];
  for (const l of list) {
    if (!isBlocked(l)) continue;
    findings.push({
      kind: 'blocked',
      severity: 'info',
      message: `${all.get(l.a)?.hostname ?? l.a} ${l.aShown} – ${all.get(l.b)?.hostname ?? l.b} ${l.bShown} is blocked by spanning tree: a redundant path, not carrying traffic.`,
      devices: [all.get(l.a)?.hostname ?? l.a, all.get(l.b)?.hostname ?? l.b],
    });
  }
  for (const cycle of cycles(list)) {
    if (cycle.some(isBlocked)) continue;
    const names = [...new Set(cycle.flatMap((l) => [l.a, l.b]))].map((n) => all.get(n)?.hostname ?? n);
    findings.push({
      kind: 'loop',
      severity: 'warning',
      message: `${names.join(', ')} are joined in a loop, and no port on it is blocked by spanning tree.`,
      devices: names,
    });
  }

  // Orphans.
  const touched = new Set(list.flatMap((l) => [l.a, l.b]));
  for (const d of reached.values()) {
    if (touched.has(key(d.hostname)) || (d.attached ?? []).length > 0) continue;
    findings.push({
      kind: 'orphan',
      severity: 'info',
      message: `${d.hostname} was reached but has no link to anything the crawl found.`,
      devices: [d.hostname],
    });
  }

  // Duplicate MACs: the only device on two different ports.
  const seenOn = new Map<string, { device: string; port: string }[]>();
  for (const d of result.devices) {
    for (const a of d.attached ?? []) {
      const mac = macKey(a.mac);
      if (!mac || a.portPopulation !== 1) continue;
      const where = seenOn.get(mac) ?? [];
      if (!where.some((w) => w.device === d.hostname && port(w.port) === port(a.port))) where.push({ device: d.hostname, port: a.port });
      seenOn.set(mac, where);
    }
  }
  for (const [mac, where] of seenOn) {
    if (where.length < 2) continue;
    findings.push({
      kind: 'duplicate-mac',
      severity: 'warning',
      message: `${mac.match(/../g)!.join(':')} is the only device on ${where.map((w) => `${w.device} ${shortInterface(w.port)}`).join(' and ')}.`,
      devices: [...new Set(where.map((w) => w.device))],
    });
  }

  const order: FindingKind[] = ['loop', 'duplicate-mac', 'one-way', 'not-seen', 'blocked', 'unidentified', 'orphan'];
  return findings.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind));
}

/**
 * The groups of links that lie on a cycle: every link that is not a bridge,
 * grouped by the component those links form. Parallel links between the same
 * two devices on different ports are a cycle too — two cables not bundled.
 */
function cycles(links: readonly Link[]): Link[][] {
  const adj = new Map<string, { to: string; id: number }[]>();
  links.forEach((l, id) => {
    adj.set(l.a, [...(adj.get(l.a) ?? []), { to: l.b, id }]);
    adj.set(l.b, [...(adj.get(l.b) ?? []), { to: l.a, id }]);
  });
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges = new Set<number>();
  let time = 0;
  const visit = (u: string, viaEdge: number) => {
    disc.set(u, time);
    low.set(u, time);
    time++;
    for (const { to, id } of adj.get(u) ?? []) {
      if (id === viaEdge) continue;
      if (!disc.has(to)) {
        visit(to, id);
        low.set(u, Math.min(low.get(u)!, low.get(to)!));
        if (low.get(to)! > disc.get(u)!) bridges.add(id);
      } else {
        low.set(u, Math.min(low.get(u)!, disc.get(to)!));
      }
    }
  };
  for (const node of adj.keys()) if (!disc.has(node)) visit(node, -1);

  // Components of the non-bridge links.
  const inCycle = links.map((_, id) => id).filter((id) => !bridges.has(id));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== undefined && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const id of inCycle) {
    const { a, b } = links[id]!;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const groups = new Map<string, Link[]>();
  for (const id of inCycle) {
    const root = find(links[id]!.a);
    groups.set(root, [...(groups.get(root) ?? []), links[id]!]);
  }
  return [...groups.values()];
}
