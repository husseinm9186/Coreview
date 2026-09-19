import { describe, expect, it } from 'vitest';

import type { ProjectDocument, TopoNode } from '../state/store';
import { fuzzyScore, search, searchIndex } from './search';

const dev = (id: string, data: Record<string, unknown>) =>
  ({ id, type: 'device', position: { x: 0, y: 0 }, data: { deviceType: 'core-switch', tags: [], addresses: [], locked: false, maintenance: false, showDetails: true, ...data } }) as unknown as TopoNode;

const doc = {
  activePageId: 'p1',
  pages: [
    {
      id: 'p1', name: 'Core', canvas: {},
      nodes: [
        dev('a', {
          label: 'CORE-SW1', role: 'Core', mac: '00:00:5e:00:53:01', hostname: 'core-sw1.example.test',
          addresses: [{ id: '1', label: 'Management', address: '192.0.2.10', isPrimary: true }],
          inventory: {
            collectedAt: 0, ports: [{ port: 'Gi0/9', status: 'connected', mode: 'trunk' }],
            vlans: [{ id: 30, name: 'PRINTERS' }],
            routes: [{ family: 4, prefix: '192.0.2.0/24', protocol: 'connected', nextHops: [], interface: 'Vlan1' }],
            spanningTree: [],
          },
        }),
        { id: 'n', type: 'note', position: { x: 0, y: 0 }, data: { title: 'Change window', body: 'Saturday' } } as unknown as TopoNode,
      ],
      edges: [{ id: 'e', source: 'a', target: 'b', data: { sourcePortLabel: 'Gi0/1', targetPortLabel: 'Gi1/0/48' } }],
    },
    { id: 'p2', name: 'Branch', canvas: {}, nodes: [dev('b', { label: 'ACC-SW7' })], edges: [] },
  ],
  probes: [{ id: 'pr', objectId: 'a', name: 'Management', kind: 'icmp', target: '192.0.2.10' }],
} as unknown as ProjectDocument;

describe('searching a project (LT-230, LT-231)', () => {
  const index = searchIndex(doc, [{ type: 'firewall', label: 'Firewall' }]);

  it('indexes devices on every page and what is known about them', () => {
    const kinds = new Set(index.map((i) => i.kind));
    expect([...kinds].sort()).toEqual(['address', 'device', 'hostname', 'mac', 'note', 'port', 'probe', 'shape', 'subnet', 'vlan']);
    expect(index.find((i) => i.text === 'ACC-SW7')).toMatchObject({ pageId: 'p2', detail: ' · Branch' });
    expect(index.filter((i) => i.kind === 'port').map((i) => i.text)).toEqual(['CORE-SW1 Gi0/9', 'CORE-SW1 Gi0/1', 'ACC-SW7 Gi1/0/48']);
  });

  it('finds by initials, fragments of an address and a MAC without its punctuation', () => {
    expect(search(index, 'csw1')[0]!.text).toBe('CORE-SW1');
    expect(search(index, 'acc sw7')[0]!.text).toBe('ACC-SW7');
    expect(search(index, '0.2.10')[0]).toMatchObject({ kind: 'address', text: '192.0.2.10' });
    expect(search(index, '5e0053')[0]).toMatchObject({ kind: 'mac', nodeId: 'a' });
    expect(search(index, 'printers')[0]).toMatchObject({ kind: 'vlan', text: 'VLAN 30 PRINTERS' });
    expect(search(index, '192.0.2.0/24')[0]).toMatchObject({ kind: 'subnet' });
    expect(search(index, 'fire')[0]).toMatchObject({ kind: 'shape', shape: 'firewall' });
    expect(search(index, 'zzz')).toEqual([]);
  });

  it('ranks an exact name above a prefix above a fragment above scattered letters', () => {
    const scores = ([['core-sw1', 'core-sw1'], ['core', 'core-sw1'], ['e-sw', 'core-sw1'], ['cw', 'core-sw1']] as const).map(([q, t]) => fuzzyScore(q, t));
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[1]).toBeGreaterThan(scores[2]!);
    expect(scores[2]).toBeGreaterThan(scores[3]!);
    expect(fuzzyScore('xy', 'core')).toBeNull();
  });
});
