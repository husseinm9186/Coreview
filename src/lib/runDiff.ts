/**
 * Comparing two runs (LT-226, LT-227) and writing the comparison out (LT-228).
 *
 * - **Two validation sessions**: per check, availability, average and 95th
 *   percentile response time before and after, and what got worse. A latency
 *   regression is a real change — the average up by a quarter *and* at least
 *   5 ms, or the 95th percentile up by half and at least 10 ms — so a check
 *   going from 1 ms to 2 ms is not reported as doubling.
 * - **Two crawls**: devices that appeared or went, firmware that changed,
 *   ports that went up or down, neighbours gained or lost, routes added or
 *   withdrawn.
 *
 * Both come out as rows, and rows go to Markdown or CSV.
 */
import { csvCell } from './csv';
import type { CrawledDevice } from './ipc';

export interface ProbeSummary {
  probeId: string;
  samples: number;
  healthy: number;
  warning: number;
  down: number;
  avgRttMs: number | null;
  p95RttMs: number | null;
}

export interface DiffRow {
  subject: string;
  change: string;
  before: string;
  after: string;
  /** Worse, better or neither — for sorting and for the eye. */
  tone: 'worse' | 'better' | 'neutral';
}

const up = (s: ProbeSummary) => {
  const judged = s.healthy + s.warning + s.down;
  return judged ? ((s.healthy + s.warning) / judged) * 100 : null;
};
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 10) / 10}%`);
const ms = (v: number | null) => (v === null ? '—' : `${Math.round(v * 10) / 10} ms`);

export function diffSessions(before: readonly ProbeSummary[], after: readonly ProbeSummary[], nameOf: (probeId: string) => string): DiffRow[] {
  const rows: DiffRow[] = [];
  const a = new Map(before.map((s) => [s.probeId, s]));
  const b = new Map(after.map((s) => [s.probeId, s]));
  for (const [id, s] of b) {
    const was = a.get(id);
    const name = nameOf(id);
    if (!was) {
      rows.push({ subject: name, change: 'Only in the second session', before: '—', after: `${pct(up(s))} up, ${ms(s.avgRttMs)}`, tone: 'neutral' });
      continue;
    }
    const [ua, ub] = [up(was), up(s)];
    if (ua !== null && ub !== null && Math.abs(ub - ua) >= 1) {
      rows.push({ subject: name, change: ub < ua ? 'Less available' : 'More available', before: pct(ua), after: pct(ub), tone: ub < ua ? 'worse' : 'better' });
    }
    if (was.avgRttMs !== null && s.avgRttMs !== null) {
      const d = s.avgRttMs - was.avgRttMs;
      if (d >= 5 && s.avgRttMs >= was.avgRttMs * 1.25) {
        rows.push({ subject: name, change: 'Slower on average', before: ms(was.avgRttMs), after: ms(s.avgRttMs), tone: 'worse' });
      } else if (-d >= 5 && was.avgRttMs >= s.avgRttMs * 1.25) {
        rows.push({ subject: name, change: 'Faster on average', before: ms(was.avgRttMs), after: ms(s.avgRttMs), tone: 'better' });
      }
    }
    if (was.p95RttMs !== null && s.p95RttMs !== null) {
      const d = s.p95RttMs - was.p95RttMs;
      if (d >= 10 && s.p95RttMs >= was.p95RttMs * 1.5) {
        rows.push({ subject: name, change: 'Slower at the 95th percentile', before: ms(was.p95RttMs), after: ms(s.p95RttMs), tone: 'worse' });
      }
    }
  }
  for (const [id, s] of a) {
    if (!b.has(id)) rows.push({ subject: nameOf(id), change: 'Only in the first session', before: `${pct(up(s))} up, ${ms(s.avgRttMs)}`, after: '—', tone: 'neutral' });
  }
  return sortRows(rows);
}

const key = (s: string) => s.trim().toLowerCase();

export function diffCrawls(before: readonly CrawledDevice[], after: readonly CrawledDevice[]): DiffRow[] {
  const rows: DiffRow[] = [];
  const a = new Map(before.map((d) => [key(d.hostname), d]));
  const b = new Map(after.map((d) => [key(d.hostname), d]));
  for (const [k, d] of b) {
    const was = a.get(k);
    if (!was) {
      rows.push({ subject: d.hostname, change: 'Device appeared', before: '—', after: [d.platform, d.address].filter(Boolean).join(', '), tone: 'neutral' });
      continue;
    }
    if ((was.version ?? '') !== (d.version ?? '') && was.version && d.version) {
      rows.push({ subject: d.hostname, change: 'Firmware changed', before: was.version, after: d.version, tone: 'neutral' });
    }
    const ports = new Map((was.ports ?? []).map((p) => [p.port, p.status]));
    for (const p of d.ports ?? []) {
      const old = ports.get(p.port);
      if (old && old !== p.status) {
        rows.push({ subject: `${d.hostname} ${p.port}`, change: p.status === 'connected' ? 'Port came up' : old === 'connected' ? 'Port went down' : 'Port changed', before: old, after: p.status, tone: old === 'connected' ? 'worse' : 'neutral' });
      }
    }
    const nb = (x: CrawledDevice) => new Map(x.neighbors.map((n) => [`${key(n.shortName || n.deviceId)}@${n.localInterface ?? ''}`, n]));
    const [na, nbb] = [nb(was), nb(d)];
    for (const [k2, n] of nbb) {
      if (!na.has(k2)) rows.push({ subject: d.hostname, change: 'Neighbour gained', before: '—', after: `${n.shortName || n.deviceId} on ${n.localInterface ?? '?'}`, tone: 'neutral' });
    }
    for (const [k2, n] of na) {
      if (!nbb.has(k2)) rows.push({ subject: d.hostname, change: 'Neighbour lost', before: `${n.shortName || n.deviceId} on ${n.localInterface ?? '?'}`, after: '—', tone: 'worse' });
    }
    const route = (x: CrawledDevice) => new Map((x.routes ?? []).map((r) => [`${r.prefix} via ${r.nextHops.join(',') || r.interface || 'connected'}`, r]));
    const [ra, rb] = [route(was), route(d)];
    for (const k2 of rb.keys()) if (!ra.has(k2)) rows.push({ subject: d.hostname, change: 'Route added', before: '—', after: k2, tone: 'neutral' });
    for (const k2 of ra.keys()) if (!rb.has(k2)) rows.push({ subject: d.hostname, change: 'Route withdrawn', before: k2, after: '—', tone: 'worse' });
  }
  for (const [k, d] of a) {
    if (!b.has(k)) rows.push({ subject: d.hostname, change: 'Device gone', before: [d.platform, d.address].filter(Boolean).join(', '), after: '—', tone: 'worse' });
  }
  return sortRows(rows);
}

function sortRows(rows: DiffRow[]): DiffRow[] {
  const rank = { worse: 0, better: 1, neutral: 2 } as const;
  return rows.sort((x, y) => rank[x.tone] - rank[y.tone] || x.subject.localeCompare(y.subject) || x.change.localeCompare(y.change));
}

/** LT-228: the rows as a Markdown document. */
export function diffMarkdown(title: string, firstLabel: string, secondLabel: string, rows: readonly DiffRow[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const head = `# ${title}\n\nFirst: ${firstLabel}  \nSecond: ${secondLabel}\n\n`;
  if (rows.length === 0) return `${head}No differences.\n`;
  return `${head}| What | Change | First | Second |\n| --- | --- | --- | --- |\n${rows
    .map((r) => `| ${cell(r.subject)} | ${cell(r.change)} | ${cell(r.before)} | ${cell(r.after)} |`)
    .join('\n')}\n`;
}

/** LT-228: the rows as CSV, spreadsheet-safe. */
export function diffCsv(rows: readonly DiffRow[]): string {
  return [['What', 'Change', 'First', 'Second'], ...rows.map((r) => [r.subject, r.change, r.before, r.after])]
    .map((r) => r.map(csvCell).join(','))
    .join('\r\n');
}
