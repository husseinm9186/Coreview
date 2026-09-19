import { describe, expect, it } from 'vitest';

import type { CrawledDevice } from './ipc';
import { compressVlans, formatUptime, inventoryOf } from './inventory';

const base: CrawledDevice = {
  hostname: 'SW1', address: '192.0.2.7', addresses: [], probeTarget: '192.0.2.7', class: 'switch',
  platform: null, serial: null, version: null, neighbors: [], hops: 0, reachedBy: 'ssh', attached: [],
};

describe('device inventory (LT-200–204)', () => {
  it('is absent when the crawl read nothing beyond identity', () => {
    expect(inventoryOf(base, 1)).toBeUndefined();
    expect(inventoryOf({ ...base, routes: [], ports: [] }, 1)).toBeUndefined();
  });

  it('keeps ports with their VLAN mode, VLANs, routes and a spanning-tree summary', () => {
    const inv = inventoryOf({
      ...base,
      uptimeSeconds: 5019180,
      ports: [
        { port: 'Gi0/1', description: '', status: 'connected', vlan: 'trunk', duplex: 'a-full', speed: '1000', media: '10/100/1000BaseTX' },
        { port: 'Gi0/2', description: 'printer', status: 'notconnect', vlan: '30', duplex: 'auto', speed: 'auto', media: '' },
      ],
      portVlans: [
        { port: 'Gi0/1', mode: 'trunk', vlan: 1, trunkVlans: [1, 8, 10, 14, 15, 16] },
        { port: 'Gi0/2', mode: 'access', vlan: 30, trunkVlans: [] },
      ],
      vlans: [{ id: 30, name: 'PRINTERS', status: 'active', ports: ['Gi0/2'] }],
      routes: [{ family: 4, prefix: '0.0.0.0/0', code: 'S*', protocol: 'static', nextHops: ['192.0.2.1'], interface: null, distance: 1, metric: 0 }],
      spanningTree: [{
        instance: 'VLAN0001', vlan: 1, protocol: 'rstp', rootBridge: '0000.5e00.5301', rootPriority: 32768, isRoot: false,
        rootPort: 'GigabitEthernet0/1', bridgeAddress: '0000.5e00.5302',
        ports: [
          { port: 'Gi0/1', role: 'Root', state: 'FWD', cost: 4 },
          { port: 'Gi0/3', role: 'Altn', state: 'BLK', cost: 4 },
        ],
      }],
    }, 42)!;
    expect(inv.collectedAt).toBe(42);
    expect(inv.uptimeSeconds).toBe(5019180);
    expect(inv.ports).toEqual([
      { port: 'Gi0/1', status: 'connected', speed: '1000', duplex: 'a-full', mode: 'trunk', vlan: 1, trunkVlans: '1,8,10,14-16' },
      { port: 'Gi0/2', description: 'printer', status: 'notconnect', speed: 'auto', duplex: 'auto', mode: 'access', vlan: 30 },
    ]);
    expect(inv.vlans).toEqual([{ id: 30, name: 'PRINTERS' }]);
    expect(inv.routes).toEqual([{ family: 4, prefix: '0.0.0.0/0', protocol: 'static', nextHops: ['192.0.2.1'] }]);
    expect(inv.spanningTree).toEqual([
      { instance: 'VLAN0001', vlan: 1, rootBridge: '0000.5e00.5301', isRoot: false, rootPort: 'GigabitEthernet0/1', blocked: ['Gi0/3'] },
    ]);
  });

  it('puts error counters on the port they belong to, full name or short (LT-235)', () => {
    const inv = inventoryOf({
      ...base,
      ports: [{ port: 'Gi0/3', description: '', status: 'connected', vlan: '10', duplex: 'a-full', speed: 'a-1000', media: '' }],
      counters: [{ port: 'GigabitEthernet0/3', inputErrors: 1532, crc: 1498, outputErrors: 12, collisions: 7, resets: 1, outputDrops: 40, duplexSpeed: 'Full-duplex, 1000Mb/s' }],
    }, 1)!;
    expect(inv.ports[0]!.errors).toEqual({ input: 1532, crc: 1498, output: 12, collisions: 7, resets: 1, drops: 40 });
  });

  it('compresses VLAN lists and writes uptime briefly', () => {
    expect(compressVlans([16, 1, 8, 10, 14, 15, 20, 21])).toBe('1,8,10,14-16,20,21');
    expect(compressVlans([])).toBe('');
    expect(formatUptime(5019180)).toBe('58d 2h');
    expect(formatUptime(3700)).toBe('1h 1m');
    expect(formatUptime(90)).toBe('1m');
  });
});
