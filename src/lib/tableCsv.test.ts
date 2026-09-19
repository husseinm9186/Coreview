import { describe, expect, it } from 'vitest';

import { parseCsv } from './csv';
import { portsCsv, probeResultsCsv, vlansCsv } from './tableCsv';
import { emptyDocument } from '../state/store';
import type { TopoNode } from '../state/store';
import type { Probe } from '../types/domain';

const doc = () => {
  const d = emptyDocument();
  const sw = {
    id: 'sw', type: 'device', position: { x: 0, y: 0 },
    data: {
      label: 'ACCESS-SW7', deviceType: 'access-switch', tags: [], addresses: [],
      inventory: {
        collectedAt: 0, routes: [], spanningTree: [],
        vlans: [{ id: 20, name: 'PRINTERS' }, { id: 10, name: 'STAFF' }],
        ports: [
          { port: 'Gi0/1', status: 'connected', mode: 'trunk', vlan: 1, trunkVlans: '1,10,20', speed: '1000', duplex: 'full', errors: { input: 3, crc: 2, output: 0, collisions: 0, resets: 1, drops: 4 } },
          { port: 'Gi0/2', description: 'desk, 12', status: 'notconnect', mode: 'access', vlan: 10 },
          { port: 'Gi0/3', status: 'connected', mode: 'access', vlan: 10 },
        ],
      },
    },
  } as unknown as TopoNode;
  d.pages[0]!.nodes = [sw];
  d.probes = [{ id: 'p1', objectKind: 'node', objectId: 'sw', name: 'Ping', kind: 'tcp', target: '192.0.2.7', tcpPort: 22, enabled: true } as Probe];
  return d;
};

describe('table CSVs (LT-252)', () => {
  it('lists every port with its counters', () => {
    const rows = parseCsv(portsCsv(doc()));
    expect(rows[0]!.slice(0, 3)).toEqual(['Device', 'Page', 'Port']);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual(['ACCESS-SW7', 'Page 1', 'Gi0/1', '', 'connected', '1000', 'full', 'trunk', '1', '1,10,20', '3', '2', '0', '0', '4', '1']);
    expect(rows[2]![3]).toBe('desk, 12');
  });

  it('lists VLANs in number order with their access ports', () => {
    expect(parseCsv(vlansCsv(doc())).slice(1)).toEqual([
      ['10', 'STAFF', 'ACCESS-SW7', 'Page 1', '2'],
      ['20', 'PRINTERS', 'ACCESS-SW7', 'Page 1', '0'],
    ]);
  });

  it('lists what every probe last found, and its availability over the samples held', () => {
    const runtime = new Map([['p1', { probeId: 'p1', status: 'warning' as const, lastRttMs: 12.5, lastSuccessMs: 86_400_000, lastFailureMs: null, lastSummary: 'slow', consecutiveFailures: 0, failureThreshold: 3 }]]);
    const samples = new Map([['p1', [{ timestampMs: 1, status: 'healthy', rttMs: 1 }, { timestampMs: 2, status: 'down', rttMs: null }]]]);
    const rows = parseCsv(probeResultsCsv(doc(), runtime, samples));
    expect(rows[1]).toEqual(['ACCESS-SW7', 'Ping', 'tcp', '192.0.2.7:22', 'yes', 'warning', '12.5', '1970-01-02T00:00:00.000Z', '', '0', '50', '2', 'slow']);
  });
});
