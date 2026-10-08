import { describe, expect, it } from 'vitest';

import type { TopologyGraph } from './ipc';
import { topologyCsv, topologyJson, topologyMarkdown } from './topologyExport';

// Invented names, documentation addresses.
const g: TopologyGraph = {
  nodes: [
    { id: 'n-a', name: 'SW-A', kind: 'collected', os: 'cisco_ios', role: 'switch', model: 'WS-C2960X-48TS-L', stack_kind: null, members: [], pair: null, mgmt_ip: '192.0.2.1' },
    { id: 'n-b', name: 'SW-B', kind: 'collected', os: 'cisco_ios', role: 'switch', model: null, stack_kind: null, members: [], pair: null, mgmt_ip: '192.0.2.2' },
  ],
  links: [
    { a: { node: 'n-a', port: 'Port-channel1' }, b: { node: 'n-b', port: 'Port-channel1' }, kind: 'cdp', confidence: 1, both_directions: true,
      bundle: { a_name: 'Port-channel1', b_name: 'Port-channel1', members: [['Gi1/0/23', 'Gi1/0/23'], ['Gi1/0/24', 'Gi1/0/24']] },
      evidence: [{ device: 'SW-A', command: 'show_cdp_neighbors_detail', note: 'SW-A says Gi1/0/23, "reaches" SW-B' }] },
  ],
  l3: [{ a: 'n-a', a_if: 'Vlan10', b: 'n-b', b_if: 'Vlan10', subnet: '192.0.2.0/24', confirmed_by: ['ospf'], confidence: 1 }],
  overlays: [{ a: 'n-a', b: null, kind: 'ipsec', name: 'Tunnel10', local_ip: '192.0.2.1', remote_ip: '203.0.113.1' }],
  endpoints: [],
  findings: [{ kind: 'bundle', note: 'Port-channel1 on SW-A has a member nobody saw.', nodes: ['n-a'] }],
};

describe('the topology written out', () => {
  it('JSON is the graph as the builder gave it', () => {
    expect(JSON.parse(topologyJson(g))).toEqual(g);
  });

  it('CSV is one row per link, by name, with its evidence quoted safely', () => {
    const lines = topologyCsv(g).trim().split('\n');
    expect(lines[0]).toBe('a_device,a_port,b_device,b_port,kind,confidence,both_ends,bundle,members,evidence');
    expect(lines[1]).toContain('SW-A,Port-channel1,SW-B,Port-channel1,cdp,1.0,yes,Port-channel1,Gi1/0/23/Gi1/0/23 Gi1/0/24/Gi1/0/24,');
    expect(lines[1]).toContain('"SW-A: SW-A says Gi1/0/23, ""reaches"" SW-B"');
  });

  it('Markdown has the devices, links, layer 3, overlays and findings', () => {
    const md = topologyMarkdown(g, 'col-1');
    expect(md).toContain('# Topology from collection col-1');
    expect(md).toContain('| SW-A | collected | WS-C2960X-48TS-L | 192.0.2.1 |');
    expect(md).toContain('| SW-A Port-channel1 | SW-B Port-channel1 | cdp, Port-channel1 (2) | 1.0 |');
    expect(md).toContain('| SW-A Vlan10 | SW-B Vlan10 | 192.0.2.0/24 | ospf |');
    expect(md).toContain('| SW-A | 203.0.113.1 | ipsec | Tunnel10 |');
    expect(md).toContain('- Port-channel1 on SW-A has a member nobody saw.');
  });
});
