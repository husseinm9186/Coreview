/**
 * The evidence a crawl carries reaches the diagram's device, field
 * by field, and a device known only by a neighbour's word says so.
 */
import { describe, expect, it } from 'vitest';
import { buildTopology } from './topology';
import type { CrawledDevice, Neighbor } from './ipc';
import type { DeviceNodeData } from '../types/domain';

const neighbor = (name: string, over: Partial<Neighbor> = {}): Neighbor => ({
  deviceId: name,
  serial: null,
  shortName: name,
  addresses: [{ ip: '192.0.2.20', interface: null, isManagement: true }],
  localInterface: 'Gi0/1',
  remoteInterface: 'Gi0/24',
  platform: 'cisco WS-C2960',
  capabilities: [],
  version: null,
  class: 'switch',
  discoveredBy: 'cdp',
  chassisId: null,
  vendor: null,
  ...over,
});

const device = (hostname: string, address: string, neighbors: Neighbor[], over: Partial<CrawledDevice> = {}): CrawledDevice => ({
  hostname,
  serial: null,
  address,
  addresses: [{ ip: address, interface: null, isManagement: true }],
  probeTarget: address,
  class: 'router',
  platform: 'ISR4331',
  version: null,
  neighbors,
  hops: 0,
  reachedBy: 'ssh',
  attached: [],
  ...over,
});

describe('evidence on the diagram', () => {
  it('carries a reached device\'s evidence and gives a reported one the neighbour as its source', () => {
    const src = {
      devices: [
        device('EDGE', '192.0.2.1', [neighbor('ACCESS-1')], {
          evidence: {
            hostname: { source: 'prompt', detail: 'EDGE' },
            class: { source: 'ssh:show version', seenAtMs: 1_000, detail: 'Cisco IOS XE' },
          },
        }),
      ],
      notVisited: [],
    };
    const t = buildTopology(src, 'p');
    const data = (label: string) => t.nodes.find((n) => (n.data as DeviceNodeData).label === label)!.data as DeviceNodeData;

    expect(data('EDGE').evidence?.class).toEqual({ source: 'ssh:show version', seenAtMs: 1_000, detail: 'Cisco IOS XE' });
    expect(data('EDGE').evidence?.hostname?.source).toBe('prompt');

    const seen = data('ACCESS-1').evidence;
    expect(seen?.class).toMatchObject({ source: 'neighbour-report', seenBy: 'EDGE', detail: 'cisco WS-C2960' });
    expect(seen?.hostname?.seenBy).toBe('EDGE');
    expect(seen?.addresses?.source).toBe('neighbour-report');
  });

  it('a re-crawl replaces the fields it read and keeps the sources of the rest', () => {
    const first = buildTopology(
      { devices: [device('EDGE', '192.0.2.1', [], { evidence: { class: { source: 'snmp:sysServices' }, uptime: { source: 'snmp:sysUpTime' } } })], notVisited: [] },
      'p',
    );
    const again = buildTopology(
      { devices: [device('EDGE', '192.0.2.1', [], { evidence: { class: { source: 'ssh:show version' } } })], notVisited: [] },
      'p',
      { existingNodes: first.nodes as never },
    );
    const patch = again.updated.find((u) => u.id === first.nodes[0]!.id)?.data as Partial<DeviceNodeData> | undefined;
    expect(patch?.evidence?.class?.source).toBe('ssh:show version');
    expect(patch?.evidence?.uptime?.source).toBe('snmp:sysUpTime');
  });

  it('a device drawn without a crawl has no evidence, rather than an invented source', () => {
    const t = buildTopology({ devices: [device('EDGE', '192.0.2.1', [])], notVisited: [] }, 'p');
    expect((t.nodes[0]!.data as DeviceNodeData).evidence).toBeUndefined();
  });
});
