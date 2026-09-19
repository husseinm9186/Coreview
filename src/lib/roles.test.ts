import { describe, expect, it } from 'vitest';

import type { AttachedDevice, CrawledDevice, Neighbor } from './ipc';
import { inferRoles } from './roles';

const nb = (name: string, klass: Neighbor['class'] = 'switch'): Neighbor => ({
  deviceId: name, shortName: name, addresses: [], localInterface: 'Gi0/1', remoteInterface: 'Gi0/1', platform: null,
  serial: null, capabilities: [], version: null, class: klass, discoveredBy: 'cdp', chassisId: null, vendor: null,
});
const host = (i: number): AttachedDevice => ({ mac: `0000.5e00.53${String(i).padStart(2, '0')}`, port: `Gi0/${i}`, address: null, vendor: null, hostname: null, class: null, portPopulation: 1 });
const dev = (hostname: string, over: Partial<CrawledDevice> = {}): CrawledDevice => ({
  hostname, address: `192.0.2.${hostname.length}`, addresses: [], probeTarget: '', class: 'switch', platform: null, serial: null,
  version: null, neighbors: [], hops: 0, reachedBy: 'ssh', attached: [], ...over,
});
const stp = (root: boolean, n = 4) => Array.from({ length: n }, (_, i) => ({
  instance: `VLAN${i}`, vlan: i, protocol: 'rstp', rootBridge: null, rootPriority: null, isRoot: root, rootPort: null, bridgeAddress: null, ports: [],
}));

describe('role inference (LT-214)', () => {
  it('names firewalls, load balancers, wireless and edge routers from what they are', () => {
    const roles = inferRoles([
      dev('FW1', { class: 'unknown', platform: 'FortiGate-60F' }),
      dev('LB1', { class: 'unknown', version: 'BIG-IP 17.1' }),
      dev('WLC', { class: 'wireless-controller' }),
      dev('RTR', { class: 'router', defaultNextHop: '203.0.113.1' }),
    ]);
    expect(Object.fromEntries([...roles].map(([k, v]) => [k, v.role]))).toEqual({ fw1: 'firewall', lb1: 'load-balancer', wlc: 'wireless', rtr: 'edge' });
    expect(roles.get('rtr')!.reasons[0]).toMatch(/leaves the crawled network/);
  });

  it('tells a core, a distribution and an access switch apart by evidence', () => {
    const roles = inferRoles([
      dev('CORE', { spanningTree: stp(true), neighbors: [nb('DIST1'), nb('DIST2'), nb('FW1', 'firewall')] }),
      dev('DIST1', { spanningTree: stp(false), neighbors: [nb('CORE'), nb('ACC1'), nb('ACC2')] }),
      dev('ACC1', { neighbors: [nb('DIST1')], attached: [1, 2, 3, 4, 5, 6].map(host) }),
      dev('ACC2', {
        neighbors: [nb('DIST1')],
        ports: [3, 4, 5, 6, 7].map((i) => ({ port: `Gi0/${i}`, description: '', status: 'connected', vlan: '10', duplex: 'a-full', speed: '1000', media: '' })),
        portVlans: [3, 4, 5, 6, 7].map((i) => ({ port: `Gi0/${i}`, mode: 'access' as const, vlan: 10, trunkVlans: [] })),
      }),
    ]);
    expect(roles.get('core')!.role).toBe('core');
    expect(roles.get('core')!.reasons).toContain('spanning-tree root for 4 of 4 instances');
    expect(roles.get('dist1')!.role).toBe('distribution');
    expect(roles.get('acc1')!.role).toBe('access');
    expect(roles.get('acc1')!.reasons[0]).toBe('6 hosts plugged straight in');
    expect(roles.get('acc2')!.role).toBe('access');
  });

  it('places a quiet switch by what it sits between, and leaves one with no evidence alone', () => {
    const roles = inferRoles([
      dev('CORE', { spanningTree: stp(true), neighbors: [nb('MID'), nb('OTHER')] }),
      dev('MID', { neighbors: [nb('CORE'), nb('ACC')] }),
      dev('ACC', { neighbors: [nb('MID')], attached: [1, 2, 3, 4].map(host) }),
      dev('LONELY'),
    ]);
    expect(roles.get('mid')!.role).toBe('distribution');
    expect(roles.has('lonely')).toBe(false);
  });
});
