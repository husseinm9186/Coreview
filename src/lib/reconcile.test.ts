import { describe, expect, it } from 'vitest';

import type { CrawledDevice, Neighbor } from './ipc';
import { applyChanges, reconcile } from './reconcile';
import { buildTopology } from './topology';
import type { TopoEdge, TopoNode } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

const nb = (name: string, local: string, remote: string, ip = ''): Neighbor => ({
  deviceId: name, shortName: name, addresses: ip ? [{ ip, interface: null, isManagement: true }] : [], localInterface: local,
  remoteInterface: remote, platform: null, serial: null, capabilities: [], version: null, class: 'switch', discoveredBy: 'cdp',
  chassisId: null, vendor: null,
});
const dev = (hostname: string, address: string, neighbors: Neighbor[] = [], over: Partial<CrawledDevice> = {}): CrawledDevice => ({
  hostname, address, addresses: [{ ip: address, interface: null, isManagement: true }], probeTarget: address, class: 'switch',
  platform: null, serial: null, version: null, neighbors, hops: 0, reachedBy: 'ssh', attached: [], ...over,
});
const inside = (a: string) => a.startsWith('192.0.2.');
const run = (page: { nodes: TopoNode[]; edges: TopoEdge[] }, devices: CrawledDevice[], attached: { device: CrawledDevice['attached'][number]; host: string }[] = []) => {
  const topo = buildTopology({ devices, notVisited: [] }, 'p', { existingNodes: page.nodes, existingEdges: page.edges, attached });
  return reconcile({ page, topo, devices, inScope: inside });
};
const first = (devices: CrawledDevice[]) => {
  const topo = buildTopology({ devices, notVisited: [] }, 'p');
  return applyChanges({ nodes: [], edges: [] }, reconcile({ page: { nodes: [], edges: [] }, topo, devices, inScope: inside }));
};

describe('reconciling a crawl with the diagram (LT-216)', () => {
  it('offers new devices and their links, ticked', () => {
    const devices = [dev('CORE', '192.0.2.1', [nb('ACC', 'Gi1/0/1', 'Gi0/1', '192.0.2.2')]), dev('ACC', '192.0.2.2', [], { hops: 1 })];
    const changes = reconcile({ page: { nodes: [], edges: [] }, topo: buildTopology({ devices, notVisited: [] }, 'p'), devices, inScope: inside });
    expect(changes.map((c) => [c.kind, c.subject, c.title, c.accept])).toEqual([
      ['added', 'device', 'CORE', true],
      ['added', 'device', 'ACC', true],
    ]);
    const applied = applyChanges({ nodes: [], edges: [] }, changes);
    expect(applied.nodes).toHaveLength(2);
    expect(applied.edges).toHaveLength(1);
  });

  it('describes only what changed on a device already drawn', () => {
    const page = first([dev('CORE', '192.0.2.1', [], { platform: 'C9300-24T' })]);
    const changes = run(page, [dev('CORE', '192.0.2.1', [], { platform: 'C9300-48P', uptimeSeconds: 60 })]);
    expect(changes.map((c) => [c.kind, c.title])).toEqual([['changed', 'CORE']]);
    expect(changes[0]!.details).toEqual(['Model: C9300-24T → C9300-48P', 'Ports, VLANs, routes and spanning tree read again']);
    expect(run(page, [dev('CORE', '192.0.2.1', [], { platform: 'C9300-24T' })])).toEqual([]);
  });

  it('proposes, unticked, removing a crawled device inside the run’s subnets that was not found', () => {
    const page = first([dev('CORE', '192.0.2.1'), dev('GONE', '192.0.2.9'), dev('FAR', '198.51.100.9')]);
    const changes = run(page, [dev('CORE', '192.0.2.1')]);
    const removals = changes.filter((c) => c.kind === 'removed');
    expect(removals.map((c) => [c.title, c.accept])).toEqual([['GONE was not found', false]]);
    // Nothing is removed unless it is accepted.
    expect(applyChanges(page, changes.filter((c) => c.accept)).nodes).toHaveLength(3);
    expect(applyChanges(page, removals).nodes).toHaveLength(2);
    // With no subnet limit, nothing is offered for removal at all.
    const topo = buildTopology({ devices: [dev('CORE', '192.0.2.1')], notVisited: [] }, 'p', { existingNodes: page.nodes, existingEdges: page.edges });
    expect(reconcile({ page, topo, devices: [dev('CORE', '192.0.2.1')], inScope: null }).filter((c) => c.kind === 'removed')).toEqual([]);
  });

  it('proposes, unticked, removing a discovered link both ends stopped reporting', () => {
    const page = first([dev('CORE', '192.0.2.1', [nb('ACC', 'Gi1/0/1', 'Gi0/1', '192.0.2.2')]), dev('ACC', '192.0.2.2', [], { hops: 1 })]);
    expect(page.edges).toHaveLength(1);
    const changes = run(page, [dev('CORE', '192.0.2.1', [], { uptimeSeconds: 1 }), dev('ACC', '192.0.2.2', [], { uptimeSeconds: 1 })]);
    const gone = changes.filter((c) => c.kind === 'removed' && c.subject === 'link');
    expect(gone.map((c) => [c.title, c.accept])).toEqual([['CORE Gi1/0/1 – ACC Gi0/1', false]]);
    // Still reported: nothing offered.
    expect(run(page, [dev('CORE', '192.0.2.1', [nb('ACC', 'Gi1/0/1', 'Gi0/1', '192.0.2.2')], { uptimeSeconds: 1 }), dev('ACC', '192.0.2.2', [], { uptimeSeconds: 1 })])
      .filter((c) => c.kind === 'removed')).toEqual([]);
  });

  it('proposes, unticked, re-cabling a host seen on a different port', () => {
    const host = (port: string) => ({ mac: '0000.5e00.5301', port, address: '192.0.2.50', vendor: null, hostname: 'DESK-12', class: null, portPopulation: 1 });
    const sw = dev('ACC', '192.0.2.2', [], { attached: [host('Gi0/3')] });
    const topo = buildTopology({ devices: [sw], notVisited: [] }, 'p', { attached: [{ device: host('Gi0/3'), host: 'ACC' }] });
    const page = applyChanges({ nodes: [], edges: [] }, reconcile({ page: { nodes: [], edges: [] }, topo, devices: [sw], inScope: inside }));
    expect(page.edges).toHaveLength(1);

    const moved = dev('ACC', '192.0.2.2', [], { attached: [host('Gi0/7')] });
    const changes = run(page, [moved], [{ device: host('Gi0/7'), host: 'ACC' }]);
    const move = changes.find((c) => c.kind === 'moved')!;
    expect([move.title, move.accept]).toEqual(['DESK-12 moved from ACC Gi0/3 to ACC Gi0/7', false]);
    expect(changes.some((c) => c.kind === 'added' && c.subject === 'link')).toBe(false);
    const after = applyChanges(page, [move]);
    expect(after.edges).toHaveLength(1);
    expect((after.nodes.find((n) => (n.data as DeviceNodeData).label === 'DESK-12')!.data as DeviceNodeData).switchPort).toBe('ACC Gi0/7');
  });
});
