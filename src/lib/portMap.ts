/**
 * What is plugged into every port, and which ports are free.
 *
 * The question this answers is the one that gets asked before somebody orders
 * another switch: *how many ports have I actually got left?* It is also the
 * table an auditor wants — port, description, VLAN, speed, and what was seen
 * on it — and every column of it is already collected. Nothing here reaches
 * the network.
 *
 * **"Free" is defined narrowly and deliberately.** A port is free when the
 * switch says nothing is connected to it, *and* it has learned no MAC, *and*
 * no neighbour announced itself on it. All three, because any one of them
 * alone is wrong often enough to matter: a port can read `notconnect` for a
 * device that is asleep, and a port can have learned nothing since the last
 * time its table aged out.
 *
 * A port that is **shut** is reported apart from one that is free. Both are
 * capacity, but reclaiming a shut port is somebody's decision — it was
 * probably shut on purpose — and a count that merges the two overstates what
 * is available.
 */
import type { CrawledDevice } from './ipc';
import { shortInterface } from './topology';

export interface PortMapRow {
  device: string;
  /** As the switch writes it. */
  port: string;
  description: string;
  /** The switch's own word: `connected`, `notconnect`, `disabled`, `up`… */
  status: string;
  vlan: string;
  speed: string;
  duplex: string;
  /** What the MAC table learned on it. */
  learned: { mac: string; address: string | null; vendor: string | null; hostname: string | null }[];
  /** A device that announced itself on this port, by name. */
  neighbour: string | null;
  /** Nothing connected, nothing learned, nobody announced. */
  free: boolean;
  /** Shut rather than free: capacity, but somebody shut it. */
  shut: boolean;
}

const norm = (p: string) => shortInterface(p).toLowerCase();

/** Words a switch uses for a port with nothing on the other end. */
function looksDisconnected(status: string): boolean {
  const s = status.trim().toLowerCase();
  return s === 'notconnect' || s === 'down' || s === 'nolink' || s === 'notconnected' || s === '';
}

/** Words a switch uses for a port somebody turned off. */
function looksShut(status: string): boolean {
  const s = status.trim().toLowerCase();
  return s.includes('disabled') || s.includes('shutdown') || s === 'admin down' || s === 'administratively down';
}

/**
 * Every port of every crawled device that reported its ports, with what is on
 * it.
 *
 * A device that was reached but not asked for port status contributes nothing
 * — an empty port map is honest, and inventing rows from the MAC table alone
 * would list only the ports that are busy, which is the opposite of the
 * question.
 */
export function portMap(devices: CrawledDevice[]): PortMapRow[] {
  const rows: PortMapRow[] = [];
  for (const d of devices) {
    const ports = d.ports ?? [];
    if (ports.length === 0) continue;

    // What the MAC table learned, by port.
    const learnedBy = new Map<string, PortMapRow['learned']>();
    for (const a of d.attached ?? []) {
      const key = norm(a.port);
      const list = learnedBy.get(key) ?? [];
      list.push({ mac: a.mac, address: a.address, vendor: a.vendor, hostname: a.hostname });
      learnedBy.set(key, list);
    }
    // Who announced themselves, by port.
    const neighbourBy = new Map<string, string>();
    for (const n of d.neighbors ?? []) {
      if (n.localInterface) neighbourBy.set(norm(n.localInterface), n.shortName || n.deviceId);
    }

    for (const p of ports) {
      const key = norm(p.port);
      const learned = learnedBy.get(key) ?? [];
      const neighbour = neighbourBy.get(key) ?? null;
      const shut = looksShut(p.status);
      rows.push({
        device: d.hostname,
        port: p.port,
        description: p.description ?? '',
        status: p.status ?? '',
        vlan: p.vlan ?? '',
        speed: p.speed ?? '',
        duplex: p.duplex ?? '',
        learned,
        neighbour,
        free: !shut && looksDisconnected(p.status) && learned.length === 0 && neighbour === null,
        shut,
      });
    }
  }
  return rows;
}

/** How many ports each device has, and how many of them are going spare. */
export function portTotals(rows: PortMapRow[]): { device: string; ports: number; free: number; shut: number; used: number }[] {
  const by = new Map<string, { device: string; ports: number; free: number; shut: number; used: number }>();
  for (const r of rows) {
    const held = by.get(r.device) ?? { device: r.device, ports: 0, free: 0, shut: 0, used: 0 };
    held.ports += 1;
    if (r.free) held.free += 1;
    else if (r.shut) held.shut += 1;
    else held.used += 1;
    by.set(r.device, held);
  }
  return [...by.values()].sort((a, b) => b.free - a.free || a.device.localeCompare(b.device));
}

/** One cell, with anything that would break a CSV taken out. */
function cell(value: string): string {
  const v = value.replace(/[\r\n]+/g, ' ').trim();
  return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * The port map as a CSV, for the spreadsheet somebody has to hand over.
 *
 * One row per port, including the free ones — a report that lists only the
 * busy ports cannot answer "how many have I got left", which is most of why
 * anyone asks for it.
 */
export function portMapCsv(rows: PortMapRow[]): string {
  const head = [
    'Device', 'Port', 'Description', 'Status', 'VLAN', 'Speed', 'Duplex',
    'State', 'Neighbour', 'Devices', 'MACs', 'Addresses',
  ];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.device,
        r.port,
        r.description,
        r.status,
        r.vlan,
        r.speed,
        r.duplex,
        r.free ? 'free' : r.shut ? 'shut' : 'in use',
        r.neighbour ?? '',
        String(r.learned.length),
        r.learned.map((l) => l.mac).join(' '),
        r.learned.map((l) => l.address).filter(Boolean).join(' '),
      ]
        .map(cell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
