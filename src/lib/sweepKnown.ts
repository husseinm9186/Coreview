/**
 * What the diagram already knows about a swept host (LT-125), and how a sweep
 * may update a device it did not draw (LT-155).
 *
 * A ping sweep learns an address, a MAC, a name from whoever answers, and
 * open ports. A crawl learns far more — the device's own hostname, its model
 * and serial, the switch port it hangs off — and writes all of it onto the
 * diagram. The two halves used to know nothing about each other, so a host
 * the crawler had named was still a dash in the sweep's table.
 *
 * The diagram is the source, not the crawl panel: crawl results live only in
 * that panel's memory and are gone after a restart, while what was drawn is
 * saved with the project. The match is the same multi-key identity the crawl
 * and the sweep already share (`findDrawnNode`: MAC, then address, then name).
 */
import type { DeviceNodeData } from '../types/domain';
import { findDrawnNode } from './topology';

type DrawnNodes = Parameters<typeof findDrawnNode>[0];

export interface SweptHost {
  ip: string;
  hostname: string | null;
  mac: string | null;
  vendor: string | null;
  ports: { port: number; service: string }[];
  /** From the host's certificate (LT-124), where it carried one. */
  serial?: string | null;
}

/** A drawn device's knowledge, as the sweep table shows it. */
export interface KnownDevice {
  nodeId: string;
  label: string;
  hostname?: string;
  model?: string;
  serial?: string;
  osVersion?: string;
  switchPort?: string;
  discoveredVia?: string;
}

const SWEEP = 'Ping sweep';

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * A first guess at a subnet's gateway: its first usable address, which is where
 * most networks put the router (LT-124). Only a starting value for a field the
 * operator can change; empty for anything that is not an IPv4 CIDR.
 */
export function gatewayGuess(cidr: string): string {
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})\s*$/.exec(cidr);
  if (!m) return '';
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 30) return '';
  const ip = octets.reduce((acc, o) => (acc * 256) + o, 0);
  const size = 2 ** (32 - prefix);
  const first = Math.floor(ip / size) * size + 1;
  return [24, 16, 8, 0].map((shift) => Math.floor(first / 2 ** shift) % 256).join('.');
}

/** The drawn device this host is, or null when nothing on the diagram is. */
export function knownOnDiagram(nodes: DrawnNodes, host: SweptHost): KnownDevice | null {
  const id = findDrawnNode(nodes, { mac: host.mac, address: host.ip, name: host.hostname });
  if (!id) return null;
  const node = nodes.find((n) => n.id === id);
  if (!node) return null;
  const d = (node.data ?? {}) as Partial<DeviceNodeData>;
  return {
    nodeId: id,
    label: text(d.label) ?? host.ip,
    hostname: text(d.hostname),
    model: text(d.model),
    serial: text(d.serial),
    osVersion: text(d.osVersion),
    switchPort: text(d.switchPort),
    discoveredVia: text(d.discoveredVia),
  };
}

/**
 * What a sweep writes onto a device that is already drawn (LT-155).
 *
 * The sweep is the authority on what it proved itself: the ports that
 * answered. For the rest it only fills gaps. A MAC or manufacturer the device
 * lacks is added; a hostname is added only when there is none, because a name
 * the device gave over SSH outranks one a neighbour answered over mDNS; and
 * `discoveredVia` is only claimed for a device nothing else has claimed, so the
 * record of a crawl logging in is not rewritten as "Ping sweep".
 */
export function sweepPatch(existing: Partial<DeviceNodeData>, host: SweptHost): Partial<DeviceNodeData> {
  const patch: Partial<DeviceNodeData> = {};
  if (host.mac && !text(existing.mac)) patch.mac = host.mac;
  if (host.vendor && !text(existing.vendor)) patch.vendor = host.vendor;
  if (host.hostname && !text(existing.hostname)) patch.hostname = host.hostname;
  // A serial from a certificate fills a gap; one a crawl read off the device
  // (or someone typed) is not replaced.
  if (host.serial && !text(existing.serial)) patch.serial = host.serial;
  if (host.ports.length) patch.openPorts = host.ports.map((p) => `${p.port}/${p.service}`).join(', ');
  if (!text(existing.discoveredVia)) patch.discoveredVia = SWEEP;
  return patch;
}
