/**
 * Checks against captured output, the parts with no files in them.
 *
 * `checks::run_checks` in the Rust crate is authoritative — it reads the
 * captures and decides pass or fail. This holds the shape the Backups tab
 * edits and stores, and how results are counted and ordered for reading.
 *
 * **No checks ship built in.** A check lifted from any real project is
 * exactly what must never ship; each user writes their own.
 */

export type CheckExpect = 'contains' | 'notContains' | 'matches' | 'notMatches';

export type CheckSeverity = 'info' | 'warning' | 'critical';

export interface BackupCheck {
  id: string;
  name: string;
  /** The command whose output is examined; case and spacing are ignored. */
  command: string;
  expect: CheckExpect;
  pattern: string;
  ignoreCase: boolean;
  /** The stanza the check runs once per — `interface`, `line vty` —
   *  by the start of its heading line. Empty means the whole output. */
  block: string;
  /** How much a failure matters. */
  severity: CheckSeverity;
  /** Device roles the check is for; empty means every device. */
  roles: string[];
}

export type CheckVerdict = 'pass' | 'fail' | 'notCaptured' | 'rejected' | 'notApplicable';

export interface CheckResult {
  device: string;
  checkId: string;
  verdict: CheckVerdict;
  severity: CheckSeverity;
  /** The stanza that decided it, when the check names a block. */
  block: string | null;
  line: number | null;
  evidence: string | null;
  why: string;
}

export const SEVERITY_CHOICES: { value: CheckSeverity; label: string }[] = [
  { value: 'info', label: 'info' },
  { value: 'warning', label: 'warning' },
  { value: 'critical', label: 'critical' },
];

const isSeverity = (v: unknown): v is CheckSeverity => SEVERITY_CHOICES.some((c) => c.value === v);

export const EXPECT_CHOICES: { value: CheckExpect; label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'matches', label: 'matches (regular expression)' },
  { value: 'notMatches', label: 'does not match (regular expression)' },
];

const isExpect = (v: unknown): v is CheckExpect => EXPECT_CHOICES.some((c) => c.value === v);

/** Reads the stored setting. Anything malformed is dropped, never thrown. */
export function parseChecks(json: string | undefined | null): BackupCheck[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const seen = new Set<string>();
  const out: BackupCheck[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: str(o.name),
      command: str(o.command),
      expect: isExpect(o.expect) ? o.expect : 'contains',
      pattern: str(o.pattern),
      ignoreCase: o.ignoreCase === true,
      block: str(o.block),
      severity: isSeverity(o.severity) ? o.severity : 'warning',
      roles: Array.isArray(o.roles) ? o.roles.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : [],
    });
  }
  return out;
}

export function serializeChecks(checks: BackupCheck[]): string | null {
  return checks.length ? JSON.stringify(checks) : null;
}

/** A fresh, empty check — nothing pre-filled. */
export function newCheck(): BackupCheck {
  const id = `check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, name: '', command: '', expect: 'contains', pattern: '', ignoreCase: false, block: '', severity: 'warning', roles: [] };
}

/** Whether a check has what it needs to run. Incomplete ones are not sent. */
export const isComplete = (c: BackupCheck) => c.command.trim() !== '' && c.pattern !== '';

export const checkLabel = (c: BackupCheck) => c.name.trim() || c.command.trim();

export function summarise(results: CheckResult[]): Record<CheckVerdict, number> {
  const out: Record<CheckVerdict, number> = { pass: 0, fail: 0, notCaptured: 0, rejected: 0, notApplicable: 0 };
  for (const r of results) out[r.verdict]++;
  return out;
}

const RANK: Record<CheckVerdict, number> = { fail: 0, rejected: 1, notCaptured: 2, pass: 3, notApplicable: 4 };
const SEVERITY_RANK: Record<CheckSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** The results as a grid — one row per device, one column per check,
 *  in the order the checks are listed. A cell is null where the device has
 *  no result for that check. Failures are ordered first among rows, and
 *  critical failures before warnings. */
export interface CheckMatrix {
  checks: BackupCheck[];
  rows: { device: string; cells: (CheckResult | null)[]; failures: number; worst: CheckSeverity | null }[];
}

export function checkMatrix(results: CheckResult[], checks: BackupCheck[]): CheckMatrix {
  const byDevice = new Map<string, Map<string, CheckResult>>();
  for (const r of results) {
    const row = byDevice.get(r.device) ?? new Map<string, CheckResult>();
    row.set(r.checkId, r);
    byDevice.set(r.device, row);
  }
  const rows = [...byDevice.entries()].map(([device, cells]) => {
    const line = checks.map((c) => cells.get(c.id) ?? null);
    const failed = line.filter((c): c is CheckResult => c?.verdict === 'fail');
    const worst = failed.reduce<CheckSeverity | null>(
      (w, c) => (w === null || SEVERITY_RANK[c.severity] < SEVERITY_RANK[w] ? c.severity : w),
      null,
    );
    return { device, cells: line, failures: failed.length, worst };
  });
  rows.sort(
    (a, b) =>
      (a.worst === null ? 3 : SEVERITY_RANK[a.worst]) - (b.worst === null ? 3 : SEVERITY_RANK[b.worst]) ||
      b.failures - a.failures ||
      a.device.localeCompare(b.device),
  );
  return { checks, rows };
}

const VERDICT_MARK: Record<CheckVerdict, string> = {
  pass: 'pass', fail: 'FAIL', notCaptured: 'not captured', rejected: 'rejected', notApplicable: 'n/a',
};

/** The matrix as CSV. A leading `= + - @` is guarded the way every
 *  CSV here is, because a device name is device-supplied. */
export function matrixCsv(m: CheckMatrix): string {
  const cell = (v: string) => {
    const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };
  const head = ['Device', ...m.checks.map((c) => `${checkLabel(c)} (${c.severity})`)];
  const lines = [head.map(cell).join(',')];
  for (const r of m.rows) {
    lines.push([r.device, ...r.cells.map((c) => (c ? VERDICT_MARK[c.verdict] : ''))].map(cell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** The matrix as a Markdown table, failures first, with the run's
 *  stamp in the heading so the file stands on its own. */
export function matrixMarkdown(m: CheckMatrix, stamp: string): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const head = `| Device | ${m.checks.map((c) => esc(`${checkLabel(c)} (${c.severity})`)).join(' | ')} |`;
  const rule = `| --- | ${m.checks.map(() => '---').join(' | ')} |`;
  const body = m.rows.map((r) => `| ${esc(r.device)} | ${r.cells.map((c) => (c ? VERDICT_MARK[c.verdict] : '')).join(' | ')} |`);
  const failing = m.rows.filter((r) => r.failures > 0).length;
  return [
    `# Checks against run ${stamp}`,
    '',
    `${m.rows.length} devices, ${failing} with at least one failure.`,
    '',
    head,
    rule,
    ...body,
    '',
  ].join('\n');
}

/** What needs attention first: failures, then refusals, then gaps, then
 *  passes; within each, by device and then in the order the checks are
 *  listed. */
export function orderResults(results: CheckResult[], checks: BackupCheck[]): CheckResult[] {
  const position = new Map(checks.map((c, i) => [c.id, i]));
  return [...results].sort(
    (a, b) =>
      RANK[a.verdict] - RANK[b.verdict] ||
      a.device.localeCompare(b.device) ||
      (position.get(a.checkId) ?? 0) - (position.get(b.checkId) ?? 0),
  );
}
