import { describe, expect, it } from 'vitest';

import { buildIpam, containerTree, type IpamState } from './ipam';
import {
  allocationProblems,
  freeBlocks,
  halfOf,
  nextFreeBlock,
  planMerge,
  planSplit,
  splitProblem,
} from './ipamPlan';
import type { TopoNode } from '../state/store';

/** Documentation addresses only — nothing from anyone's network (D-027). */
const device = (id: string, label: string, address: string, extra = {}): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x: 0, y: 0 },
    data: {
      label,
      deviceType: 'access-switch',
      tags: [],
      addresses: [{ id: `${id}-a`, label: 'Management', address, isPrimary: true }],
      ...extra,
    },
  }) as unknown as TopoNode;

const blockOf = (state: IpamState, cidr: string, nodes: TopoNode[] = []) =>
  buildIpam(nodes, state).blocks.find((b) => b.cidr === cidr)!;

describe('splitting a subnet (LT-297)', () => {
  const state: IpamState = {
    subnets: [{ id: 's1', cidr: '192.0.2.0/24', name: 'Office' }],
    ranges: [{ id: 'r1', from: '192.0.2.10', to: '192.0.2.20', kind: 'dhcp', name: 'Staff' }],
    entries: [{ id: 'e1', address: '192.0.2.200', label: 'Printer', kind: 'in-use' }],
  };

  it('refuses a prefix that is not smaller, or is absurd', () => {
    const b = blockOf(state, '192.0.2.0/24');
    expect(splitProblem(b, 24)).toMatch(/not smaller/);
    expect(splitProblem(b, 23)).toMatch(/not smaller/);
    expect(splitProblem(b, 33)).toMatch(/longest prefix/);
    expect(splitProblem(b, 24.5)).toMatch(/prefix length/);
    // 2^9 children is a list nobody reads.
    expect(splitProblem({ prefix: 8 }, 17)).toMatch(/smaller steps/);
    expect(splitProblem(b, 26)).toBeNull();
  });

  it('says which child each address and range lands in', () => {
    const plan = planSplit(blockOf(state, '192.0.2.0/24', [device('a', 'Core', '192.0.2.5')]), 26);
    expect(plan.problem).toBeNull();
    expect(plan.children.map((c) => c.cidr)).toEqual([
      '192.0.2.0/26', '192.0.2.64/26', '192.0.2.128/26', '192.0.2.192/26',
    ]);
    expect(plan.children[0]!.firstUsable).toBe('192.0.2.1');
    expect(plan.children[0]!.lastUsable).toBe('192.0.2.62');
    expect(plan.children[0]!.addresses.map((a) => a.address)).toEqual(['192.0.2.5']);
    expect(plan.children[0]!.ranges.map((r) => r.id)).toEqual(['r1']);
    expect(plan.children[3]!.addresses.map((a) => a.address)).toEqual(['192.0.2.200']);
  });

  it('will not quietly cut a range in half', () => {
    const straddles: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
      ranges: [{ id: 'r1', from: '192.0.2.50', to: '192.0.2.80', kind: 'dhcp', name: 'Staff' }],
    };
    const plan = planSplit(blockOf(straddles, '192.0.2.0/24'), 26);
    expect(plan.straddling).toHaveLength(1);
    expect(plan.straddling[0]!.across).toEqual(['192.0.2.0/26', '192.0.2.64/26']);
    // And it is not counted inside either child.
    expect(plan.children.flatMap((c) => c.ranges)).toHaveLength(0);
  });

  it('handles a /31, where both addresses are usable', () => {
    const tiny: IpamState = { subnets: [{ id: 's1', cidr: '192.0.2.0/30' }] };
    const plan = planSplit(blockOf(tiny, '192.0.2.0/30'), 31);
    expect(plan.children.map((c) => [c.firstUsable, c.lastUsable])).toEqual([
      ['192.0.2.0', '192.0.2.1'],
      ['192.0.2.2', '192.0.2.3'],
    ]);
  });
});

describe('merging two subnets (LT-297)', () => {
  const two: IpamState = {
    subnets: [
      { id: 's1', cidr: '192.0.2.0/25' },
      { id: 's2', cidr: '192.0.2.128/25' },
      { id: 's3', cidr: '198.51.100.0/25' },
      { id: 's4', cidr: '192.0.2.0/24' },
    ],
  };

  it('merges two halves of one block', () => {
    const plan = planMerge(blockOf(two, '192.0.2.0/25'), blockOf(two, '192.0.2.128/25'));
    expect(plan.problem).toBeNull();
    expect(plan.cidr).toBe('192.0.2.0/24');
    expect(plan.parts).toEqual(['192.0.2.0/25', '192.0.2.128/25']);
  });

  it('refuses two that are not halves of the same block', () => {
    const odd: IpamState = {
      subnets: [{ id: 'a', cidr: '192.0.2.128/25' }, { id: 'b', cidr: '192.0.3.0/25' }],
    };
    const plan = planMerge(blockOf(odd, '192.0.2.128/25'), blockOf(odd, '192.0.3.0/25'));
    // Adjacent, and merging them would take in space that is not theirs.
    expect(plan.problem).toMatch(/halves of one/);
  });

  it('refuses different sizes, different routing tables and the same subnet twice', () => {
    expect(planMerge(blockOf(two, '192.0.2.0/25'), blockOf(two, '192.0.2.0/24')).problem)
      .toMatch(/same size/);
    expect(planMerge(blockOf(two, '192.0.2.0/25'), blockOf(two, '198.51.100.0/25')).problem)
      .toMatch(/not next to each other/);
    expect(planMerge(blockOf(two, '192.0.2.0/25'), blockOf(two, '192.0.2.0/25')).problem)
      .toMatch(/same subnet/);

    const split: IpamState = {
      vrfs: [{ id: 'lab', name: 'Lab' }],
      subnets: [
        { id: 'a', cidr: '192.0.2.0/25' },
        { id: 'b', cidr: '192.0.2.128/25', vrfId: 'lab' },
      ],
    };
    const model = buildIpam([], split);
    const a = model.blocks.find((b) => b.cidr === '192.0.2.0/25')!;
    const b = model.blocks.find((x) => x.cidr === '192.0.2.128/25')!;
    expect(planMerge(a, b).problem).toMatch(/different routing tables/);
  });

  it('carries everything inside both halves over', () => {
    const full: IpamState = {
      subnets: [{ id: 's1', cidr: '192.0.2.0/25' }, { id: 's2', cidr: '192.0.2.128/25' }],
      entries: [
        { id: 'e1', address: '192.0.2.5', label: 'A', kind: 'in-use' },
        { id: 'e2', address: '192.0.2.200', label: 'B', kind: 'reserved' },
      ],
    };
    const plan = planMerge(blockOf(full, '192.0.2.0/25'), blockOf(full, '192.0.2.128/25'));
    expect(plan.addresses).toBe(2);
  });

  it('knows what half of a prefix is', () => {
    expect(halfOf('192.0.2.0/24')).toBe(25);
    expect(halfOf('192.0.2.0/32')).toBeNull();
    expect(halfOf('nonsense')).toBeNull();
  });
});

describe('space inside a container (LT-297)', () => {
  const state: IpamState = {
    containers: [
      { id: 'c1', name: 'All', cidr: '10.0.0.0/8' },
      { id: 'c2', name: 'Texas', cidr: '10.20.0.0/16' },
    ],
    subnets: [{ id: 's1', cidr: '10.20.0.0/24', name: 'Office' }],
  };

  const texas = () => containerTree(state, buildIpam([], state).blocks)[0]!.children[0]!;

  it('nests containers by what contains what, not by what claims what', () => {
    const roots = containerTree(state, buildIpam([], state).blocks);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.cidr).toBe('10.0.0.0/8');
    expect(roots[0]!.children.map((c) => c.cidr)).toEqual(['10.20.0.0/16']);
    // The subnet sits under the most specific container that holds it.
    expect(texas().subnets.map((b) => b.cidr)).toEqual(['10.20.0.0/24']);
    expect(roots[0]!.subnets).toEqual([]);
  });

  it('separates space given out from addresses used', () => {
    const t = texas();
    expect(t.capacity).toBe(65536);
    // One /24 has been allocated out of it, and nothing is on it.
    expect(t.allocated).toBe(256);
    expect(t.freeSpace).toBe(65280);
    expect(t.used).toBe(0);
    expect(t.usable).toBe(254);
  });

  it('finds the lowest free block of the size asked for', () => {
    expect(nextFreeBlock(texas(), 24)?.cidr).toBe('10.20.1.0/24');
    expect(nextFreeBlock(texas(), 26)?.cidr).toBe('10.20.1.0/26');
    // Not smaller than the container, and not longer than /32.
    expect(nextFreeBlock(texas(), 16)).toBeNull();
    expect(nextFreeBlock(texas(), 33)).toBeNull();
  });

  it('offers a few to choose from, not just the first', () => {
    expect(freeBlocks(texas(), 24, 3).map((b) => b.cidr))
      .toEqual(['10.20.1.0/24', '10.20.2.0/24', '10.20.3.0/24']);
  });

  it('gives nothing when the container is full', () => {
    const full: IpamState = {
      containers: [{ id: 'c1', name: 'Small', cidr: '192.0.2.0/24' }],
      subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
    };
    const c = containerTree(full, buildIpam([], full).blocks)[0]!;
    expect(nextFreeBlock(c, 26)).toBeNull();
    expect(freeBlocks(c, 26)).toEqual([]);
  });
});

describe('what stops an address being allocated (LT-297)', () => {
  const state: IpamState = {
    subnets: [{ id: 's1', cidr: '192.0.2.0/24' }, { id: 's2', cidr: '198.51.100.0/24' }],
    ranges: [{ id: 'r1', from: '192.0.2.100', to: '192.0.2.120', kind: 'dhcp', name: 'Staff' }],
    entries: [
      { id: 'e1', address: '192.0.2.9', label: 'Badge reader', kind: 'in-use', mac: '00:00:5e:00:53:23' },
      { id: 'e2', address: '198.51.100.9', label: 'Old badge reader', kind: 'in-use', mac: '00:00:5E:00:53:99' },
    ],
  };
  const model = () => buildIpam([], state);
  const block = () => model().blocks.find((b) => b.cidr === '192.0.2.0/24')!;

  it('passes a plain free address', () => {
    expect(allocationProblems(model().blocks, block(), '192.0.2.50')).toEqual([]);
  });

  it('refuses the network and broadcast addresses', () => {
    expect(allocationProblems(model().blocks, block(), '192.0.2.0')[0]).toMatch(/network address/);
    expect(allocationProblems(model().blocks, block(), '192.0.2.255')[0]).toMatch(/broadcast/);
  });

  it('refuses an address outside the subnet, and nonsense', () => {
    expect(allocationProblems(model().blocks, block(), '198.51.100.5')[0]).toMatch(/not inside/);
    expect(allocationProblems(model().blocks, block(), 'no')[0]).toMatch(/not an IPv4/);
  });

  it('says when it is taken, and by what', () => {
    expect(allocationProblems(model().blocks, block(), '192.0.2.9')[0]).toMatch(/already in use — Badge reader/);
  });

  it('says when it is inside a pool a server hands out', () => {
    expect(allocationProblems(model().blocks, block(), '192.0.2.110')[0]).toMatch(/DHCP pool Staff/);
  });

  it('finds the same MAC somewhere else entirely, whatever its case', () => {
    const said = allocationProblems(model().blocks, block(), '192.0.2.50', '00:00:5e:00:53:99');
    expect(said[0]).toMatch(/already on 198\.51\.100\.9 in 198\.51\.100\.0\/24/);
  });
});

describe('the same address in two routing tables (LT-297)', () => {
  const state: IpamState = {
    vrfs: [{ id: 'lab', name: 'Lab' }],
    subnets: [
      { id: 's1', cidr: '192.0.2.0/24', name: 'Office' },
      { id: 's2', cidr: '192.0.2.0/24', name: 'Test bench', vrfId: 'lab' },
    ],
    entries: [
      { id: 'e1', address: '192.0.2.5', label: 'Printer', kind: 'in-use' },
      { id: 'e2', address: '192.0.2.5', label: 'Lab switch', kind: 'in-use', vrfId: 'lab' },
    ],
  };

  it('keeps them apart, and calls neither a conflict', () => {
    const model = buildIpam([], state);
    expect(model.blocks).toHaveLength(2);
    const office = model.blocks.find((b) => b.vrfId === 'global')!;
    const lab = model.blocks.find((b) => b.vrfId === 'lab')!;
    expect(office.addresses.map((a) => a.label)).toEqual(['Printer']);
    expect(lab.addresses.map((a) => a.label)).toEqual(['Lab switch']);
    expect(model.conflicts).toEqual([]);
  });

  it('lists the default routing table first, whatever else there is', () => {
    expect(buildIpam([], state).vrfs.map((v) => v.id)).toEqual(['global', 'lab']);
  });

  it('flags two devices on one address, which is the fault that matters', () => {
    const model = buildIpam(
      [device('a', 'Core', '192.0.2.7'), device('b', 'Access', '192.0.2.7')],
      { subnets: [{ id: 's1', cidr: '192.0.2.0/24' }] },
    );
    expect(model.conflicts).toHaveLength(1);
    expect(model.conflicts[0]!.address).toBe('192.0.2.7');
    expect(model.conflicts[0]!.holders.map((h) => h.label).sort()).toEqual(['Access', 'Core']);
  });

  it('does not flag a record that documents a device it agrees with', () => {
    const model = buildIpam([device('a', 'Core', '192.0.2.7')], {
      subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
      entries: [{ id: 'e1', address: '192.0.2.7', label: 'Core switch', kind: 'in-use' }],
    });
    expect(model.conflicts).toEqual([]);
  });
});
