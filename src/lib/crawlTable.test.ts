import { describe, expect, it } from 'vitest';

import type { CrawlEvent } from './ipc';
import { reduceCrawlTable, stateCounts, tableRows, type CrawlTable } from './crawlTable';

const run = (events: CrawlEvent[]): CrawlTable => events.reduce(reduceCrawlTable, new Map());

describe('the live crawl table (LT-210)', () => {
  it('follows each device from queued to collected or failed', () => {
    const t = run([
      { kind: 'started', seed: '192.0.2.1' },
      { kind: 'queued', address: '192.0.2.1', hops: 0 },
      { kind: 'visiting', address: '192.0.2.1', hops: 0 },
      { kind: 'ssh', progress: { kind: 'authenticating', host: '192.0.2.1' } },
      { kind: 'ssh', progress: { kind: 'ready', host: '192.0.2.1', hostname: 'CORE-SW1' } },
      { kind: 'ssh', progress: { kind: 'running', host: '192.0.2.1', command: 'show vlan brief' } },
      { kind: 'queued', address: '192.0.2.2', hops: 1 },
      { kind: 'queued', address: '192.0.2.3', hops: 1 },
    ]);
    expect(tableRows(t).map((r) => [r.address, r.state, r.name, r.detail])).toEqual([
      ['192.0.2.1', 'collecting', 'CORE-SW1', 'show vlan brief'],
      ['192.0.2.2', 'queued', undefined, undefined],
      ['192.0.2.3', 'queued', undefined, undefined],
    ]);
    const done = [
      { kind: 'reached', hostname: 'CORE-SW1', address: '192.0.2.1', probeTarget: '192.0.2.1', class: 'switch', platform: null, hops: 0, reachedBy: 'ssh' },
      { kind: 'visiting', address: '192.0.2.2', hops: 1 },
      { kind: 'retrying', address: '192.0.2.2', attempt: 1 },
      { kind: 'failed', failure: { address: '192.0.2.2', reason: '192.0.2.2 did not answer within 8s', kind: 'unreachable' } },
      { kind: 'ssh', progress: { kind: 'awaitingSecondFactor', host: '192.0.2.3', message: 'Approve the push' } },
      { kind: 'skipped', name: 'bad_name!', reason: 'not an address, a range or a hostname' },
    ] as CrawlEvent[];
    const after = done.reduce(reduceCrawlTable, t);
    expect(tableRows(after).map((r) => [r.address, r.state, r.detail])).toEqual([
      ['192.0.2.1', 'collected', undefined],
      ['192.0.2.2', 'failed', '192.0.2.2 did not answer within 8s'],
      ['192.0.2.3', 'awaiting-approval', 'Approve the push'],
      ['bad_name!', 'skipped', 'not an address, a range or a hostname'],
    ]);
    expect(stateCounts(after)).toEqual({ collected: 1, failed: 1, 'awaiting-approval': 1, skipped: 1 });
  });

  it('does not make a finished device look busy again', () => {
    const t = run([
      { kind: 'failed', failure: { address: '192.0.2.9', reason: 'gave up' } },
      { kind: 'ssh', progress: { kind: 'running', host: '192.0.2.9', command: 'show version' } },
    ]);
    expect(tableRows(t)[0]!.state).toBe('failed');
  });

  it('starts empty for a new run', () => {
    const t = run([{ kind: 'queued', address: '192.0.2.1', hops: 0 }, { kind: 'started', seed: 'x' }]);
    expect(t.size).toBe(0);
  });
});
