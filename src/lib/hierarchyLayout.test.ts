import { describe, expect, it } from 'vitest';

import type { DeviceType } from '../types/domain';
import {
  hierarchicalLayout,
  RANK_GAP,
  SIBLING_GAP,
  tiersFor,
  type HierarchyEdge,
  type HierarchyNode,
} from './hierarchyLayout';

const node = (id: string, deviceType: DeviceType, over: Partial<HierarchyNode> = {}): HierarchyNode => ({
  id, deviceType, width: 76, height: 76, ...over,
});
const edge = (source: string, target: string) => ({ source, target });

describe('tiersFor', () => {
  it('puts the internet above the edge, and the edge above the core', () => {
    const nodes = [node('net', 'internet'), node('fw', 'firewall'), node('core', 'core-switch'),
      node('acc', 'access-switch')];
    const t = tiersFor(nodes, [edge('net', 'fw'), edge('fw', 'core'), edge('core', 'acc')]);
    expect(t.get('net')).toBeLessThan(t.get('fw')!);
    expect(t.get('fw')).toBeLessThan(t.get('core')!);
    expect(t.get('core')).toBeLessThan(t.get('acc')!);
  });

  it('reads a device the type does not describe from what it plugs into', () => {
    // An imported shape, or anything left `generic`. The cabling is the only
    // thing that says where it belongs.
    const nodes = [node('core', 'core-switch'), node('mystery', 'generic')];
    const t = tiersFor(nodes, [edge('core', 'mystery')]);
    expect(t.get('mystery')).toBeGreaterThan(t.get('core')!);
  });

  it('resolves a chain of devices that none of the types describe', () => {
    const nodes = [node('core', 'core-switch'), node('a', 'generic'), node('b', 'generic')];
    const t = tiersFor(nodes, [edge('core', 'a'), edge('a', 'b')]);
    expect(t.get('a')).toBeGreaterThan(t.get('core')!);
    expect(t.get('b')).toBeGreaterThan(t.get('a')!);
  });

  it('sends an isolated unknown to the bottom rather than into the middle', () => {
    const nodes = [node('net', 'internet'), node('core', 'core-switch'), node('orphan', 'generic')];
    const t = tiersFor(nodes, [edge('net', 'core')]);
    expect(t.get('orphan')).toBeGreaterThan(t.get('core')!);
  });

  it('closes the gap a missing layer would leave', () => {
    // Internet straight to access switches, no firewall and no core. The
    // access switches belong directly under the internet, not four bands down
    // with empty space where the missing kit would have gone.
    const nodes = [node('net', 'internet'), node('a1', 'access-switch'), node('a2', 'access-switch')];
    const t = tiersFor(nodes, [edge('net', 'a1'), edge('net', 'a2')]);
    expect([...new Set(t.values())].sort()).toEqual([0, 1]);
  });
});

describe('a proven direction outranks the glyph', () => {
  const edgeWith = (source: string, target: string, direction: HierarchyEdge['direction']) => ({
    source,
    target,
    direction,
  });

  it('puts the way out above the device that forwards to it', () => {
    // Nothing here is typed: both are plain shapes, which is what a swept
    // host or an imported box actually is. The only evidence is that `acc`
    // sends traffic it has no other route for to `core`.
    const nodes = [node('acc', 'generic'), node('core', 'generic')];
    const tiers = tiersFor(nodes, [edgeWith('acc', 'core', 'forward')]);
    expect(tiers.get('core')!).toBeLessThan(tiers.get('acc')!);
  });

  it('reads a reverse direction the other way round', () => {
    const nodes = [node('a', 'generic'), node('b', 'generic')];
    const tiers = tiersFor(nodes, [edgeWith('a', 'b', 'reverse')]);
    expect(tiers.get('a')!).toBeLessThan(tiers.get('b')!);
  });

  it('beats the glyph where the two disagree', () => {
    // The heart of it. By type alone a core switch sits above an access
    // switch. But this "access switch" is the one the core forwards through
    // to reach the world — mislabelled, or a small site where the access
    // switch is the edge. The device's own routing is evidence; the glyph is
    // a guess, so the evidence wins.
    const nodes = [node('core', 'core-switch'), node('acc', 'access-switch')];
    const byTypeOnly = tiersFor(nodes, [{ source: 'core', target: 'acc' }]);
    expect(byTypeOnly.get('core')!).toBeLessThan(byTypeOnly.get('acc')!);

    const byEvidence = tiersFor(nodes, [edgeWith('core', 'acc', 'forward')]);
    expect(byEvidence.get('acc')!).toBeLessThan(byEvidence.get('core')!);
  });

  it('leaves an undirected link deciding nothing', () => {
    // Only a crawl that read a default route sets a direction. Everything
    // else must fall through to the rules that were already there.
    const nodes = [node('fw', 'firewall'), node('acc', 'access-switch')];
    const plain = tiersFor(nodes, [{ source: 'fw', target: 'acc' }]);
    const none = tiersFor(nodes, [edgeWith('fw', 'acc', 'none')]);
    const both = tiersFor(nodes, [edgeWith('fw', 'acc', 'both')]);
    expect(none).toEqual(plain);
    expect(both).toEqual(plain);
  });

  it('orders a whole path from the access layer out to the edge', () => {
    // host -> access -> distribution -> core -> firewall, each proven by its
    // own default route. This is the picture the layout exists to draw.
    const nodes = ['host', 'acc', 'dist', 'core', 'fw'].map((id) => node(id, 'generic'));
    const tiers = tiersFor(nodes, [
      edgeWith('host', 'acc', 'forward'),
      edgeWith('acc', 'dist', 'forward'),
      edgeWith('dist', 'core', 'forward'),
      edgeWith('core', 'fw', 'forward'),
    ]);
    const order = ['fw', 'core', 'dist', 'acc', 'host'].map((id) => tiers.get(id)!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(5);
  });

  it('cannot be spun by directions that contradict each other', () => {
    // A ring of default routes is not something real hardware produces, and
    // it must not hang the layout if it ever arrives.
    const nodes = ['a', 'b', 'c'].map((id) => node(id, 'generic'));
    const tiers = tiersFor(nodes, [
      edgeWith('a', 'b', 'forward'),
      edgeWith('b', 'c', 'forward'),
      edgeWith('c', 'a', 'forward'),
    ]);
    expect(tiers.size).toBe(3);
    for (const t of tiers.values()) expect(Number.isFinite(t)).toBe(true);
  });

  it('ignores a direction pointing at something not on the page', () => {
    const nodes = [node('a', 'generic')];
    const tiers = tiersFor(nodes, [edgeWith('a', 'gone', 'forward')]);
    expect(tiers.get('a')).toBe(0);
  });
});

describe('hierarchicalLayout', () => {
  const chain = () => ({
    nodes: [node('net', 'internet'), node('fw', 'firewall'), node('core', 'core-switch'),
      node('a1', 'access-switch'), node('a2', 'access-switch')],
    edges: [edge('net', 'fw'), edge('fw', 'core'), edge('core', 'a1'), edge('core', 'a2')],
  });

  it('runs the topology top to bottom, in flow order', () => {
    const { nodes, edges } = chain();
    const { moved } = hierarchicalLayout(nodes, edges);
    const y = (id: string) => moved.get(id)!.y;
    expect(y('net')).toBeLessThan(y('fw'));
    expect(y('fw')).toBeLessThan(y('core'));
    expect(y('core')).toBeLessThan(y('a1'));
    expect(y('a1')).toBe(y('a2'));
  });

  it('leaves no two devices on top of one another', () => {
    const { nodes, edges } = chain();
    const { moved } = hierarchicalLayout(nodes, edges);
    const seen = new Set<string>();
    for (const [, p] of moved) {
      expect(seen.has(`${p.x},${p.y}`)).toBe(false);
      seen.add(`${p.x},${p.y}`);
    }
    // And siblings are a whole node apart, not merely not-identical.
    expect(Math.abs(moved.get('a1')!.x - moved.get('a2')!.x)).toBeGreaterThanOrEqual(76);
  });

  it('centres each tier, so it reads as a tree rather than a left-aligned list', () => {
    const { nodes, edges } = chain();
    const { moved } = hierarchicalLayout(nodes, edges);
    const mid = (ids: string[]) => {
      const xs = ids.map((i) => moved.get(i)!.x + 38);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    expect(Math.abs(mid(['core']) - mid(['a1', 'a2']))).toBeLessThan(2);
  });

  it('puts a node under the neighbours it is joined to, to keep links from crossing', () => {
    // Two cores, two access switches each. Ordered badly, the links cross.
    const nodes = [
      node('c1', 'core-switch'), node('c2', 'core-switch'),
      node('a1', 'access-switch'), node('a2', 'access-switch'),
      node('b1', 'access-switch'), node('b2', 'access-switch'),
    ];
    // Declared interleaved on purpose, so only the ordering pass can fix it.
    const edges = [edge('c1', 'a1'), edge('c2', 'b1'), edge('c1', 'a2'), edge('c2', 'b2')];
    const { moved } = hierarchicalLayout(nodes, edges);
    const x = (id: string) => moved.get(id)!.x;
    const c1Kids = [x('a1'), x('a2')];
    const c2Kids = [x('b1'), x('b2')];
    // Everything under c1 sits to one side of everything under c2.
    expect(Math.max(...c1Kids)).toBeLessThan(Math.min(...c2Kids));
  });

  it('does not move a locked device, and says how many it left', () => {
    const nodes = [node('net', 'internet'), node('fw', 'firewall', { locked: true })];
    const { moved, locked } = hierarchicalLayout(nodes, [edge('net', 'fw')]);
    expect(locked).toBe(1);
    expect(moved.has('fw')).toBe(false);
    expect(moved.has('net')).toBe(true);
  });

  it('has nothing to arrange for an empty page', () => {
    expect(hierarchicalLayout([], []).moved.size).toBe(0);
  });

  it('still arranges a topology with no links at all', () => {
    const nodes = [node('a', 'core-switch'), node('b', 'access-switch')];
    const { moved } = hierarchicalLayout(nodes, []);
    expect(moved.size).toBe(2);
    expect(moved.get('a')!.y).toBeLessThan(moved.get('b')!.y);
  });

  it('spaces tiers by the rank gap and siblings by the sibling gap', () => {
    const { nodes, edges } = chain();
    const { moved } = hierarchicalLayout(nodes, edges);
    // The next tier's top is the last tier's bottom plus the rank gap.
    expect(moved.get('fw')!.y - (moved.get('net')!.y + 76)).toBe(RANK_GAP);
    expect(moved.get('a2')!.x - (moved.get('a1')!.x + 76)).toBe(SIBLING_GAP);
  });
});

describe('ranking unknowns by hops', () => {
  it('ranks a group the types say nothing about from its middle', () => {
    // A crawl that could only call everything a switch: a hub with two
    // spokes, one of which has a spoke of its own. The hub is fewest hops
    // from everything and goes at the top; each hop is a tier down.
    const nodes = [node('hub', 'generic'), node('s1', 'generic'), node('s2', 'generic'), node('leaf', 'generic')];
    const t = tiersFor(nodes, [edge('s1', 'hub'), edge('hub', 's2'), edge('s2', 'leaf')]);
    expect(t.get('hub')).toBe(0);
    expect(t.get('s1')).toBe(1);
    expect(t.get('s2')).toBe(1);
    expect(t.get('leaf')).toBe(2);
  });

  it('keeps such a group below every typed tier', () => {
    const nodes = [node('net', 'internet'), node('core', 'core-switch'), node('x', 'generic'), node('y', 'generic')];
    const t = tiersFor(nodes, [edge('net', 'core'), edge('x', 'y')]);
    expect(Math.min(t.get('x')!, t.get('y')!)).toBeGreaterThan(t.get('core')!);
    expect(t.get('x')).not.toBe(t.get('y'));
  });
});

describe('crossings', () => {
  it('orders a tier by its neighbours below as well as above', () => {
    // Two cores each feeding its own pair of access switches, but declared
    // so that the cores' order is the wrong way round for the access
    // switches' order. Only a sweep that reads the tier *below* can fix the
    // cores' order, since nothing is above them.
    const nodes = [
      node('c1', 'core-switch'), node('c2', 'core-switch'),
      node('b1', 'access-switch'), node('b2', 'access-switch'),
      node('a1', 'access-switch'), node('a2', 'access-switch'),
    ];
    const edges = [edge('c1', 'a1'), edge('c1', 'a2'), edge('c2', 'b1'), edge('c2', 'b2')];
    const { moved } = hierarchicalLayout(nodes, edges);
    const x = (id: string) => moved.get(id)!.x;
    const left = x('c1') < x('c2') ? ['a1', 'a2'] : ['b1', 'b2'];
    const right = x('c1') < x('c2') ? ['b1', 'b2'] : ['a1', 'a2'];
    expect(Math.max(...left.map(x))).toBeLessThan(Math.min(...right.map(x)));
  });

  it('lands on an order with no crossings where one exists', () => {
    // A ladder: three cores, three distribution switches, each joined to
    // the core with the same number and to the next one along, declared in
    // a scrambled order.
    const nodes = [
      node('d3', 'distribution-switch'), node('c2', 'core-switch'), node('d1', 'distribution-switch'),
      node('c3', 'core-switch'), node('d2', 'distribution-switch'), node('c1', 'core-switch'),
    ];
    const edges = [edge('c1', 'd1'), edge('c2', 'd2'), edge('c3', 'd3'), edge('c1', 'd2'), edge('c2', 'd3')];
    const { moved } = hierarchicalLayout(nodes, edges);
    const x = (id: string) => moved.get(id)!.x;
    const cores = ['c1', 'c2', 'c3'].sort((a, b) => x(a) - x(b));
    const dists = ['d1', 'd2', 'd3'].sort((a, b) => x(a) - x(b));
    // The same order on both tiers, whichever way round, has no crossings.
    expect(dists.map((d) => `c${d.slice(1)}`)).toEqual(cores);
  });
});

describe('fans', () => {
  const fan = (count: number) => {
    const nodes = [node('sw', 'access-switch')];
    const edges: HierarchyEdge[] = [];
    for (let i = 0; i < count; i += 1) {
      nodes.push(node(`h${i}`, 'server'));
      edges.push(edge('sw', `h${i}`));
    }
    return { nodes, edges };
  };

  it('keeps a fan of twelve on one row', () => {
    const { nodes, edges } = fan(12);
    const { moved } = hierarchicalLayout(nodes, edges);
    const ys = new Set(Array.from({ length: 12 }, (_, i) => moved.get(`h${i}`)!.y));
    expect(ys.size).toBe(1);
  });

  it('wraps a fan of more than twelve into two rows under the switch', () => {
    const { nodes, edges } = fan(13);
    const { moved } = hierarchicalLayout(nodes, edges);
    const ys = new Set(Array.from({ length: 13 }, (_, i) => moved.get(`h${i}`)!.y));
    expect(ys.size).toBe(2);
    // Seven on the first row, six on the second, the rows closer than tiers.
    const [top, bottom] = [...ys].sort((a, b) => a - b) as [number, number];
    const onTop = Array.from({ length: 13 }, (_, i) => moved.get(`h${i}`)!.y).filter((y) => y === top).length;
    expect(onTop).toBe(7);
    expect(bottom - top).toBeLessThan(RANK_GAP);
    expect(top).toBeGreaterThan(moved.get('sw')!.y);
    // The switch is centred over the fan.
    const xs = Array.from({ length: 13 }, (_, i) => moved.get(`h${i}`)!.x);
    const fanMid = (Math.min(...xs) + Math.max(...xs) + 76) / 2;
    expect(Math.abs(moved.get('sw')!.x + 38 - fanMid)).toBeLessThan(2);
  });

  it('leaves no two devices on top of one another in a fan', () => {
    const { nodes, edges } = fan(30);
    const { moved } = hierarchicalLayout(nodes, edges);
    const seen = new Set<string>();
    for (const [, p] of moved) {
      expect(seen.has(`${p.x},${p.y}`)).toBe(false);
      seen.add(`${p.x},${p.y}`);
    }
  });
});

describe('what stays put', () => {
  it('leaves a pinned device where it was moved, and says how many', () => {
    const nodes = [node('net', 'internet'), node('fw', 'firewall', { pinned: true, x: 900, y: 40 }), node('core', 'core-switch')];
    const { moved, pinned, locked } = hierarchicalLayout(nodes, [edge('net', 'fw'), edge('fw', 'core')]);
    expect(pinned).toBe(1);
    expect(locked).toBe(0);
    expect(moved.has('fw')).toBe(false);
  });

  it('gathers what hangs off a pinned device under where it is', () => {
    const nodes = [
      node('core', 'core-switch', { pinned: true, x: 1000, y: 0 }),
      node('a1', 'access-switch'), node('a2', 'access-switch'),
    ];
    const { moved } = hierarchicalLayout(nodes, [edge('core', 'a1'), edge('core', 'a2')]);
    const mid = (moved.get('a1')!.x + moved.get('a2')!.x + 76) / 2;
    expect(Math.abs(mid - (1000 + 38))).toBeLessThan(2);
  });

  it('moves a device along its row rather than laying it over a locked one', () => {
    // The locked switch sits exactly where the arrangement would put the
    // first access switch.
    const first = hierarchicalLayout(
      [node('core', 'core-switch'), node('a1', 'access-switch'), node('a2', 'access-switch')],
      [edge('core', 'a1'), edge('core', 'a2')],
    ).moved;
    const spot = first.get('a1')!;
    const nodes = [
      node('core', 'core-switch'), node('a1', 'access-switch'), node('a2', 'access-switch'),
      node('held', 'access-switch', { locked: true, x: spot.x, y: spot.y }),
    ];
    const { moved } = hierarchicalLayout(nodes, [edge('core', 'a1'), edge('core', 'a2')]);
    for (const id of ['a1', 'a2']) {
      const p = moved.get(id)!;
      const apart = p.x >= spot.x + 76 || p.x + 76 <= spot.x || p.y >= spot.y + 76 || p.y + 76 <= spot.y;
      expect(apart, `${id} laid over the locked device`).toBe(true);
    }
    expect(moved.get('a1')!.x).toBeLessThan(moved.get('a2')!.x);
  });

  it('is the same arrangement twice', () => {
    const nodes = [node('net', 'internet'), node('fw', 'firewall'), node('core', 'core-switch'),
      node('a1', 'access-switch'), node('a2', 'access-switch')];
    const edges = [edge('net', 'fw'), edge('fw', 'core'), edge('core', 'a1'), edge('core', 'a2')];
    const a = hierarchicalLayout(nodes, edges).moved;
    const b = hierarchicalLayout([...nodes].reverse(), [...edges].reverse()).moved;
    for (const [id, p] of a) expect(b.get(id)).toEqual(p);
  });
});
