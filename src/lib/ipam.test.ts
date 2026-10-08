import { describe, expect, it } from 'vitest';

import { buildIpam, entriesOf, ipamRows, rangeProblem, normaliseCidr, nextFreeIn, parseCidr, subnetProblem, toAddress, toValue, utilisation } from './ipam';
import type { IpamState } from './ipam';
import type { TopoNode } from '../state/store';

/** Documentation addresses only — nothing from anyone's network. */
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

describe('the register built from the project', () => {
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

  it('an excluded address is neither free nor used', () => {
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

  it('adopting a derived subnet keeps what derived it', () => {
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

  it('marks a declared subnet the addresses on it confirm', () => {
    const state: IpamState = { subnets: [{ id: 's1', cidr: '198.51.100.0/24', name: 'Server VLAN' }] };
    const block = buildIpam([device('a', 'Server', ['198.51.100.10'])], state).blocks[0]!;
    expect(block.origin).toBe('declared');
    expect(block.alsoDerived).toBe('from addresses');
    // And the subnet is not duplicated by the /24 fallback.
    expect(buildIpam([device('a', 'Server', ['198.51.100.10'])], state).blocks).toHaveLength(1);
  });

  it('a DHCP pool is neither free nor used', () => {
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

  it('keeps the fuller address record it is given', () => {
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
      // Site, tenant, device and tags. A device's own address is on
      // that device, so it names it.
      '', '', 'Core', '',
    ]);
  });
});

describe('where, whose, and which device', () => {
  const state: IpamState = {
    sites: [{ id: 's1', name: 'HQ' }, { id: 's2', name: 'Branch Two' }],
    tenants: [{ id: 't1', name: 'Finance' }, { id: 't2', name: 'Retail' }],
    customFields: [{ id: 'f1', name: 'Cost', type: 'number', on: ['address'] }],
    subnets: [{ id: 'n1', cidr: '192.0.2.0/24', siteId: 's1', tenantId: 't1', custom: { f9: 'x' } }],
    entries: [
      // Set its own site; takes the subnet's tenant.
      { id: 'e1', address: '192.0.2.5', label: 'printer', kind: 'in-use', siteId: 's2', custom: { f1: '40' } },
      // Nothing of its own: both from the subnet. Linked to a device.
      { id: 'e2', address: '192.0.2.6', label: 'phone', kind: 'in-use', deviceId: 'sw', deviceInterface: 'Gi0/6' },
      // Its own tenant, and a link to a device since deleted.
      { id: 'e3', address: '192.0.2.7', label: 'old', kind: 'reserved', tenantId: 't2', deviceId: 'gone' },
    ],
  };
  const nodes = [device('sw', 'LAB-SW-A', ['192.0.2.1'], { site: 'Branch Two' })];
  const rows = () => buildIpam(nodes, state).blocks[0]!.addresses;
  const row = (address: string) => rows().find((a) => a.address === address)!;

  it('an address says where it is, and whether that is its own answer or its subnet\'s', () => {
    expect(row('192.0.2.5').site).toEqual({ name: 'Branch Two', from: 'own' });
    expect(row('192.0.2.5').tenant).toEqual({ name: 'Finance', from: 'subnet' });
    expect(row('192.0.2.6').site).toEqual({ name: 'HQ', from: 'subnet' });
    expect(row('192.0.2.7').tenant).toEqual({ name: 'Retail', from: 'own' });
  });

  it('a device\'s own address takes the device\'s site before the subnet\'s', () => {
    // The device says it is in Branch Two; the subnet says HQ. The device is
    // the more specific statement about where that box physically is.
    expect(row('192.0.2.1').site).toEqual({ name: 'Branch Two', from: 'device' });
    expect(row('192.0.2.1').deviceLabel).toBe('LAB-SW-A');
  });

  it('a typed address can be linked to a device, and a broken link says so', () => {
    expect(row('192.0.2.6').deviceLabel).toBe('LAB-SW-A');
    expect(row('192.0.2.6').deviceInterface).toBe('Gi0/6');
    expect(row('192.0.2.6').deviceMissing).toBeUndefined();
    // Deleted from the diagram: the link is kept, and shown as broken rather
    // than silently dropped or pointed at the wrong thing.
    expect(row('192.0.2.7').deviceLabel).toBeUndefined();
    expect(row('192.0.2.7').deviceMissing).toBe(true);
  });

  it('carries the operator\'s own fields, and the subnet keeps its own', () => {
    expect(row('192.0.2.5').custom).toEqual({ f1: '40' });
    expect(row('192.0.2.6').custom).toBeUndefined();
    const block = buildIpam(nodes, state).blocks[0]!;
    expect(block.siteId).toBe('s1');
    expect(block.tenantId).toBe('t1');
    expect(block.custom).toEqual({ f9: 'x' });
  });

  it('a site nobody can name is not invented', () => {
    // A subnet pointing at a site that has since been removed says nothing,
    // rather than showing an id nobody can read.
    const orphan: IpamState = { subnets: [{ id: 'n1', cidr: '192.0.2.0/24', siteId: 'nope' }] };
    const a = buildIpam([device('sw', 'LAB-SW-A', ['192.0.2.1'])], orphan).blocks[0]!.addresses[0]!;
    expect(a.site).toBeUndefined();
  });
});

describe('the export carries where, whose and which device', () => {
  it('adds them after the columns that were already there, and one per field', () => {
    const state: IpamState = {
      sites: [{ id: 's1', name: 'HQ' }],
      customFields: [
        { id: 'f1', name: 'Circuit ID', type: 'text', on: ['address'] },
        { id: 'f2', name: 'Subnet only', type: 'text', on: ['subnet'] },
      ],
      subnets: [{ id: 'n1', cidr: '192.0.2.0/24', siteId: 's1' }],
      entries: [{ id: 'e1', address: '192.0.2.5', label: 'cam', kind: 'in-use', tags: ['cctv'],
        deviceId: 'sw', deviceInterface: 'Gi0/5', custom: { f1: 'CKT-1' } }],
    };
    const rows = ipamRows(buildIpam([device('sw', 'LAB-SW-A', ['192.0.2.1'])], state), state.customFields);
    const head = rows[0]!;
    // The old columns keep their places, so a sheet built on them still works.
    expect(head.slice(0, 16)).toEqual(['Subnet', 'Subnet name', 'VLAN', 'Address', 'Name', 'Held as', 'Used as',
      'Hostname', 'FQDN', 'Owner', 'Purpose', 'Interface', 'MAC', 'In range', 'Known from', 'Note']);
    expect(head.slice(16)).toEqual(['Site', 'Tenant', 'Device', 'Tags', 'Circuit ID']);
    const cam = rows.find((r) => r[3] === '192.0.2.5')!;
    const at = (h: string) => cam[head.indexOf(h)];
    expect([at('Site'), at('Device'), at('Interface'), at('Tags'), at('Circuit ID')])
      .toEqual(['HQ', 'LAB-SW-A', 'Gi0/5', 'cctv', 'CKT-1']);
  });
});
