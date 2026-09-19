/**
 * What a PDF report (LT-256) says, gathered from the project: its rows,
 * already worded, so the layout only lays them out.
 */
import { cableSchedule } from './cableSchedule';
import { allEdges, allNodes } from './pages';
import { availability, type Sample } from './sparkline';
import type { ReportInput, ReportSection, ReportTemplate } from './reportPdf';
import type { DiffRow } from './runDiff';
import type { ProjectDocument } from '../state/store';
import type { DeviceNodeData, EventRow, HealthStatus, ProbeRuntime, ProjectMeta } from '../types/domain';
import { STATUS_LABEL } from '../types/domain';

export interface ReportSources {
  meta: ProjectMeta;
  doc: ProjectDocument;
  template: ReportTemplate;
  sections: readonly ReportSection[];
  generatedAt: Date;
  runtime: ReadonlyMap<string, ProbeRuntime>;
  samples: ReadonlyMap<string, readonly Sample[]>;
  events: readonly EventRow[];
  nodeStatus: (id: string) => HealthStatus;
  typeLabel: (type: string) => string;
  diagrams: { name: string; svg: string }[];
  diffs: { title: string; rows: DiffRow[] }[];
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export function reportInput(s: ReportSources): ReportInput {
  const devices = allNodes(s.doc).filter((n) => n.type === 'device' && !['zone', 'text', 'rectangle', 'rounded', 'circle', 'diamond', 'callout', 'cloud'].includes((n.data as DeviceNodeData).deviceType));
  const nameOf = new Map(devices.map((n) => [n.id, (n.data as DeviceNodeData).label]));
  const counts = { healthy: 0, warning: 0, down: 0, unknown: 0, disabled: 0, maintenance: 0 } as Record<HealthStatus, number>;
  for (const n of devices) counts[s.nodeStatus(n.id)] += 1;
  return {
    meta: s.meta,
    template: s.template,
    sections: s.sections,
    generatedAt: s.generatedAt,
    statusCounts: counts,
    linkCount: allEdges(s.doc).length,
    diagrams: s.diagrams,
    devices: devices.map((n) => {
      const d = n.data as DeviceNodeData;
      return {
        name: d.label,
        type: s.typeLabel(d.deviceType),
        address: d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address ?? '',
        model: [d.vendor, d.model].filter(Boolean).join(' '),
        serial: d.serial ?? '',
        location: [d.site, d.rack, d.rackU !== undefined ? `U${d.rackU}` : ''].filter(Boolean).join(' / '),
        status: STATUS_LABEL[s.nodeStatus(n.id)],
      };
    }),
    ports: devices.flatMap((n) => {
      const d = n.data as DeviceNodeData;
      return (d.inventory?.ports ?? []).map((p) => {
        const e = p.errors;
        const errors = e ? e.input + e.output + e.crc + e.collisions : 0;
        return {
          device: d.label,
          port: p.port,
          status: p.status,
          speed: [p.speed, p.duplex].filter(Boolean).join(' '),
          vlan: p.mode === 'trunk' ? `trunk ${p.trunkVlans ?? ''}`.trim() : p.vlan !== undefined ? String(p.vlan) : '',
          errors: e ? String(errors) : '',
        };
      });
    }),
    cables: cableSchedule(s.doc),
    probes: s.doc.probes.map((p) => ({
      object: nameOf.get(p.objectId) ?? (p.objectKind === 'link' ? 'Link' : ''),
      name: p.name,
      kind: p.kind.toUpperCase(),
      target: p.kind === 'tcp' && p.tcpPort ? `${p.target}:${p.tcpPort}` : p.target,
      every: `${p.intervalSeconds} s`,
      thresholds: `${p.failureThreshold} down / ${p.recoveryThreshold} up`,
      enabled: p.enabled ? (p.maintenance ? 'maintenance' : 'yes') : 'no',
    })),
    results: s.doc.probes.map((p) => {
      const r = s.runtime.get(p.id);
      const up = availability(s.samples.get(p.id) ?? []);
      return {
        object: nameOf.get(p.objectId) ?? (p.objectKind === 'link' ? 'Link' : ''),
        name: p.name,
        status: STATUS_LABEL[r?.status ?? 'unknown'],
        rtt: r?.lastRttMs != null ? `${Math.round(r.lastRttMs * 10) / 10} ms` : '—',
        availability: up === null ? '—' : `${up}%`,
        last: r?.lastSummary ?? 'Not run',
      };
    }),
    transitions: s.events
      .filter((e) => e.eventType === 'transition')
      .slice()
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map((e) => ({
        time: iso(e.timestampMs),
        object: e.objectName,
        change: `${e.previousStatus ? STATUS_LABEL[e.previousStatus] : '?'} → ${e.currentStatus ? STATUS_LABEL[e.currentStatus] : '?'}`,
        detail: e.message,
      })),
    diffs: s.diffs,
  };
}
