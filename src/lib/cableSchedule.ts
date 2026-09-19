/**
 * The cable schedule (LT-198): every cable the diagram describes, end to end —
 * which device and port at each end, what kind of cable, how long, and what it
 * is labelled — as a list to hand to whoever pulls the cables.
 *
 * Built from the links already drawn, across every page: the port labels are
 * the ports, the cable type is LT-167's, the length is typed in the link's
 * inspector. A leader line from a callout is not a cable and is left out, as is
 * a link with an end on something that is not a device. Sorted by the first
 * device and port so a switch's cables read in port order.
 */
import type { ProjectDocument } from '../state/store';
import type { DeviceNodeData, LinkData } from '../types/domain';
import { CABLES, isCableType } from './cables';
import { toCsv } from './csv';

export interface CableRow {
  page: string;
  deviceA: string;
  portA: string;
  deviceB: string;
  portB: string;
  cable: string;
  length: string;
  label: string;
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function cableSchedule(doc: ProjectDocument): CableRow[] {
  const rows: CableRow[] = [];
  for (const page of doc.pages) {
    const devices = new Map(page.nodes.filter((n) => n.type === 'device').map((n) => [n.id, n.data as DeviceNodeData]));
    for (const e of page.edges) {
      const d = (e.data ?? {}) as Partial<LinkData>;
      if (d.kind === 'leader') continue;
      const a = devices.get(e.source);
      const b = devices.get(e.target);
      if (!a || !b) continue;
      rows.push({
        page: page.name,
        deviceA: a.label,
        portA: d.sourcePortLabel?.trim() ?? '',
        deviceB: b.label,
        portB: d.targetPortLabel?.trim() ?? '',
        cable: isCableType(d.cableType) ? CABLES[d.cableType].label : '',
        length: d.cableLength?.trim() ?? '',
        label: d.label?.trim() ?? '',
      });
    }
  }
  return rows.sort(
    (x, y) =>
      natural.compare(x.page, y.page) ||
      natural.compare(x.deviceA, y.deviceA) ||
      natural.compare(x.portA, y.portA) ||
      natural.compare(x.deviceB, y.deviceB) ||
      natural.compare(x.portB, y.portB),
  );
}

const HEADER = ['Page', 'Device A', 'Port A', 'Device B', 'Port B', 'Cable', 'Length', 'Label'];

export function cableScheduleCsv(rows: readonly CableRow[]): string {
  return toCsv([HEADER, ...rows.map((r) => [r.page, r.deviceA, r.portA, r.deviceB, r.portB, r.cable, r.length, r.label])]);
}

/** The schedule as a Markdown table, for the report. */
export function cableScheduleMarkdown(rows: readonly CableRow[]): string {
  const cell = (s: string) => (s ? s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ') : '—');
  const head = `| ${HEADER.join(' | ')} |\n| ${HEADER.map(() => '---').join(' | ')} |`;
  if (rows.length === 0) return `${head}\n| — | — | — | — | — | — | — | No links between devices |`;
  return `${head}\n${rows
    .map((r) => `| ${[r.page, r.deviceA, r.portA, r.deviceB, r.portB, r.cable, r.length, r.label].map(cell).join(' | ')} |`)
    .join('\n')}`;
}
