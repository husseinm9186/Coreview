/**
 * A crawled device's tables, as they are kept on its node (LT-200–204).
 *
 * The crawl sends everything it read; the diagram keeps what an engineer looks
 * things up in — each port with its status, speed and VLAN mode, the VLANs,
 * the routes, and for spanning tree only the root and the ports not
 * forwarding — so a large switch does not carry every STP port row in the
 * project file.
 */
import type { CrawledDevice } from './ipc';
import { shortInterface } from './topology';
import type { DeviceInventory, InventoryPort } from '../types/domain';

/** `[1,8,10,14,15,16]` as `1,8,10,14-16`. */
export function compressVlans(vlans: readonly number[]): string {
  const sorted = [...new Set(vlans)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i + 1 ? `${sorted[i]}-${sorted[j]}` : j === i + 1 ? `${sorted[i]},${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return parts.join(',');
}

const BLOCKED_STATES = new Set(['BLK', 'DIS', 'BKN']);
const BLOCKED_ROLES = new Set(['Altn', 'Back']);

export function inventoryOf(d: CrawledDevice, collectedAt: number): DeviceInventory | undefined {
  const routes = d.routes ?? [];
  const stp = d.spanningTree ?? [];
  const vlans = d.vlans ?? [];
  const ports = d.ports ?? [];
  const modes = new Map((d.portVlans ?? []).map((p) => [p.port, p]));
  // LT-235: counters come by full name (`GigabitEthernet0/1`), ports by short.
  const counters = new Map((d.counters ?? []).map((c) => [shortInterface(c.port).toLowerCase(), c]));
  if (!routes.length && !stp.length && !vlans.length && !ports.length && d.uptimeSeconds == null) return undefined;
  return {
    collectedAt,
    ...(d.uptimeSeconds != null ? { uptimeSeconds: d.uptimeSeconds } : {}),
    ports: ports.map((p): InventoryPort => {
      const m = modes.get(p.port);
      return {
        port: p.port,
        ...(p.description ? { description: p.description } : {}),
        status: p.status,
        ...(p.speed ? { speed: p.speed } : {}),
        ...(p.duplex ? { duplex: p.duplex } : {}),
        ...(m ? { mode: m.mode } : {}),
        ...(m?.vlan != null ? { vlan: m.vlan } : {}),
        ...(m && m.trunkVlans.length ? { trunkVlans: compressVlans(m.trunkVlans) } : {}),
        ...((): Partial<InventoryPort> => {
          const c = counters.get(shortInterface(p.port).toLowerCase());
          return c ? { errors: { input: c.inputErrors, crc: c.crc, output: c.outputErrors, collisions: c.collisions, resets: c.resets, drops: c.outputDrops } } : {};
        })(),
      };
    }),
    vlans: vlans.map((v) => ({ id: v.id, name: v.name })),
    routes: routes.map((r) => ({
      family: r.family,
      prefix: r.prefix,
      protocol: r.protocol,
      nextHops: r.nextHops,
      ...(r.interface ? { interface: r.interface } : {}),
    })),
    spanningTree: stp.map((i) => ({
      instance: i.instance,
      ...(i.vlan != null ? { vlan: i.vlan } : {}),
      ...(i.rootBridge ? { rootBridge: i.rootBridge } : {}),
      isRoot: i.isRoot,
      ...(i.rootPort ? { rootPort: i.rootPort } : {}),
      blocked: i.ports.filter((p) => BLOCKED_STATES.has(p.state) || BLOCKED_ROLES.has(p.role)).map((p) => p.port),
    })),
  };
}

/** `5019180` as `58d 2h`. */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
