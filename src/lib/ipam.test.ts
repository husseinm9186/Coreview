import { describe, expect, it } from 'vitest';

import { buildIpam, entriesOf, ipamRows, rangeProblem, normaliseCidr, nextFreeIn, parseCidr, subnetProblem, toAddress, toValue, utilisation } from './ipam';
import type { IpamState } from './ipam';
import type { TopoNode } from '../state/store';

/** Documentation addresses only — nothing from anyone's network (D-027). */
const device = (
  id: string,
  label: string,
  addresses: string[],
  extra: Record<string, unknown> = {},
): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x: 0, y: 0 },
    data: {
      label,
      addresses: addresses.map((address, i) => ({ id: `${id}-${i}`, label: i === 0 ? 'Management' : 'Loopback0', address, isPrimary: i === 0 })),
      tags: [],
      ...extra,
    },
  }) as unknown as TopoNode;

describe('address arithmetic', () => {
  it('reads and writes IPv4', () => {
    expect(toValue('192.0.2.1')).toBe(3221225985);
    expect(toAddress(3221225985)).toBe('192.0.2.1');
    expect(toValue('192.0.2')).toBeNull();
    expect(toValue('192.0.2.256')).toBeNull();
    expect(toValue('not an address')).toBeNull();
  });

  it('takes a prefix down to its network address', () => {
    expect(parseCidr('192.0.2.77/24')).toEqual({ network: toValue('192.0.2.0'), prefix: 24 });
    expect(normaliseCidr('192.0.2.77/24')).toBe('192.0.2.0/24');
    expect(normaliseCidr('192.0.2.0/33')).toBeNull();
    expect(normaliseCidr('192.0.2.0')).toBeNull();
    expect(normaliseCidr('192.0.2.0/')).toBeNull();
  });

  it('says why a typed subnet is no good', () => {
    expect(subnetProblem('  ')).toMatch(/Give a subnet/);
    expect(subnetProblem('192.0.2.0')).toMatch(/not an IPv4 subnet/);
    expect(subnetProblem('192.0.2.0/24')).toBeNull();
  });

  it('skips network and broadcast, but not on a /31 or /32', () => {
    expect(nextFreeIn({ network: toValue('192.0.2.0')!, prefix: 24 }, new Set())).toBe('192.0.2.1');
    expect(nextFreeIn({ network: toValue('192.0.2.0')!, prefix: 31 }, new Set())).toBe('192.0.2.0');
    expect(nextFreeIn({ network: toValue('192.0.2.4')!, prefix: 30 }, new Set([toValue('192.0.2.5')!]))).toBe('192.0.2.6');
    // Full: a /30 with both usable addresses taken.
    expect(nextFreeIn({ network: toValue('192.0.2.4')!, prefix: 30 },
      new Set([toValue('192.0.2.5')!, toValue('192.0.2.6')!]))).toBeNull();
    // Too large to walk, and the answer would be obvious anyway.
    expect(nextFreeIn({ network: toValue('10.0.0.0')!, prefix: 8 }, new Set())).toBeNull();
  });
});

describe('the register built from the project (LT-285)', () => {
  it('makes a block per /24 when nothing declares a mask', () => {
    const model = buildIpam([device('a', 'Core', ['192.0.2.10']), device('b', 'Access', ['198.51.100.10'])], undefined);
    expect(model.blocks.map((b) => b.cidr)).toEqual(['192.0.2.0/24', '198.51.100.0/24']);
    expect(model.blocks.map((b) => b.origin)).toEqual(['from addresses', 'from addresses']);
    expect(model.blocks[0]!.used).toBe(1);
    expect(model.blocks[0]!.free).toBe(253);
    expect(model.blocks[0]!.nextFree).toBe('192.0.2.1');
  });

  it('uses a crawled connected route as the real mask', () => {
    const core = device('a', 'Core', ['192.0.2.129'], {
      discoveredVia: 'CDP',
      inventory: {
        collectedAt: 0,
        ports: [],
        vlans: [],
        spanningTree: [],
        routes: [
          { family: 4, prefix: '192.0.2.128/25', protocol: 'connected', nextHops: [], interface: 'Vlan10' },
          { family: 4, prefix: '0.0.0.0/0', protocol: 'static', nextHops: ['192.0.2.129'] },
        ],
      },
    });
    const model = buildIpam([core], undefined);
    expect(model.blocks.map((b) => b.cidr)).toEqual(['192.0.2.128/25']);
    const block = model.blocks[0]!;
    expect(block.origin).toBe('connected route');
    expect(block.name).toBe('Vlan10');
    expect(block.usable).toBe(126);
    expect(block.addresses[0]!.source).toBe('crawled');
    expect(block.excluded).toBe(0);
    // A static route is not a subnet anyone is addressing out of.
    expect(model.blocks.some((b) => b.cidr === '0.0.0.0/0')).toBe(false);
  });

  it('puts an address in the most specific block that holds it', () => {
    const state: IpamState = {
      subnets: [
        { id: 's1', cidr: '192.0.2.0/24', name: 'Site' },
        { id: 's2', cidr: '192.0.2.8/30', name: 'Point to point' },
      ],
    };
    const model = buildIpam([device('a', 'Router', ['192.0.2.9']), device('b', 'Server', ['192.0.2.50'])], state);
    const p2p = model.blocks.find((b) => b.cidr === '192.0.2.8/30')!;
    const site = model.blocks.find((b) => b.cidr === '192.0.2.0/24')!;
    expect(p2p.addresses.map((a) => a.label)).toEqual(['Router']);
    expect(site.addresses.map((a) => a.label)).toEqual(['Server']);
    expect(p2p.free).toBe(1);
    expect(p2p.nextFree).toBe('192.0.2.10');
  });

  it('counts a held address as used, and keeps its note', () => {
    const state: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
      entries: [{ id: 'r1', address: '192.0.2.1', label: 'Gateway', kind: 'reserved', note: 'Held for the firewall move' }],
    };
    const model = buildIpam([device('a', 'Core', ['192.0.2.2'])], state);
    const block = model.blocks[0]!;
    expect(block.used).toBe(2);
    expect(block.nextFree).toBe('192.0.2.3');
    expect(block.addresses[0]).toMatchObject({
      label: 'Gateway', source: 'typed', kind: 'reserved', entryId: 'r1', note: 'Held for the firewall move',
    });
  });

  it('an excluded address is neither free nor used (LT-289)', () => {
    const state: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/29' }],
      entries: [
        { id: 'e1', address: '192.0.2.1', label: 'Router reserves this', kind: 'excluded' },
        { id: 'e2', address: '192.0.2.2', label: 'Printer', kind: 'in-use' },
      ],
    };
    const block = buildIpam([], state).blocks[0]!;
    expect(block.usable).toBe(6);
    expect(block.used).toBe(1);
    expect(block.excluded).toBe(1);
    expect(block.free).toBe(4);
    // Neither is offered as the next free one.
    expect(block.nextFree).toBe('192.0.2.3');
  });

  it('an address both excluded and in use is in use', () => {
    const state: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/29' }],
      entries: [{ id: 'e1', address: '192.0.2.1', label: 'Was excluded', kind: 'excluded' }],
    };
    const block = buildIpam([device('a', 'Core', ['192.0.2.1'])], state).blocks[0]!;
    expect(block.used).toBe(1);
    expect(block.excluded).toBe(0);
    expect(block.free).toBe(5);
  });

  it('adopting a derived subnet keeps what derived it (LT-288)', () => {
    const core = device('a', 'Core', ['192.0.2.129'], {
      inventory: {
        collectedAt: 0, ports: [], vlans: [], spanningTree: [],
        routes: [{ family: 4, prefix: '192.0.2.128/25', protocol: 'connected', nextHops: [], interface: 'Vlan10' }],
      },
    });
    const state: IpamState = { subnets: [{ id: 's1', cidr: '192.0.2.128/25', name: 'Third floor' }] };
    const block = buildIpam([core], state).blocks[0]!;
    expect(block.origin).toBe('declared');
    expect(block.subnetId).toBe('s1');
    expect(block.name).toBe('Third floor');
    expect(block.alsoDerived).toBe('connected route');
    // The interface stays as a suggestion for the name field.
    expect(block.routeInterface).toBe('Vlan10');
  });

  it('marks a declared subnet the addresses on it confirm (LT-288)', () => {
    const state: IpamState = { subnets: [{ id: 's1', cidr: '198.51.100.0/24', name: 'Server VLAN' }] };
    const block = buildIpam([device('a', 'Server', ['198.51.100.10'])], state).blocks[0]!;
    expect(block.origin).toBe('declared');
    expect(block.alsoDerived).toBe('from addresses');
    // And the subnet is not duplicated by the /24 fallback.
    expect(buildIpam([device('a', 'Server', ['198.51.100.10'])], state).blocks).toHaveLength(1);
  });

  it('a DHCP pool is neither free nor used (LT-294)', () => {
    const state: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
      ranges: [{ id: 'r1', from: '192.0.2.100', to: '192.0.2.199', kind: 'dhcp', name: 'Staff laptops' }],
    };
    const block = buildIpam([device('a', 'Core', ['192.0.2.10'])], state).blocks[0]!;
    expect(block.usable).toBe(254);
    expect(block.used).toBe(1);
    expect(block.pooled).toBe(100);
    expect(block.free).toBe(153);
    // And the next free address is not inside the pool.
    expect(block.nextFree).toBe('192.0.2.1');
  });

  it('the next free address steps over a pool that starts at the bottom', () => {
    const state: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
      ranges: [{ id: 'r1', from: '192.0.2.1', to: '192.0.2.50', kind: 'dhcp' }],
    };
    expect(buildIpam([], state).blocks[0]!.nextFree).toBe('192.0.2.51');
  });

  it('an excluded range is excluded, not pooled', () => {
    const state: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
      ranges: [{ id: 'r1', from: '192.0.2.200', to: '192.0.2.254', kind: 'excluded', name: 'Kept for the WAN' }],
    };
    const block = buildIpam([], state).blocks[0]!;
    expect(block.excluded).toBe(55);
    expect(block.pooled).toBe(0);
    expect(block.free).toBe(199);
  });

  it('a reservation inside its own pool is one address, not two', () => {
    const state: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
      ranges: [{ id: 'r1', from: '192.0.2.100', to: '192.0.2.109', kind: 'dhcp' }],
      entries: [{ id: 'e1', address: '192.0.2.105', label: 'Printer', kind: 'in-use', assignment: 'dhcp-reservation' }],
    };
    const block = buildIpam([], state).blocks[0]!;
    expect(block.used).toBe(1);
    expect(block.pooled).toBe(9);
    expect(block.free).toBe(254 - 1 - 9);
    // The row says which range it is in, so the panel can show it.
    expect(block.addresses[0]!.inRange).toMatchObject({ id: 'r1', kind: 'dhcp' });
  });

  it('a range never counts the network or broadcast address', () => {
    const state: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
      ranges: [{ id: 'r1', from: '192.0.2.0', to: '192.0.2.255', kind: 'dhcp' }],
    };
    const block = buildIpam([], state).blocks[0]!;
    expect(block.pooled).toBe(254);
    expect(block.free).toBe(0);
    expect(block.nextFree).toBeNull();
  });

  it('two overlapping ranges do not count the overlap twice', () => {
    const state: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
      ranges: [
        { id: 'r1', from: '192.0.2.10', to: '192.0.2.20', kind: 'dhcp' },
        { id: 'r2', from: '192.0.2.15', to: '192.0.2.25', kind: 'dhcp' },
      ],
    };
    expect(buildIpam([], state).blocks[0]!.pooled).toBe(16);
  });

  it('says why a range is no good', () => {
    const block = { network: toValue('192.0.2.0')!, prefix: 24 };
    expect(rangeProblem('nonsense', '192.0.2.5')).toMatch(/first address/);
    expect(rangeProblem('192.0.2.5', 'nonsense')).toMatch(/last address/);
    expect(rangeProblem('192.0.2.50', '192.0.2.10')).toMatch(/before/);
    expect(rangeProblem('192.0.2.10', '198.51.100.10', block)).toMatch(/inside the subnet/);
    expect(rangeProblem('192.0.2.10', '192.0.2.50', block)).toBeNull();
  });

  it('keeps the fuller address record LT-297 gives it', () => {
    const state: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
      entries: [{
        id: 'e1', address: '192.0.2.9', label: 'Badge reader', kind: 'in-use',
        assignment: 'static', hostname: 'badge-01', fqdn: 'badge-01.example.invalid',
        mac: '00:00:5e:00:53:23', owner: 'Facilities', purpose: 'Door controller',
      }],
    };
    expect(buildIpam([], state).blocks[0]!.addresses[0]).toMatchObject({
      assignment: 'static', hostname: 'badge-01', fqdn: 'badge-01.example.invalid',
      mac: '00:00:5e:00:53:23', owner: 'Facilities', purpose: 'Door controller',
    });
  });

  it('reads the pre-LT-289 reservations a project may still carry', () => {
    const state: IpamState = {
      reservations: [{ id: 'r1', address: '192.0.2.5', label: 'Old hold' }],
    };
    expect(entriesOf(state)).toEqual([{ id: 'r1', address: '192.0.2.5', label: 'Old hold', kind: 'reserved' }]);
    // Once migrated, the new field wins and the old one is not counted twice.
    expect(entriesOf({
      entries: [{ id: 'r1', address: '192.0.2.5', label: 'Old hold', kind: 'in-use' }],
      reservations: [{ id: 'r1', address: '192.0.2.5', label: 'Old hold' }],
    })).toHaveLength(1);
    expect(entriesOf(undefined)).toEqual([]);
  });

  it('counts one device on several addresses once per address', () => {
    const model = buildIpam([device('a', 'Core', ['192.0.2.10', '192.0.2.11'])], undefined);
    expect(model.blocks[0]!.used).toBe(2);
    expect(model.blocks[0]!.addresses.map((a) => a.interfaceLabel)).toEqual(['Management', 'Loopback0']);
  });

  it('says which devices it could not place, rather than dropping them', () => {
    const model = buildIpam([device('a', 'Edge', ['2001:db8::1']), device('b', 'Blank', [''])], undefined);
    expect(model.blocks).toEqual([]);
    expect(model.skipped).toEqual([{ nodeId: 'a', label: 'Edge', address: '2001:db8::1' }]);
  });

  it('reports utilisation of the usable addresses, not of the block', () => {
    const state: IpamState = { subnets: [{ id: 's1', cidr: '192.0.2.0/29' }] };
    const model = buildIpam(
      [device('a', 'A', ['192.0.2.1']), device('b', 'B', ['192.0.2.2']), device('c', 'C', ['192.0.2.3'])],
      state,
    );
    // Six usable in a /29, three of them in use.
    expect(model.blocks[0]!.usable).toBe(6);
    expect(utilisation(model.blocks[0]!)).toBe(50);
  });

  it('exports a row per known address', () => {
    const state: IpamState = { subnets: [{ id: 's1', cidr: '192.0.2.0/24', name: 'Site', vlan: 10 }] };
    const rows = ipamRows(buildIpam([device('a', 'Core', ['192.0.2.10'])], state));
    expect(rows[0]![0]).toBe('Subnet');
    expect(rows[1]).toEqual([
      '192.0.2.0/24', 'Site', '10', '192.0.2.10', 'Core', '', '', '', '', '', '',
      'Management', '', '', 'drawn', '',
    ]);
  });
});
