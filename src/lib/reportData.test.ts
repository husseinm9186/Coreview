import { describe, expect, it } from 'vitest';

import { reportInput } from './reportData';
import { REPORT_TEMPLATES } from './reportPdf';
import { emptyDocument, type TopoNode } from '../state/store';
import type { Probe } from '../types/domain';

describe('what a report says (LT-256)', () => {
  const doc = emptyDocument();
  doc.pages[0]!.nodes = [
    { id: 'a', type: 'device', position: { x: 0, y: 0 }, data: { label: 'CORE-SW1', deviceType: 'core-switch', tags: [], vendor: 'Cisco', model: 'C9300', serial: 'S1', site: 'Lab', rack: 'R01', rackU: 40, addresses: [{ id: 'x', label: 'Mgmt', address: '192.0.2.10', isPrimary: true }],
      inventory: { collectedAt: 0, vlans: [], routes: [], spanningTree: [], ports: [{ port: 'Gi1/0/1', status: 'connected', speed: '1000', duplex: 'full', mode: 'trunk', trunkVlans: '1,10', errors: { input: 1, crc: 2, output: 0, collisions: 0, resets: 0, drops: 9 } }] } } },
    { id: 'z', type: 'device', position: { x: 0, y: 0 }, data: { label: 'Server room', deviceType: 'zone', tags: [] } },
  ] as unknown as TopoNode[];
  doc.probes = [{ id: 'p', objectKind: 'node', objectId: 'a', name: 'SSH', kind: 'tcp', target: '192.0.2.10', tcpPort: 22, intervalSeconds: 10, failureThreshold: 3, recoveryThreshold: 2, enabled: true, maintenance: false } as Probe];
  const r = reportInput({
    meta: { id: 'm', name: 'Lab', customer: '', site: '', ticket: '', engineer: '', description: '', createdAt: 0, updatedAt: 0, archived: false },
    doc, template: REPORT_TEMPLATES[0]!, sections: ['devices'], generatedAt: new Date(0),
    runtime: new Map([['p', { probeId: 'p', status: 'down' as const, lastRttMs: null, lastSuccessMs: null, lastFailureMs: 1, lastSummary: 'Refused', consecutiveFailures: 3, failureThreshold: 3 }]]),
    samples: new Map([['p', [{ timestampMs: 1, status: 'healthy', rttMs: 1 }, { timestampMs: 2, status: 'down', rttMs: null }, { timestampMs: 3, status: 'down', rttMs: null }, { timestampMs: 4, status: 'healthy', rttMs: 1 }]]]),
    events: [{ id: 'e', projectId: 'm', sessionId: null, timestampMs: 0, objectType: 'node', objectId: 'a', objectName: 'CORE-SW1', eventType: 'transition', previousStatus: 'healthy', currentStatus: 'down', probeType: 'tcp', target: '192.0.2.10', rttMs: null, message: 'Refused' }],
    nodeStatus: () => 'down', typeLabel: (t) => t.toUpperCase(), diagrams: [], diffs: [],
  });

  it('lists devices, not drawing shapes, with where they are', () => {
    expect(r.devices).toEqual([{ name: 'CORE-SW1', type: 'CORE-SWITCH', address: '192.0.2.10', model: 'Cisco C9300', serial: 'S1', location: 'Lab / R01 / U40', status: 'Down' }]);
    expect(r.statusCounts.down).toBe(1);
  });

  it('words ports, checks and results the way the tables show them', () => {
    expect(r.ports[0]).toEqual({ device: 'CORE-SW1', port: 'Gi1/0/1', status: 'connected', speed: '1000 full', vlan: 'trunk 1,10', errors: '3' });
    expect(r.probes[0]).toMatchObject({ object: 'CORE-SW1', kind: 'TCP', target: '192.0.2.10:22', every: '10 s', thresholds: '3 down / 2 up', enabled: 'yes' });
    expect(r.results[0]).toMatchObject({ status: 'Down', rtt: '—', availability: '50%', last: 'Refused' });
    expect(r.transitions[0]).toMatchObject({ object: 'CORE-SW1', change: 'Healthy → Down', time: '1970-01-01 00:00' });
  });
});
