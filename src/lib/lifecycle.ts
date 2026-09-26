/**
 * A lifecycle table the operator supplies (LT-439).
 *
 * Device42 and SolarWinds report end-of-sale and end-of-support by looking
 * the model up with the vendor. Coreview makes no such call and never will;
 * what it can do is read a table the operator keeps — a CSV of model,
 * end-of-sale date, end-of-support date — and say which drawn devices are
 * past either date. The table is the operator's own, stored in the project,
 * and nothing ships pre-filled (D-027). A model that is not in the table is
 * reported as unknown, never as fine.
 */
import { parseCsv, toCsv } from './csv';
import { allNodes } from './pages';
import type { ProjectDocument } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

export interface LifecycleRow {
  /** The model as the vendor writes it; matched case-insensitively, and a
   *  table row may be a prefix (`WS-C2960X`) of a drawn model. */
  model: string;
  /** ISO dates, `YYYY-MM-DD`, or empty where the vendor has not said. */
  endOfSale: string;
  endOfSupport: string;
  note: string;
}

export type LifecycleState = 'unsupported' | 'unsold' | 'current' | 'unknown';

export interface LifecycleVerdict {
  nodeId: string;
  label: string;
  model: string;
  state: LifecycleState;
  endOfSale: string;
  endOfSupport: string;
  /** The table row that decided it, as its model. */
  matched: string | null;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const HEADERS: Record<keyof LifecycleRow, RegExp> = {
  model: /^(model|product|part|sku|pid)/i,
  endOfSale: /sale|eos\b|end.?of.?sale|last.?day.?to.?order/i,
  endOfSupport: /support|eol\b|end.?of.?(support|life)|last.?date.?of.?support/i,
  note: /note|comment|remark/i,
};

/** A date as `YYYY-MM-DD`, from that, or from `DD/MM/YYYY` or `MM/DD/YYYY`
 *  where the day cannot be mistaken for a month; anything else is dropped
 *  rather than guessed. */
export function isoDate(raw: string): string {
  const t = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const y = slash[3];
    // Only one reading if one number cannot be a month.
    if (a > 12 && b <= 12) return `${y}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    if (b > 12 && a <= 12) return `${y}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
  }
  return '';
}

/** Reads the operator's CSV. Columns are found by their headings; a file
 *  with no model column is refused with the reason. */
export function readLifecycleCsv(text: string): { rows: LifecycleRow[]; problems: string[] } {
  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  const problems: string[] = [];
  const head = grid[0] ?? [];
  const column = (key: keyof LifecycleRow) => head.findIndex((h) => HEADERS[key].test(h.trim()));
  const at = { model: column('model'), endOfSale: column('endOfSale'), endOfSupport: column('endOfSupport'), note: column('note') };
  if (at.model < 0) return { rows: [], problems: ['No model column: the first row needs a heading such as Model, Product or Part.'] };
  if (at.endOfSale < 0 && at.endOfSupport < 0) problems.push('No end-of-sale or end-of-support column was found; every row will read as unknown.');
  const rows: LifecycleRow[] = [];
  const seen = new Set<string>();
  grid.slice(1).forEach((r, i) => {
    const model = (r[at.model] ?? '').trim();
    if (!model) return;
    const key = norm(model);
    if (seen.has(key)) {
      problems.push(`Row ${i + 2}: ${model} is listed twice; the first is kept.`);
      return;
    }
    seen.add(key);
    const date = (idx: number) => {
      if (idx < 0) return '';
      const raw = (r[idx] ?? '').trim();
      if (!raw) return '';
      const d = isoDate(raw);
      if (!d) problems.push(`Row ${i + 2}: "${raw}" is not a date this reads (YYYY-MM-DD).`);
      return d;
    };
    rows.push({ model, endOfSale: date(at.endOfSale), endOfSupport: date(at.endOfSupport), note: at.note < 0 ? '' : (r[at.note] ?? '').trim() });
  });
  return { rows, problems };
}

/** The table row for a drawn model: an exact match first, then the longest
 *  row whose model is a prefix of it. */
export function lifecycleFor(model: string, rows: readonly LifecycleRow[]): LifecycleRow | null {
  const m = norm(model);
  if (!m) return null;
  const exact = rows.find((r) => norm(r.model) === m);
  if (exact) return exact;
  let best: LifecycleRow | null = null;
  for (const r of rows) {
    const rm = norm(r.model);
    if (rm && m.startsWith(rm) && (!best || rm.length > norm(best.model).length)) best = r;
  }
  return best;
}

/** Every drawn device against the table, worst first: past support, past
 *  sale, current, then the models the table does not know. */
export function lifecycleVerdicts(doc: Pick<ProjectDocument, 'pages'>, rows: readonly LifecycleRow[], today: string): LifecycleVerdict[] {
  const out: LifecycleVerdict[] = [];
  for (const n of allNodes(doc)) {
    if (n.type !== 'device') continue;
    const d = n.data as DeviceNodeData;
    const model = d.model?.trim() ?? '';
    const row = lifecycleFor(model, rows);
    let state: LifecycleState = 'unknown';
    if (row) {
      if (row.endOfSupport && row.endOfSupport <= today) state = 'unsupported';
      else if (row.endOfSale && row.endOfSale <= today) state = 'unsold';
      else if (row.endOfSale || row.endOfSupport) state = 'current';
    }
    out.push({ nodeId: n.id, label: d.label, model, state, endOfSale: row?.endOfSale ?? '', endOfSupport: row?.endOfSupport ?? '', matched: row?.model ?? null });
  }
  const rank: Record<LifecycleState, number> = { unsupported: 0, unsold: 1, current: 2, unknown: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || a.label.localeCompare(b.label));
}

export function lifecycleCsv(verdicts: readonly LifecycleVerdict[]): string {
  return toCsv([
    ['Device', 'Model', 'State', 'End of sale', 'End of support', 'Matched'],
    ...verdicts.map((v) => [v.label, v.model, v.state, v.endOfSale, v.endOfSupport, v.matched ?? '']),
  ]);
}
