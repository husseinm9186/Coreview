/**
 * The live crawl table (LT-210): one row per device, from the crawl's event
 * stream, saying where each one is — waiting, being dialled, logging in,
 * being read, done, or failed and why.
 *
 * A pure reducer over events, so the whole table can be rebuilt from a list and
 * tested without a crawl.
 */
import type { CrawlEvent } from './ipc';

export type CrawlRowState =
  | 'queued'
  | 'dialling'
  | 'authenticating'
  | 'awaiting-approval'
  | 'collecting'
  | 'retrying'
  | 'collected'
  | 'reported'
  | 'failed'
  | 'skipped';

export interface CrawlRow {
  address: string;
  name?: string;
  hops?: number;
  state: CrawlRowState;
  /** What it is doing or why it stopped. */
  detail?: string;
  /** Order first seen, so the table does not jump about. */
  order: number;
}

export type CrawlTable = Map<string, CrawlRow>;

/** The words a state is shown with. */
export const STATE_LABEL: Record<CrawlRowState, string> = {
  queued: 'Queued',
  dialling: 'Probing',
  authenticating: 'Authenticating',
  'awaiting-approval': 'Waiting for approval',
  collecting: 'Collecting',
  retrying: 'Retrying',
  collected: 'Collected',
  reported: 'Reported by a neighbour',
  failed: 'Failed',
  skipped: 'Skipped',
};

const FINISHED: ReadonlySet<CrawlRowState> = new Set(['collected', 'reported', 'failed', 'skipped']);

export function reduceCrawlTable(table: CrawlTable, e: CrawlEvent): CrawlTable {
  const next = new Map(table);
  const put = (address: string, patch: Partial<CrawlRow> & { state: CrawlRowState }) => {
    const was = next.get(address);
    // A device that has finished stays finished: a late progress line from a
    // cut-off visit must not make it look busy again.
    if (was && FINISHED.has(was.state) && !FINISHED.has(patch.state)) return;
    next.set(address, { ...(was ?? { address, order: next.size }), ...patch });
  };
  switch (e.kind) {
    case 'started':
      return new Map();
    case 'queued':
      put(e.address, { state: 'queued', hops: e.hops, detail: undefined });
      break;
    case 'visiting':
      put(e.address, { state: 'dialling', hops: e.hops, detail: undefined });
      break;
    case 'retrying':
      put(e.address, { state: 'retrying', detail: `Nothing answered — try ${e.attempt + 1}` });
      break;
    case 'ssh': {
      const p = e.progress;
      if (p.kind === 'connecting' || p.kind === 'checkingHostKey') put(p.host, { state: 'dialling', detail: undefined });
      else if (p.kind === 'authenticating') put(p.host, { state: 'authenticating', detail: undefined });
      else if (p.kind === 'awaitingSecondFactor') put(p.host, { state: 'awaiting-approval', detail: p.message });
      else if (p.kind === 'ready') put(p.host, { state: 'collecting', name: p.hostname, detail: undefined });
      else if (p.kind === 'running') put(p.host, { state: 'collecting', detail: p.command });
      break;
    }
    case 'reached':
      put(e.address, { state: e.reachedBy === 'reported' ? 'reported' : 'collected', name: e.hostname, detail: e.reachedBy === 'snmp' ? 'over SNMP' : undefined });
      break;
    case 'failed':
      put(e.failure.address, { state: 'failed', detail: e.failure.reason });
      break;
    case 'skipped':
      put(e.name, { state: 'skipped', detail: e.reason });
      break;
    case 'finished':
      break;
  }
  return next;
}

/** Rows in the order they were first seen, and a count per state. */
export function tableRows(table: CrawlTable): CrawlRow[] {
  return [...table.values()].sort((a, b) => a.order - b.order);
}

export function stateCounts(table: CrawlTable): Partial<Record<CrawlRowState, number>> {
  const out: Partial<Record<CrawlRowState, number>> = {};
  for (const r of table.values()) out[r.state] = (out[r.state] ?? 0) + 1;
  return out;
}
