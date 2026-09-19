/**
 * Checks against captured output (LT-153), the parts with no files in them.
 *
 * `checks::run_checks` in the Rust crate is authoritative — it reads the
 * captures and decides pass or fail. This holds the shape the Backups tab
 * edits and stores, and how results are counted and ordered for reading.
 *
 * **No checks ship built in.** A check lifted from any real project is
 * exactly what D-027 forbids; the operator writes his own.
 */

export type CheckExpect = 'contains' | 'notContains' | 'matches' | 'notMatches';

export interface BackupCheck {
  id: string;
  name: string;
  /** The command whose output is examined; case and spacing are ignored. */
  command: string;
  expect: CheckExpect;
  pattern: string;
  ignoreCase: boolean;
}

export type CheckVerdict = 'pass' | 'fail' | 'notCaptured' | 'rejected';

export interface CheckResult {
  device: string;
  checkId: string;
  verdict: CheckVerdict;
  line: number | null;
  evidence: string | null;
  why: string;
}

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
    });
  }
  return out;
}

export function serializeChecks(checks: BackupCheck[]): string | null {
  return checks.length ? JSON.stringify(checks) : null;
}

/** A fresh, empty check — nothing pre-filled (D-027). */
export function newCheck(): BackupCheck {
  const id = `check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, name: '', command: '', expect: 'contains', pattern: '', ignoreCase: false };
}

/** Whether a check has what it needs to run. Incomplete ones are not sent. */
export const isComplete = (c: BackupCheck) => c.command.trim() !== '' && c.pattern !== '';

export const checkLabel = (c: BackupCheck) => c.name.trim() || c.command.trim();

export function summarise(results: CheckResult[]): Record<CheckVerdict, number> {
  const out: Record<CheckVerdict, number> = { pass: 0, fail: 0, notCaptured: 0, rejected: 0 };
  for (const r of results) out[r.verdict]++;
  return out;
}

const RANK: Record<CheckVerdict, number> = { fail: 0, rejected: 1, notCaptured: 2, pass: 3 };

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
