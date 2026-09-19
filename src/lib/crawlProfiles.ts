/**
 * Crawl profiles (LT-212): a run's settings saved under a name and used again —
 * "Branch sites", "Data centre core", "Lab" — each with its seeds, limits,
 * which tables to read, and which saved credentials to use.
 *
 * LT-135 remembers the last run; this names several. Kept with the project,
 * because seeds and subnets belong to an estate. **Never a secret**: SSH and
 * SNMP credentials are vault ids, and a typed SNMP row keeps only its version,
 * user and algorithms, exactly as LT-135 stores it. `readProfile` rebuilds a
 * profile field by field from what was stored, so nothing else — a password a
 * future change let slip in — survives being read back.
 */
export interface CrawlProfile {
  id: string;
  name: string;
  seed: string;
  subnets: string[];
  maxHops: number;
  preference: 'loopback' | 'management' | 'first';
  port: number;
  transport: 'ssh' | 'telnet' | 'sshThenTelnet';
  credentialId: string | null;
  /** The SNMP rows' shape, without secrets (see `snmpRowsShape`). */
  snmp: string | null;
  details: { routes: boolean; spanningTree: boolean; vlans: boolean };
  reverseDns: boolean;
  concurrency: number;
  perHostTimeoutSecs: number;
  retries: number;
  secondFactor: boolean;
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** A stored profile, rebuilt from known fields only. `null` if it has no id or name. */
export function readProfile(raw: unknown): CrawlProfile | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = str(r.id);
  const name = str(r.name).trim();
  if (!id || !name) return null;
  const d = (r.details ?? {}) as Record<string, unknown>;
  const snmp = typeof r.snmp === 'string' ? stripSnmpSecrets(r.snmp) : null;
  return {
    id,
    name,
    seed: str(r.seed),
    subnets: Array.isArray(r.subnets) ? r.subnets.filter((s): s is string => typeof s === 'string') : [],
    maxHops: num(r.maxHops, 4, 0, 32),
    preference: r.preference === 'management' || r.preference === 'first' ? r.preference : 'loopback',
    port: num(r.port, 22, 1, 65535),
    transport: r.transport === 'telnet' || r.transport === 'sshThenTelnet' ? r.transport : 'ssh',
    credentialId: typeof r.credentialId === 'string' && r.credentialId ? r.credentialId : null,
    snmp,
    details: { routes: bool(d.routes, true), spanningTree: bool(d.spanningTree, true), vlans: bool(d.vlans, true) },
    reverseDns: bool(r.reverseDns, true),
    concurrency: num(r.concurrency, 4, 1, 32),
    perHostTimeoutSecs: num(r.perHostTimeoutSecs, 300, 30, 1800),
    retries: num(r.retries, 1, 0, 3),
    secondFactor: bool(r.secondFactor, false),
  };
}

/** Keeps only the non-secret fields of each stored SNMP row. */
function stripSnmpSecrets(text: string): string | null {
  try {
    const rows = JSON.parse(text) as unknown;
    if (!Array.isArray(rows)) return null;
    return JSON.stringify(
      rows.map((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        return {
          version: r.version === 'v3' ? 'v3' : 'v2c',
          user: str(r.user),
          auth: str(r.auth, 'sha'),
          priv: str(r.priv, 'aes 256'),
          credentialId: typeof r.credentialId === 'string' ? r.credentialId : null,
        };
      }),
    );
  } catch {
    return null;
  }
}

/** Adds a profile, or replaces the one with the same name (case-insensitive). */
export function withProfile(list: readonly CrawlProfile[], profile: CrawlProfile): CrawlProfile[] {
  const at = list.findIndex((p) => p.name.toLowerCase() === profile.name.toLowerCase());
  if (at < 0) return [...list, profile];
  const next = [...list];
  next[at] = { ...profile, id: list[at]!.id };
  return next;
}
