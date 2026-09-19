/**
 * What happened to the address register, and what it was before (LT-297).
 *
 * Undo covers the last few steps of this session and then the history is gone.
 * This is the other question: *who gave that address away, and what was there
 * before?*, asked three weeks later by someone reading a change request.
 *
 * It is a history of edits, not an audit trail in the compliance sense. There
 * are no logins in Coreview, so "who" is whoever was at this machine — saying
 * that plainly is better than a user column that always reads the same name.
 *
 * It lives in the project, so it travels with an export, and it is capped:
 * a register's history is worth keeping and worth keeping bounded.
 */
import { AUDIT_LIMIT, type IpamAuditEntry, type IpamState } from './ipam';
import { uid } from './id';

/** The fields worth showing a person, in the order they read them. */
const FIELD_ORDER = [
  'cidr', 'address', 'from', 'to', 'name', 'label', 'kind', 'assignment', 'vlan',
  'hostname', 'fqdn', 'mac', 'owner', 'purpose', 'vrfId', 'containerId', 'note',
];

/** The name a field is known by on screen, where it differs from the code's. */
const FIELD_NAME: Record<string, string> = {
  cidr: 'subnet',
  label: 'name',
  kind: 'held as',
  assignment: 'used as',
  vrfId: 'routing table',
  containerId: 'container',
  from: 'first address',
  to: 'last address',
};

const show = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const text = String(v).trim();
  return text === '' ? undefined : text;
};

/**
 * Field by field, what changed — and nothing that did not.
 *
 * A diff of every field, most of them unchanged, is a diff nobody reads.
 */
export function diffOf(
  before: Readonly<Record<string, unknown>> | object,
  after: Readonly<Record<string, unknown>> | object,
): IpamAuditEntry['changes'] {
  const from = before as Record<string, unknown>;
  const to = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])]
    .filter((k) => k !== 'id')
    .sort((a, b) => {
      const ai = FIELD_ORDER.indexOf(a);
      const bi = FIELD_ORDER.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
    });
  const out: NonNullable<IpamAuditEntry['changes']> = [];
  for (const k of keys) {
    const was = show(from[k]);
    const now = show(to[k]);
    if (was === now) continue;
    out.push({ field: FIELD_NAME[k] ?? k, ...(was === undefined ? {} : { before: was }), ...(now === undefined ? {} : { after: now }) });
  }
  return out.length ? out : undefined;
}

/**
 * The register's history with one more thing in it, oldest dropped past the
 * cap. Newest first, because that is the end anyone reads.
 */
export function noteChange(
  state: IpamState | undefined,
  entry: { action: string; object: string; label: string; changes?: IpamAuditEntry['changes'] },
  now = Date.now(),
): IpamAuditEntry[] {
  const made: IpamAuditEntry = {
    id: uid(),
    at: now,
    action: entry.action,
    object: entry.object,
    label: entry.label,
    ...(entry.changes?.length ? { changes: entry.changes } : {}),
  };
  return [made, ...(state?.audit ?? [])].slice(0, AUDIT_LIMIT);
}

/** One line of history, as a sentence: "Edited subnet 10.20.30.0/24". */
export function auditSentence(e: IpamAuditEntry): string {
  const verb = e.action.charAt(0).toUpperCase() + e.action.slice(1);
  return `${verb} ${e.object} ${e.label}`.trim();
}
