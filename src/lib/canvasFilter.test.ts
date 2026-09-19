import { describe, expect, it } from 'vitest';

import type { TopoEdge, TopoNode } from '../state/store';
import { filterActive, inSubnet, litNodes, matchesFilter, neighbourhood } from './canvasFilter';

const dev = (id: string, data: Record<string, unknown>) =>
  ({ id, type: 'device', position: { x: 0, y: 0 }, data: { label: id, deviceType: 'access-switch', tags: [], addresses: [], ...data } }) as unknown as TopoNode;
const e = (id: string, s: string, t: string, kind?: string) => ({ id, source: s, target: t, data: kind ? { kind } : {} }) as unknown as TopoEdge;

const nodes = [
  dev('fw', { deviceType: 'firewall', vendor: 'Acme Networks', role: 'Firewall', addresses: [{ address: '192.0.2.1' }], discoveredVia: 'Logged in', tags: ['dmz'] }),
  dev('core', { deviceType: 'core-switch', vendor: 'Acme Networks', role: 'Core', vlan: '10', addresses: [{ address: '192.0.2.10' }], discoveredVia: 'SNMP' }),
  dev('acc', { vendor: 'Other', role: 'Access', inventory: { vlans: [{ id: 30, name: 'PRINTERS' }] }, addresses: [{ address: '198.51.100.5' }], discoveredVia: 'Seen by a neighbour', notes: 'third floor' }),
  dev('zone', { deviceType: 'zone' }),
  { id: 'note', type: 'note', position: { x: 0, y: 0 }, data: { title: 'Change', body: 'third floor cutover' } } as unknown as TopoNode,
];

/** Every object healthy, whatever its id. */
const healthy = (): 'healthy' | 'warning' | 'down' | 'unknown' | 'disabled' | 'maintenance' => 'healthy';

describe('the canvas filter (LT-232)', () => {
  const lit = (f: Parameters<typeof matchesFilter>[1], status: (id: string) => ReturnType<typeof healthy> = healthy) =>
    nodes.filter((n) => matchesFilter(n, f, status(n.id))).map((n) => n.id);

  it('matches on type, vendor, role, VLAN, subnet, status, how it was discovered, tag and text', () => {
    expect(lit({ types: ['firewall', 'core-switch'] })).toEqual(['fw', 'core', 'zone']);
    expect(lit({ vendor: 'acme' })).toEqual(['fw', 'core', 'zone']);
    expect(lit({ role: 'access' })).toEqual(['acc', 'zone']);
    expect(lit({ vlan: '30' })).toEqual(['acc', 'zone']);
    expect(lit({ vlan: 'printers' })).toEqual(['acc', 'zone']);
    expect(lit({ vlan: '10' })).toEqual(['core', 'zone']);
    expect(lit({ subnet: '192.0.2.0/28' })).toEqual(['fw', 'core', 'zone']);
    expect(lit({ status: 'down' }, (id) => (id === 'core' ? 'down' : 'healthy') as never)).toEqual(['core', 'zone']);
    expect(lit({ crawl: 'snmp' })).toEqual(['core', 'zone']);
    expect(lit({ crawl: 'not-discovered' })).toEqual(['zone']);
    expect(lit({ tag: 'DMZ' })).toEqual(['fw', 'zone']);
    expect(lit({ text: 'third floor' })).toEqual(['acc', 'zone', 'note']);
    expect(lit({ vendor: 'acme', role: 'core' })).toEqual(['core', 'zone']);
  });

  it('knows when it is doing anything, and what is in a subnet', () => {
    expect(filterActive({})).toBe(false);
    expect(filterActive({ types: [], vendor: '  ' })).toBe(false);
    expect(filterActive({ tag: 'x' })).toBe(true);
    expect(inSubnet('192.0.2.200', '192.0.2.128/25')).toBe(true);
    expect(inSubnet('192.0.2.1', '192.0.2.128/25')).toBe(false);
    expect(inSubnet('bad', '192.0.2.0/24')).toBe(false);
  });
});

describe('focus (LT-233)', () => {
  const edges = [e('1', 'a', 'b'), e('2', 'b', 'c'), e('3', 'c', 'd'), e('4', 'note', 'd', 'leader')];

  it('keeps the selection and its neighbours a number of links out, ignoring leader lines', () => {
    expect([...neighbourhood(edges, ['b'], 1)].sort()).toEqual(['a', 'b', 'c']);
    expect([...neighbourhood(edges, ['b'], 2)].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...neighbourhood(edges, ['d'], 1)].sort()).toEqual(['c', 'd']);
  });

  it('combines with a filter, and dims nothing when neither is on', () => {
    const ns = ['a', 'b', 'c', 'd'].map((id) => dev(id, { role: id === 'c' ? 'Core' : 'Access' }));
    expect(litNodes(ns, edges, null, null, () => 'healthy')).toBeNull();
    expect([...litNodes(ns, edges, { role: 'access' }, { ids: ['b'], hops: 1 }, () => 'healthy')!].sort()).toEqual(['a', 'b']);
  });
});
