import { describe, expect, it } from 'vitest';

import {
  devicesOnPath,
  inPrefix,
  longestPrefixMatch,
  resolveNextHop,
  tracePath,
  type PathDevice,
  type PathRoute,
} from './pathTrace';

const route = (over: Partial<PathRoute> & { prefix: string }): PathRoute => ({
  family: 4,
  protocol: 'static',
  nextHops: [],
  ...over,
});

const dev = (
  hostname: string,
  addresses: string[],
  routes: PathRoute[] | undefined,
  neighbours: { localInterface: string; name: string }[] = [],
): PathDevice => ({
  hostname,
  addresses: addresses.map((ip) => ({ ip })),
  routes,
  neighbours,
});

describe('longest-prefix match', () => {
  const table = [
    route({ prefix: '0.0.0.0/0', protocol: 'static', nextHops: ['10.0.0.254'], distance: 1 }),
    route({ prefix: '10.0.0.0/8', protocol: 'ospf', nextHops: ['10.0.0.2'], distance: 110, metric: 2 }),
    route({ prefix: '10.40.0.0/16', protocol: 'bgp', nextHops: ['10.255.2.1'], distance: 20 }),
    route({ prefix: '10.40.50.0/24', protocol: 'connected', interface: 'Gi0/1' }),
  ];

  it('takes the longest mask, not the best metric', () => {
    // A /24 connected route beats a /8 OSPF route however good its metric is:
    // the mask is consulted first, and that order is not interchangeable.
    expect(longestPrefixMatch(table, '10.40.50.9')?.prefix).toBe('10.40.50.0/24');
    expect(longestPrefixMatch(table, '10.40.7.9')?.prefix).toBe('10.40.0.0/16');
    expect(longestPrefixMatch(table, '10.9.9.9')?.prefix).toBe('10.0.0.0/8');
  });

  it('falls back to the default route and no further', () => {
    expect(longestPrefixMatch(table, '198.51.100.7')?.prefix).toBe('0.0.0.0/0');
    expect(longestPrefixMatch(table.slice(1), '198.51.100.7')).toBeNull();
  });

  it('breaks a tie on administrative distance, then on metric', () => {
    const tie = [
      route({ prefix: '172.16.0.0/16', protocol: 'ospf', nextHops: ['a'], distance: 110, metric: 20 }),
      route({ prefix: '172.16.0.0/16', protocol: 'static', nextHops: ['b'], distance: 1 }),
    ];
    expect(longestPrefixMatch(tie, '172.16.1.1')?.protocol).toBe('static');

    const sameDistance = [
      route({ prefix: '172.16.0.0/16', protocol: 'ospf', nextHops: ['far'], distance: 110, metric: 40 }),
      route({ prefix: '172.16.0.0/16', protocol: 'ospf', nextHops: ['near'], distance: 110, metric: 4 }),
    ];
    expect(longestPrefixMatch(sameDistance, '172.16.1.1')?.nextHops).toEqual(['near']);
  });

  it('never matches a v4 address against a v6 table', () => {
    const v6 = [route({ prefix: '::/0', family: 6, nextHops: ['fe80::1'] })];
    expect(longestPrefixMatch(v6, '10.0.0.1')).toBeNull();
  });

  it('says nothing about an address or prefix it cannot read', () => {
    expect(inPrefix('not-an-address', '10.0.0.0/8')).toBeNull();
    expect(inPrefix('10.0.0.1', 'nonsense')).toBeNull();
    expect(inPrefix('10.0.0.1', '0.0.0.0/0')).toBe(true);
    expect(inPrefix('10.0.0.1', '10.0.0.1/32')).toBe(true);
    expect(inPrefix('10.0.0.2', '10.0.0.1/32')).toBe(false);
  });
});

describe('recursive next-hop resolution', () => {
  // The case from the brief: a BGP prefix whose next hop is a loopback that
  // only the IGP knows how to reach.
  const table = [
    route({ prefix: '10.40.50.0/24', protocol: 'bgp', nextHops: ['10.255.2.1'], distance: 20 }),
    route({ prefix: '10.255.2.1/32', protocol: 'ospf', nextHops: ['192.168.12.2'], distance: 110, metric: 3 }),
    route({ prefix: '192.168.12.0/30', protocol: 'connected', interface: 'Gi0/0' }),
  ];

  it('follows a BGP next hop through the IGP down to an interface', () => {
    const out = resolveNextHop(table, '10.255.2.1');
    expect(out.resolved).toBe(true);
    expect(out.interface).toBe('Gi0/0');
    expect(out.via.map((v) => v.prefix)).toEqual(['10.255.2.1/32', '192.168.12.0/30']);
    expect(out.via.map((v) => v.protocol)).toEqual(['ospf', 'connected']);
  });

  it('gives up rather than looping when a next hop points at itself', () => {
    const circular = [route({ prefix: '10.255.2.1/32', protocol: 'bgp', nextHops: ['10.255.2.1'] })];
    expect(resolveNextHop(circular, '10.255.2.1').resolved).toBe(false);
  });

  it('is unresolved when nothing covers the next hop', () => {
    expect(resolveNextHop([], '10.255.2.1')).toEqual({ interface: null, via: [], resolved: false });
  });
});

describe('a path that gets there', () => {
  const edge = dev(
    'EDGE',
    ['192.168.12.1'],
    [
      route({ prefix: '10.40.50.0/24', protocol: 'bgp', nextHops: ['10.255.2.1'], distance: 20 }),
      route({ prefix: '10.255.2.1/32', protocol: 'ospf', nextHops: ['192.168.12.2'], distance: 110, metric: 3 }),
      route({ prefix: '192.168.12.0/30', protocol: 'connected', interface: 'Gi0/0' }),
    ],
    [{ localInterface: 'Gi0/0', name: 'CORE' }],
  );
  const core = dev(
    'CORE',
    ['192.168.12.2', '10.255.2.1'],
    [route({ prefix: '10.40.50.0/24', protocol: 'connected', interface: 'Vlan50' })],
  );

  it('walks hop by hop and says the protocol at each decision', () => {
    const out = tracePath({ devices: [edge, core], from: 'EDGE', to: '10.40.50.9' });
    expect(out.kind).toBe('delivered');
    const [path] = out.paths;
    expect(path!.map((h) => h.device)).toEqual(['EDGE', 'CORE']);
    expect(path![0]!.protocol).toBe('bgp');
    expect(path![0]!.nextHop).toBe('10.255.2.1');
    expect(path![1]!.protocol).toBe('connected');
    expect(path![1]!.outInterface).toBe('Vlan50');
  });

  it('shows the recursion that turned a BGP next hop into a cable', () => {
    const out = tracePath({ devices: [edge, core], from: 'EDGE', to: '10.40.50.9' });
    const first = out.paths[0]![0]!;
    expect(first.outInterface).toBe('Gi0/0');
    expect(first.via.map((v) => v.prefix)).toEqual(['10.255.2.1/32', '192.168.12.0/30']);
  });

  it('explains why each route won', () => {
    const out = tracePath({ devices: [edge, core], from: 'EDGE', to: '10.40.50.9' });
    expect(out.paths[0]![0]!.why).toMatch(/longest prefix|only route/);
  });

  it('can be started from an address as well as a name', () => {
    expect(tracePath({ devices: [edge, core], from: '192.168.12.1', to: '10.40.50.9' }).kind).toBe('delivered');
  });

  it('names the devices, for highlighting them on the diagram', () => {
    const out = tracePath({ devices: [edge, core], from: 'EDGE', to: '10.40.50.9' });
    expect(devicesOnPath(out).sort()).toEqual(['CORE', 'EDGE']);
  });
});

describe('ECMP', () => {
  const a = dev(
    'A',
    ['10.0.0.1'],
    [
      route({ prefix: '10.9.0.0/16', protocol: 'ospf', nextHops: ['10.0.1.2', '10.0.2.2'], distance: 110, metric: 2 }),
      route({ prefix: '10.0.1.0/30', protocol: 'connected', interface: 'Gi0/1' }),
      route({ prefix: '10.0.2.0/30', protocol: 'connected', interface: 'Gi0/2' }),
    ],
  );
  const left = dev('LEFT', ['10.0.1.2'], [route({ prefix: '10.9.0.0/16', protocol: 'connected', interface: 'Vlan9' })]);
  const right = dev('RIGHT', ['10.0.2.2'], [route({ prefix: '10.9.0.0/16', protocol: 'connected', interface: 'Vlan9' })]);

  it('follows every equal-cost next hop rather than picking one', () => {
    const out = tracePath({ devices: [a, left, right], from: 'A', to: '10.9.0.9' });
    expect(out.kind).toBe('delivered');
    expect(out.paths).toHaveLength(2);
    expect(out.paths.map((p) => p[1]!.device).sort()).toEqual(['LEFT', 'RIGHT']);
  });

  it('says so in the explanation for each branch', () => {
    const out = tracePath({ devices: [a, left, right], from: 'A', to: '10.9.0.9' });
    expect(out.paths[0]![0]!.why).toMatch(/One of 2 equal-cost next hops/);
  });
});

describe('VRF isolation', () => {
  const only = dev('R1', ['10.0.0.1'], [route({ prefix: '10.9.0.0/16', protocol: 'connected', interface: 'Vlan9' })]);

  it('answers for the default table under any of its names', () => {
    for (const vrf of [undefined, '', 'default', 'global', 'MAIN']) {
      expect(tracePath({ devices: [only], from: 'R1', to: '10.9.0.9', vrf }).kind).toBe('delivered');
    }
  });

  it('refuses to answer for a VRF nothing holds a table for', () => {
    // Falling back to the global table would be confidently wrong, which is
    // the worst kind (D-050).
    const out = tracePath({ devices: [only], from: 'R1', to: '10.9.0.9', vrf: 'CUSTOMER-A' });
    expect(out.kind).toBe('insufficient');
    expect(out.paths).toEqual([]);
    if (out.kind === 'insufficient') {
      expect(out.reason).toMatch(/holds no routing table for VRF|no device in this data holds a routing table/i);
      expect(out.reason).toMatch(/CUSTOMER-A/);
      expect(out.reason).toMatch(/does not fall back|falls back/i);
    }
  });

  it('routes a VRF from that VRF\u2019s own table, not the global one', () => {
    // The same destination, two answers. A VRF that reaches it and a global
    // table that does not is exactly the isolation a VRF exists to provide.
    const r1: PathDevice = {
      hostname: 'PE1',
      addresses: [{ ip: '10.0.0.1' }],
      routes: [route({ prefix: '10.0.0.0/24', protocol: 'connected', interface: 'Gi0/0' })],
      vrfRoutes: {
        'CUSTOMER-A': [route({ prefix: '10.9.0.0/16', protocol: 'connected', interface: 'Gi0/1.100' })],
      },
    };
    expect(tracePath({ devices: [r1], from: 'PE1', to: '10.9.0.9', vrf: 'CUSTOMER-A' }).kind).toBe('delivered');
    // And the global table still cannot reach it.
    expect(tracePath({ devices: [r1], from: 'PE1', to: '10.9.0.9' }).kind).toBe('unreachable');
  });

  it('keeps two VRFs apart on the same device', () => {
    const pe: PathDevice = {
      hostname: 'PE1',
      addresses: [{ ip: '10.0.0.1' }],
      routes: [],
      vrfRoutes: {
        RED: [route({ prefix: '10.9.0.0/16', protocol: 'connected', interface: 'Gi0/1.10' })],
        BLUE: [route({ prefix: '172.16.0.0/16', protocol: 'connected', interface: 'Gi0/1.20' })],
      },
    };
    expect(tracePath({ devices: [pe], from: 'PE1', to: '10.9.0.9', vrf: 'RED' }).kind).toBe('delivered');
    // RED's prefix is invisible from BLUE, which is the point of a VRF.
    expect(tracePath({ devices: [pe], from: 'PE1', to: '10.9.0.9', vrf: 'BLUE' }).kind).toBe('unreachable');
  });
});

describe('when it cannot get there', () => {
  it('says which device would drop it, and why', () => {
    const r1 = dev('R1', ['10.0.0.1'], [route({ prefix: '10.0.0.0/24', protocol: 'connected', interface: 'Gi0/1' })]);
    const out = tracePath({ devices: [r1], from: 'R1', to: '198.51.100.7' });
    expect(out.kind).toBe('unreachable');
    if (out.kind === 'unreachable') {
      expect(out.at).toBe('R1');
      expect(out.reason).toMatch(/no route to 198\.51\.100\.7, not even a default/);
    }
  });

  it('stops at a next hop that belongs to nothing crawled, rather than guessing', () => {
    const r1 = dev(
      'R1',
      ['10.0.0.1'],
      [
        route({ prefix: '0.0.0.0/0', protocol: 'static', nextHops: ['10.0.0.254'] }),
        route({ prefix: '10.0.0.0/24', protocol: 'connected', interface: 'Gi0/1' }),
      ],
    );
    const out = tracePath({ devices: [r1], from: 'R1', to: '198.51.100.7' });
    expect(out.kind).toBe('unreachable');
    if (out.kind === 'unreachable') expect(out.reason).toMatch(/no crawled device holds that address/);
    // The hop it did work out is still shown — it is real.
    expect(out.paths[0]).toHaveLength(1);
    expect(out.paths[0]![0]!.nextHop).toBe('10.0.0.254');
  });

  it('calls a circle a loop rather than following it for ever', () => {
    const a = dev('A', ['10.0.0.1'], [route({ prefix: '10.9.0.0/16', protocol: 'static', nextHops: ['10.0.0.2'], interface: 'Gi0/1' })], []);
    const b = dev('B', ['10.0.0.2'], [route({ prefix: '10.9.0.0/16', protocol: 'static', nextHops: ['10.0.0.1'], interface: 'Gi0/1' })], []);
    const out = tracePath({ devices: [a, b], from: 'A', to: '10.9.0.9' });
    expect(out.kind).toBe('loop');
  });
});

describe('missing routing data', () => {
  it('stops at a device whose routing table was never collected', () => {
    const r1 = dev(
      'R1',
      ['10.0.0.1'],
      [
        route({ prefix: '10.9.0.0/16', protocol: 'static', nextHops: ['10.0.0.2'] }),
        route({ prefix: '10.0.0.0/24', protocol: 'connected', interface: 'Gi0/1' }),
      ],
    );
    // Crawled, but without "Routing table" ticked: routes is undefined, which
    // is not the same as an empty table.
    const r2 = dev('R2', ['10.0.0.2'], undefined);
    const out = tracePath({ devices: [r1, r2], from: 'R1', to: '10.9.0.9' });
    expect(out.kind).toBe('unreachable');
    if (out.kind === 'unreachable') {
      expect(out.at).toBe('R2');
      expect(out.reason).toMatch(/routing table was not collected/);
    }
  });

  it('will not start from a device this project has never crawled', () => {
    const out = tracePath({ devices: [], from: 'GHOST', to: '10.9.0.9' });
    expect(out.kind).toBe('insufficient');
    if (out.kind === 'insufficient') expect(out.reason).toMatch(/not a device this project has crawled/);
  });

  it('refuses a destination that is not an address', () => {
    const r1 = dev('R1', ['10.0.0.1'], []);
    const out = tracePath({ devices: [r1], from: 'R1', to: 'www.example.com' });
    expect(out.kind).toBe('insufficient');
    if (out.kind === 'insufficient') expect(out.reason).toMatch(/not an IPv4 address/);
  });
});

describe('simulating a failure', () => {
  // Two ways to 10.9.0.0/16: through LEFT normally, through RIGHT at a worse
  // metric. Nothing on any device is changed — this filters the graph we hold.
  const a = dev(
    'A',
    ['10.0.0.1'],
    [
      route({ prefix: '10.9.0.0/16', protocol: 'ospf', nextHops: ['10.0.1.2'], distance: 110, metric: 2 }),
      route({ prefix: '10.9.0.0/16', protocol: 'ospf', nextHops: ['10.0.2.2'], distance: 110, metric: 9 }),
      route({ prefix: '10.0.1.0/30', protocol: 'connected', interface: 'Gi0/1' }),
      route({ prefix: '10.0.2.0/30', protocol: 'connected', interface: 'Gi0/2' }),
    ],
  );
  const left = dev('LEFT', ['10.0.1.2'], [route({ prefix: '10.9.0.0/16', protocol: 'connected', interface: 'Vlan9' })]);
  const right = dev('RIGHT', ['10.0.2.2'], [route({ prefix: '10.9.0.0/16', protocol: 'connected', interface: 'Vlan9' })]);
  const all = [a, left, right];

  it('normally takes the better metric', () => {
    const out = tracePath({ devices: all, from: 'A', to: '10.9.0.9' });
    expect(out.paths[0]![1]!.device).toBe('LEFT');
  });

  it('takes the alternate path when the preferred device is taken out', () => {
    const out = tracePath({ devices: all, from: 'A', to: '10.9.0.9', without: { devices: ['LEFT'] } });
    expect(out.kind).toBe('delivered');
    expect(out.paths[0]![1]!.device).toBe('RIGHT');
  });

  it('says the alternate is the table\u2019s second choice, not what it is doing now', () => {
    // The distinction matters: this is what A's own table already holds, not
    // a reconvergence we have imagined on its behalf.
    const out = tracePath({ devices: all, from: 'A', to: '10.9.0.9', without: { devices: ['LEFT'] } });
    expect(out.paths[0]![0]!.why).toMatch(/preferred route's next hop is on a device this simulation removed/);
    expect(out.paths[0]![0]!.why).toMatch(/already in A's table/);
  });

  it('does not reach for an alternate when nothing has been removed', () => {
    const out = tracePath({ devices: all, from: 'A', to: '10.9.0.9' });
    expect(out.paths[0]![0]!.why).not.toMatch(/simulation removed/);
  });

  it('reports unreachable when the only way through is removed', () => {
    const out = tracePath({ devices: all, from: 'A', to: '10.9.0.9', without: { devices: ['LEFT', 'RIGHT'] } });
    expect(out.kind).toBe('unreachable');
  });

  it('changes nothing about the devices it was given', () => {
    const before = JSON.stringify(all);
    tracePath({ devices: all, from: 'A', to: '10.9.0.9', without: { devices: ['LEFT'] } });
    expect(JSON.stringify(all)).toBe(before);
  });
});


describe('NAT, load balancers and VIPs (LT-348)', () => {
  const fw: PathDevice = {
    hostname: 'FW-01',
    addresses: [{ ip: '203.0.113.1' }],
    routes: [route({ prefix: '10.20.0.0/16', protocol: 'static', nextHops: ['10.20.0.2'], interface: 'Gi0/1' })],
    nat: [{ kind: 'destination', matches: '203.0.113.50', becomes: '10.20.0.50', port: 443, description: 'Customer Portal' }],
    neighbours: [{ localInterface: 'Gi0/1', name: 'LB-01' }],
  };
  const lb: PathDevice = {
    hostname: 'LB-01',
    addresses: [{ ip: '10.20.0.2' }],
    routes: [route({ prefix: '10.20.0.0/16', protocol: 'connected', interface: 'Vlan20' })],
    vips: [{ address: '10.20.0.50', port: 443, members: ['10.20.0.11', '10.20.0.12'], description: 'Portal pool' }],
  };
  const web1: PathDevice = { hostname: 'WEB-01', addresses: [{ ip: '10.20.0.11' }], routes: [] };
  const web2: PathDevice = { hostname: 'WEB-02', addresses: [{ ip: '10.20.0.12' }], routes: [] };
  const all = [fw, lb, web1, web2];

  it('translates on arrival and routes the new address afterwards', () => {
    const out = tracePath({ devices: all, from: 'FW-01', to: '203.0.113.50', port: 443 });
    expect(out.kind).toBe('delivered');
    const nat = out.paths[0]!.find((h) => h.segment?.kind === 'nat');
    expect(nat?.segment).toMatchObject({ kind: 'nat', was: '203.0.113.50', now: '10.20.0.50' });
    expect(nat?.why).toMatch(/Everything after this is routed for 10\.20\.0\.50/);
  });

  it('leaves the packet alone when the rule is for another port', () => {
    const out = tracePath({ devices: all, from: 'FW-01', to: '203.0.113.50', port: 80 });
    expect(out.kind).toBe('unreachable');
  });

  it('follows every member behind a VIP, because any of them may serve it', () => {
    const out = tracePath({ devices: all, from: 'FW-01', to: '203.0.113.50', port: 443 });
    expect(out.paths).toHaveLength(2);
    const chosen = out.paths.map((p) => p.find((h) => h.segment?.kind === 'vip')!.segment!);
    expect(chosen.map((c) => (c.kind === 'vip' ? c.member : '')).sort()).toEqual(['10.20.0.11', '10.20.0.12']);
  });

  it('says which pool member each path took', () => {
    const out = tracePath({ devices: all, from: 'FW-01', to: '203.0.113.50', port: 443 });
    expect(out.paths[0]!.find((h) => h.protocol === 'load-balancer')!.why).toMatch(/one of 2 members in the pool/);
  });
});

describe('VXLAN overlay and underlay (LT-348)', () => {
  // Two leaves carrying VNI 10100, two spines between them. The destination
  // lives on the far leaf's segment.
  const leaf1: PathDevice = {
    hostname: 'LEAF-01',
    addresses: [{ ip: '10.255.0.1' }, { ip: '10.0.1.1' }, { ip: '10.0.2.1' }],
    vtep: { address: '10.255.0.1', segments: [{ vni: 10100, vlan: 100, prefix: '10.100.0.0/24' }] },
    routes: [
      route({ prefix: '10.255.0.4/32', protocol: 'bgp', nextHops: ['10.0.1.2', '10.0.2.2'], distance: 20 }),
      route({ prefix: '10.0.1.0/30', protocol: 'connected', interface: 'Eth1/1' }),
      route({ prefix: '10.0.2.0/30', protocol: 'connected', interface: 'Eth1/2' }),
    ],
  };
  const spine1: PathDevice = {
    hostname: 'SPINE-01',
    addresses: [{ ip: '10.0.1.2' }],
    routes: [route({ prefix: '10.255.0.4/32', protocol: 'bgp', nextHops: ['10.0.3.2'], distance: 20 }), route({ prefix: '10.0.3.0/30', protocol: 'connected', interface: 'Eth1/4' })],
    neighbours: [{ localInterface: 'Eth1/4', name: 'LEAF-04' }],
  };
  const spine2: PathDevice = {
    hostname: 'SPINE-02',
    addresses: [{ ip: '10.0.2.2' }],
    routes: [route({ prefix: '10.255.0.4/32', protocol: 'bgp', nextHops: ['10.0.4.2'], distance: 20 }), route({ prefix: '10.0.4.0/30', protocol: 'connected', interface: 'Eth1/4' })],
    neighbours: [{ localInterface: 'Eth1/4', name: 'LEAF-04' }],
  };
  const leaf4: PathDevice = {
    hostname: 'LEAF-04',
    addresses: [{ ip: '10.255.0.4' }, { ip: '10.0.3.2' }, { ip: '10.0.4.2' }],
    vtep: { address: '10.255.0.4', segments: [{ vni: 10100, vlan: 100, prefix: '10.100.0.0/24' }] },
    routes: [route({ prefix: '10.100.0.0/24', protocol: 'connected', interface: 'Vlan100' })],
  };
  const fabric = [leaf1, spine1, spine2, leaf4];

  it('bridges across the overlay rather than calling it an L3 hop', () => {
    const out = tracePath({ devices: fabric, from: 'LEAF-01', to: '10.100.0.20' });
    expect(out.kind).toBe('delivered');
    const overlay = out.paths[0]!.find((h) => h.segment?.kind === 'overlay')!;
    expect(overlay.protocol).toBe('vxlan');
    expect(overlay.segment).toMatchObject({ kind: 'overlay', vni: 10100, vlan: 100, localVtep: '10.255.0.1', remoteVtep: '10.255.0.4', remote: 'LEAF-04' });
    expect(overlay.why).toMatch(/bridged across the overlay/);
  });

  it('shows the underlay that carries the tunnel, hop by hop', () => {
    const out = tracePath({ devices: fabric, from: 'LEAF-01', to: '10.100.0.20' });
    const underlay = out.paths[0]!.filter((h) => h.segment?.kind === 'underlay');
    expect(underlay.length).toBeGreaterThan(0);
    // It goes VTEP to VTEP through a spine, which is the whole point of
    // showing it: the overlay hop alone hides those devices entirely.
    expect(underlay.map((h) => h.device)).toContain('LEAF-01');
    expect(underlay.some((h) => h.device.startsWith('SPINE'))).toBe(true);
    expect(underlay[0]!.why).toMatch(/^Underlay for VNI 10100/);
  });

  it('takes the packet back out of the overlay at the far end', () => {
    const out = tracePath({ devices: fabric, from: 'LEAF-01', to: '10.100.0.20' });
    const last = out.paths[0]![out.paths[0]!.length - 1]!;
    expect(last.segment).toMatchObject({ kind: 'decapsulate', vni: 10100 });
    expect(last.device).toBe('LEAF-04');
  });

  it('reports the overlay as unresolved when the underlay cannot be followed', () => {
    // A fabric with the spines taken away: the VNI is still shared, but there
    // is no way to carry the tunnel, and saying "delivered" would be a lie.
    const out = tracePath({ devices: [leaf1, leaf4], from: 'LEAF-01', to: '10.100.0.20' });
    expect(out.kind).toBe('unreachable');
    if (out.kind === 'unreachable') expect(out.reason).toMatch(/overlay between 10\.255\.0\.1 and 10\.255\.0\.4 could not be followed/);
  });

  it('does not invent a segment for an address no remote VTEP carries', () => {
    const out = tracePath({ devices: fabric, from: 'LEAF-01', to: '198.51.100.7' });
    expect(out.paths[0]?.some((h) => h.segment?.kind === 'overlay') ?? false).toBe(false);
  });
});

describe('BGP attributes, where the device reported them', () => {
  it('carries local preference, AS path and MED onto the hop', () => {
    const r1: PathDevice = {
      hostname: 'EDGE',
      addresses: [{ ip: '10.0.0.1' }],
      routes: [
        route({
          prefix: '10.40.0.0/16', protocol: 'bgp', nextHops: ['10.0.0.2'], interface: 'Gi0/0', distance: 20,
          bgp: { localPreference: 200, asPath: '65001 65010', med: 50, communities: ['65001:100'] },
        }),
      ],
    };
    const r2: PathDevice = { hostname: 'CORE', addresses: [{ ip: '10.0.0.2' }], routes: [route({ prefix: '10.40.0.0/16', protocol: 'connected', interface: 'Vlan40' })] };
    const out = tracePath({ devices: [r1, r2], from: 'EDGE', to: '10.40.0.9' });
    expect(out.paths[0]![0]!.bgp).toEqual({ localPreference: 200, asPath: '65001 65010', med: 50, communities: ['65001:100'] });
  });
});

describe('a route the device says crosses the overlay (LT-347)', () => {
  // A tenant VRF on two leaves, joined by an L3 VNI. This is the shape a
  // Nexus leaf printed on 2026-09-20: the tenant route points at a VTEP,
  // says the VTEP address is resolved in the global table, and says which
  // segment carries it.
  //
  // Nothing here is visible to `segmentFor`: an L3 VNI carries a VRF, not a
  // VLAN, so neither leaf has a segment prefix for the destination to fall
  // inside. The route is the only evidence there is.
  const leafA: PathDevice = {
    hostname: 'LEAF-A',
    addresses: [{ ip: '198.51.100.1' }, { ip: '192.0.2.1' }],
    vtep: { address: '198.51.100.1', segments: [{ vni: 50000 }] },
    routes: [
      route({ prefix: '198.51.100.4/32', protocol: 'ospf', nextHops: ['192.0.2.2'], distance: 110 }),
      route({ prefix: '192.0.2.0/30', protocol: 'connected', interface: 'Eth1/1' }),
    ],
    vrfRoutes: {
      CORP: [
        route({
          prefix: '203.0.113.0/24',
          protocol: 'bgp',
          nextHops: ['198.51.100.4'],
          distance: 200,
          metric: 2000,
          nextHopVrf: 'default',
          segmentId: 50000,
        }),
      ],
    },
  };
  const spine: PathDevice = {
    hostname: 'SPINE-A',
    addresses: [{ ip: '192.0.2.2' }, { ip: '192.0.2.5' }],
    routes: [
      route({ prefix: '198.51.100.4/32', protocol: 'ospf', nextHops: ['192.0.2.6'], distance: 110 }),
      route({ prefix: '192.0.2.4/30', protocol: 'connected', interface: 'Eth1/2' }),
    ],
    neighbours: [{ localInterface: 'Eth1/2', name: 'LEAF-B' }],
  };
  const leafB: PathDevice = {
    hostname: 'LEAF-B',
    addresses: [{ ip: '198.51.100.4' }, { ip: '192.0.2.6' }],
    vtep: { address: '198.51.100.4', segments: [{ vni: 50000 }] },
    routes: [route({ prefix: '192.0.2.4/30', protocol: 'connected', interface: 'Eth1/2' })],
    vrfRoutes: {
      CORP: [route({ prefix: '203.0.113.0/24', protocol: 'connected', interface: 'Vlan113' })],
    },
  };
  const fabric = [leafA, spine, leafB];

  it('resolves a next hop in the table the device said it lives in', () => {
    // Without this, `198.51.100.4` is looked up in VRF CORP — which does not
    // hold it — and a path the device is perfectly happy with is reported as
    // unresolvable.
    const result = tracePath({ devices: fabric, from: 'LEAF-A', to: '203.0.113.9', vrf: 'CORP' });
    expect(result.kind).toBe('delivered');
  });

  it('draws it as a tunnel, with the underlay kept as its own hops', () => {
    const result = tracePath({ devices: fabric, from: 'LEAF-A', to: '203.0.113.9', vrf: 'CORP' });
    const kinds = result.paths[0]!.map((h) => h.segment?.kind ?? 'routed');
    expect(kinds).toContain('overlay');
    expect(kinds).toContain('underlay');
    expect(kinds).toContain('decapsulate');
    // The spine is on the path, as an underlay hop — a fabric drawn without
    // its spines is not the network.
    const underlay = result.paths[0]!.filter((h) => h.segment?.kind === 'underlay');
    expect(underlay.map((h) => h.device)).toContain('LEAF-A');
  });

  it('says why, in the device own words', () => {
    const result = tracePath({ devices: fabric, from: 'LEAF-A', to: '203.0.113.9', vrf: 'CORP' });
    const overlay = result.paths[0]!.find((h) => h.segment?.kind === 'overlay')!;
    expect(overlay.why).toContain('VNI 50000');
    expect(overlay.why).toContain('198.51.100.4');
    expect(overlay.why).toContain('global table');
  });

  it('keeps the VRF on every hop it made the decision in', () => {
    const result = tracePath({ devices: fabric, from: 'LEAF-A', to: '203.0.113.9', vrf: 'CORP' });
    const overlay = result.paths[0]!.find((h) => h.segment?.kind === 'overlay')!;
    expect(overlay.vrf).toBe('CORP');
  });

  it('will not invent a far end for a VTEP nothing crawled holds', () => {
    // The route says the overlay goes to a VTEP. If no crawled device holds
    // that address, the honest answer is that the path stops, not a guess.
    const alone = [
      { ...leafA, routes: leafA.routes!.filter((r) => r.protocol === 'connected') },
    ];
    const result = tracePath({ devices: alone, from: 'LEAF-A', to: '203.0.113.9', vrf: 'CORP' });
    expect(result.kind).not.toBe('delivered');
  });
});
