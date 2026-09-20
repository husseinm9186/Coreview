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

  it('refuses to answer for a named VRF from the global table', () => {
    // Discovery collects the global table only. Using it to answer a VRF
    // question would be confidently wrong, which is the worst kind (D-050).
    const out = tracePath({ devices: [only], from: 'R1', to: '10.9.0.9', vrf: 'CUSTOMER-A' });
    expect(out.kind).toBe('insufficient');
    expect(out.paths).toEqual([]);
    if (out.kind === 'insufficient') {
      expect(out.reason).toMatch(/global table only/);
      expect(out.reason).toMatch(/CUSTOMER-A/);
    }
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
