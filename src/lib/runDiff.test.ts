import { describe, expect, it } from 'vitest';

import type { CrawledDevice } from './ipc';
import { diffCrawls, diffCsv, diffMarkdown, diffSessions, type ProbeSummary } from './runDiff';

const sum = (probeId: string, over: Partial<ProbeSummary>): ProbeSummary => ({ probeId, samples: 100, healthy: 100, warning: 0, down: 0, avgRttMs: 2, p95RttMs: 4, ...over });
const name = (id: string) => ({ a: 'CORE ping', b: 'WEB https', c: 'DNS', d: 'OLD' })[id] ?? id;

describe('comparing validation sessions (LT-226)', () => {
  it('reports availability and latency that really changed, worst first', () => {
    const rows = diffSessions(
      [sum('a', {}), sum('b', { avgRttMs: 20, p95RttMs: 30 }), sum('d', {}), sum('c', { avgRttMs: 1, p95RttMs: 1 })],
      [sum('a', { healthy: 90, down: 10 }), sum('b', { avgRttMs: 40, p95RttMs: 90 }), sum('c', { avgRttMs: 2, p95RttMs: 3 }), sum('e', {})],
      name,
    );
    expect(rows.map((r) => [r.subject, r.change, r.before, r.after])).toEqual([
      ['CORE ping', 'Less available', '100%', '90%'],
      ['WEB https', 'Slower at the 95th percentile', '30 ms', '90 ms'],
      ['WEB https', 'Slower on average', '20 ms', '40 ms'],
      ['e', 'Only in the second session', '—', '100% up, 2 ms'],
      ['OLD', 'Only in the first session', '100% up, 2 ms', '—'],
    ]);
  });
});

const dev = (hostname: string, over: Partial<CrawledDevice> = {}): CrawledDevice => ({
  hostname, address: '192.0.2.1', addresses: [], probeTarget: '', class: 'switch', platform: null, serial: null, version: null,
  neighbors: [], hops: 0, reachedBy: 'ssh', attached: [], ...over,
});

describe('comparing crawls (LT-227)', () => {
  it('finds firmware, ports, neighbours, routes and devices that changed', () => {
    const nb = (n: string, port: string) => ({ deviceId: n, shortName: n, addresses: [], localInterface: port, remoteInterface: null, platform: null, serial: null, capabilities: [], version: null, class: 'switch' as const, discoveredBy: 'cdp' as const, chassisId: null, vendor: null });
    const port = (p: string, status: string) => ({ port: p, description: '', status, vlan: '1', duplex: '', speed: '', media: '' });
    const route = (prefix: string, hop: string) => ({ family: 4 as const, prefix, code: 'S', protocol: 'static', nextHops: [hop], interface: null, distance: 1, metric: 0 });
    const rows = diffCrawls(
      [dev('CORE', { version: '15.2(6)E', ports: [port('Gi0/1', 'connected'), port('Gi0/2', 'notconnect')], neighbors: [nb('ACC1', 'Gi0/1')], routes: [route('0.0.0.0/0', '192.0.2.254')] }), dev('GONE')],
      [dev('CORE', { version: '15.2(7)E', ports: [port('Gi0/1', 'notconnect'), port('Gi0/2', 'connected')], neighbors: [nb('ACC2', 'Gi0/2')], routes: [route('0.0.0.0/0', '192.0.2.253')] }), dev('NEW', { platform: 'C9200' })],
    );
    expect(rows.map((r) => [r.subject, r.change])).toEqual([
      ['CORE', 'Neighbour lost'],
      ['CORE', 'Route withdrawn'],
      ['CORE Gi0/1', 'Port went down'],
      ['GONE', 'Device gone'],
      ['CORE', 'Firmware changed'],
      ['CORE', 'Neighbour gained'],
      ['CORE', 'Route added'],
      ['CORE Gi0/2', 'Port came up'],
      ['NEW', 'Device appeared'],
    ]);
  });
});

describe('writing a comparison out (LT-228)', () => {
  const rows = [{ subject: 'CORE|1', change: 'Port went down', before: 'connected', after: '=notconnect', tone: 'worse' as const }];
  it('as Markdown', () => {
    expect(diffMarkdown('Crawls compared', 'Monday', 'Friday', rows)).toBe(
      '# Crawls compared\n\nFirst: Monday  \nSecond: Friday\n\n| What | Change | First | Second |\n| --- | --- | --- | --- |\n| CORE\\|1 | Port went down | connected | =notconnect |\n',
    );
    expect(diffMarkdown('T', 'a', 'b', [])).toMatch(/No differences\./);
  });
  it('as CSV, safe to open in a spreadsheet', () => {
    expect(diffCsv(rows)).toBe("What,Change,First,Second\r\nCORE|1,Port went down,connected,'=notconnect");
  });
});
