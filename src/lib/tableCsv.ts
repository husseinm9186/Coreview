/**
 * The project's tables as CSV (LT-252): every port a crawl read, every VLAN
 * each device has, and what every probe last found.
 *
 * Devices, links and the cable schedule already had their own files; these
 * are the rest of what an engineer is asked for in a spreadsheet. Every page
 * is included, because a table is an inventory, not a drawing.
 */
import { toCsv } from './csv';
import { buildIpam, ipamRows } from './ipam';
import { availability, type Sample } from './sparkline';
import type { ProjectDocument } from '../state/store';
import type { DeviceNodeData, Probe, ProbeRuntime } from '../types/domain';
import { allNodes } from './pages';

const devicesOf = (doc: ProjectDocument) =>
  allNodes(doc)
    .filter((n) => n.type === 'device')
    .map((n) => ({ id: n.id, d: n.data as DeviceNodeData, page: doc.pages.find((p) => p.nodes.some((x) => x.id === n.id))?.name ?? '' }));

/** LT-285: the address register, a row per known address. */
export function ipamCsv(doc: ProjectDocument): string {
  return toCsv(ipamRows(buildIpam(allNodes(doc), doc.ipam)));
}

export function portsCsv(doc: ProjectDocument): string {
  const rows: unknown[][] = [];
  for (const { d, page } of devicesOf(doc)) {
    for (const p of d.inventory?.ports ?? []) {
      const e = p.errors;
      rows.push([
        d.label, page, p.port, p.description ?? '', p.status, p.speed ?? '', p.duplex ?? '', p.mode ?? '',
        p.vlan ?? '', p.trunkVlans ?? '', e?.input ?? '', e?.crc ?? '', e?.output ?? '', e?.collisions ?? '', e?.drops ?? '', e?.resets ?? '',
      ]);
    }
  }
  return toCsv([
    ['Device', 'Page', 'Port', 'Description', 'Status', 'Speed', 'Duplex', 'Mode', 'VLAN', 'Trunk VLANs', 'Input errors', 'CRC', 'Output errors', 'Collisions', 'Drops', 'Resets'],
    ...rows,
  ]);
}

/** One row per VLAN per device, with how many of the device's ports carry it
 *  untagged. */
export function vlansCsv(doc: ProjectDocument): string {
  const rows: unknown[][] = [];
  for (const { d, page } of devicesOf(doc)) {
    for (const v of d.inventory?.vlans ?? []) {
      const access = (d.inventory?.ports ?? []).filter((p) => p.mode !== 'trunk' && p.vlan === v.id).length;
      rows.push([v.id, v.name, d.label, page, access]);
    }
  }
  rows.sort((a, b) => Number(a[0]) - Number(b[0]) || String(a[2]).localeCompare(String(b[2])));
  return toCsv([['VLAN', 'Name', 'Device', 'Page', 'Access ports'], ...rows]);
}

export function probeResultsCsv(
  doc: ProjectDocument,
  runtime: ReadonlyMap<string, ProbeRuntime>,
  samples: ReadonlyMap<string, readonly Sample[]>,
): string {
  const names = new Map(devicesOf(doc).map(({ id, d }) => [id, d.label]));
  const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : '');
  const target = (p: Probe) => (p.kind === 'tcp' && p.tcpPort ? `${p.target}:${p.tcpPort}` : p.target);
  return toCsv([
    ['Object', 'Probe', 'Kind', 'Target', 'Enabled', 'Status', 'Last RTT (ms)', 'Last success', 'Last failure', 'Failures in a row', 'Availability (%)', 'Samples', 'Last result'],
    ...doc.probes.map((p) => {
      const r = runtime.get(p.id);
      const s = samples.get(p.id) ?? [];
      return [
        names.get(p.objectId) ?? (p.objectKind === 'link' ? 'Link' : ''), p.name, p.kind, target(p), p.enabled ? 'yes' : 'no',
        r?.status ?? 'unknown', r?.lastRttMs ?? '', iso(r?.lastSuccessMs), iso(r?.lastFailureMs), r?.consecutiveFailures ?? '',
        availability(s) ?? '', s.length, r?.lastSummary ?? '',
      ];
    }),
  ]);
}
