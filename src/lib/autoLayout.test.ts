import { describe, expect, it } from 'vitest';

import { forceLayout, orthogonalLayout, radialLayout, type LayoutEdge, type LayoutNode, type Positions } from './autoLayout';

const node = (id: string, x = 0, y = 0, locked = false): LayoutNode => ({ id, x, y, width: 76, height: 76, locked });
const link = (source: string, target: string): LayoutEdge => ({ source, target });

/** A star: one core, six access switches, each with a host. */
const star = () => {
  const nodes = [node('core', 0, 0)];
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < 6; i++) {
    nodes.push(node(`acc${i}`, i * 90, 200), node(`host${i}`, i * 90, 400));
    edges.push(link('core', `acc${i}`), link(`acc${i}`, `host${i}`));
  }
  return { nodes, edges };
};

const centreOf = (p: Positions, id: string) => {
  const at = p.get(id)!;
  return { x: at.x + 38, y: at.y + 38 };
};
const noOverlaps = (p: Positions) => {
  const list = [...p.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (Math.abs(list[i]!.x - list[j]!.x) < 76 && Math.abs(list[i]!.y - list[j]!.y) < 76) return false;
    }
  }
  return true;
};

describe('radial layout (LT-177)', () => {
  it('puts the best-connected device in the middle and the rest on rings by distance', () => {
    const { nodes, edges } = star();
    const p = radialLayout(nodes, edges);
    const c = centreOf(p, 'core');
    const r = (id: string) => Math.hypot(centreOf(p, id).x - c.x, centreOf(p, id).y - c.y);
    const accR = r('acc0');
    for (let i = 0; i < 6; i++) {
      expect(r(`acc${i}`)).toBeCloseTo(accR, 0);
      expect(r(`host${i}`)).toBeGreaterThan(accR + 100);
    }
    expect(noOverlaps(p)).toBe(true);
  });

  it('keeps a host near the switch it hangs off', () => {
    const { nodes, edges } = star();
    const p = radialLayout(nodes, edges);
    const c = centreOf(p, 'core');
    const angle = (id: string) => Math.atan2(centreOf(p, id).y - c.y, centreOf(p, id).x - c.x);
    for (let i = 0; i < 6; i++) {
      const diff = Math.abs(((angle(`host${i}`) - angle(`acc${i}`) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      expect(diff, `host${i}`).toBeLessThan(0.6);
    }
  });
});

describe('the centre of a layout (LT-177)', () => {
  it('is the core even when an access switch has as many links', () => {
    // Five access switches, each with four hosts: every switch has five links,
    // the same as the core. The core is still the one fewest hops from all.
    const nodes = [node('core')];
    const edges: LayoutEdge[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(node(`acc${i}`));
      edges.push(link('core', `acc${i}`));
      for (let j = 0; j < 4; j++) {
        nodes.push(node(`h${i}${j}`));
        edges.push(link(`acc${i}`, `h${i}${j}`));
      }
    }
    const radial = radialLayout(nodes, edges);
    const c = centreOf(radial, 'core');
    const r = (id: string) => Math.hypot(centreOf(radial, id).x - c.x, centreOf(radial, id).y - c.y);
    for (let i = 0; i < 5; i++) expect(r(`acc${i}`)).toBeLessThan(r(`h${i}0`));
    // Only true with the core at the centre: every switch one ring out.
    for (let i = 1; i < 5; i++) expect(r(`acc${i}`)).toBeCloseTo(r('acc0'), 0);
    const grid = orthogonalLayout(nodes, edges);
    expect(Math.min(...[...grid.values()].map((v) => v.y))).toBe(grid.get('core')!.y);
    expect([...grid.values()].filter((v) => v.y === grid.get('core')!.y)).toHaveLength(1);
  });
});

describe('force-directed layout (LT-177)', () => {
  it('pulls linked devices closer than unlinked ones and overlaps nothing', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => node(id, i * 10, 0));
    const edges = [link('a', 'b'), link('b', 'c'), link('d', 'e'), link('e', 'f')];
    const p = forceLayout(nodes, edges);
    const dist = (x: string, y: string) => Math.hypot(centreOf(p, x).x - centreOf(p, y).x, centreOf(p, x).y - centreOf(p, y).y);
    expect(dist('a', 'b')).toBeLessThan(dist('a', 'f'));
    expect(noOverlaps(p)).toBe(true);
  });

  it('separates devices stacked on the same spot, without randomness', () => {
    const nodes = ['a', 'b', 'c'].map((id) => node(id, 0, 0));
    const first = forceLayout(nodes, []);
    expect(noOverlaps(first)).toBe(true);
    expect(forceLayout(nodes, [])).toEqual(first);
  });

  it('holds a locked device still and does not return it', () => {
    const nodes = [node('fixed', 500, 500, true), node('a', 0, 0), node('b', 10, 0)];
    const p = forceLayout(nodes, [link('fixed', 'a'), link('fixed', 'b')]);
    expect(p.has('fixed')).toBe(false);
    expect(p.has('a')).toBe(true);
  });
});

describe('orthogonal layout (LT-177)', () => {
  it('puts each hop from the centre on its own row, and a device under what it hangs off', () => {
    const { nodes, edges } = star();
    const p = orthogonalLayout(nodes, edges);
    const core = p.get('core')!;
    for (let i = 0; i < 6; i++) {
      const acc = p.get(`acc${i}`)!;
      const host = p.get(`host${i}`)!;
      expect(acc.y, `acc${i}`).toBeGreaterThan(core.y);
      expect(host.y, `host${i}`).toBeGreaterThan(acc.y);
      expect(host.x, `host${i} under acc${i}`).toBe(acc.x);
    }
    expect(new Set([...p.values()].map((v) => v.y)).size).toBe(3);
    expect(noOverlaps(p)).toBe(true);
  });

  it('wraps a switch’s hosts into a block under it rather than one long row', () => {
    const nodes = [node('core')];
    const edges: LayoutEdge[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(node(`acc${i}`));
      edges.push(link('core', `acc${i}`));
      for (let j = 0; j < 4; j++) {
        nodes.push(node(`h${i}${j}`));
        edges.push(link(`acc${i}`, `h${i}${j}`));
      }
    }
    const p = orthogonalLayout(nodes, edges);
    const columns = new Set([...p.values()].map((v) => v.x)).size;
    expect(columns).toBeLessThanOrEqual(10);
    // Each switch's hosts are within its own block: at most a column either side.
    const step = Math.min(...[...p.values()].map((v) => v.x).filter((x, _, all) => x !== Math.min(...all)).map((x) => x - Math.min(...[...p.values()].map((v) => v.x))));
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 4; j++) expect(Math.abs(p.get(`h${i}${j}`)!.x - p.get(`acc${i}`)!.x), `h${i}${j}`).toBeLessThanOrEqual(step);
    }
    expect(noOverlaps(p)).toBe(true);
  });

  it('leaves a locked device where it is and its cell free', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d'), node('fixed', 0, 0, true)];
    const p = orthogonalLayout(nodes, [link('a', 'b')]);
    expect(p.has('fixed')).toBe(false);
    for (const at of p.values()) expect(Math.abs(at.x) < 76 && Math.abs(at.y) < 76).toBe(false);
  });
});

describe('every layout', () => {
  it('lands the same way twice', () => {
    const { nodes, edges } = star();
    for (const layout of [radialLayout, forceLayout, orthogonalLayout]) {
      expect(layout(nodes, edges)).toEqual(layout(nodes, edges));
    }
  });

  it('does nothing when everything is locked', () => {
    const nodes = [node('a', 0, 0, true), node('b', 5, 5, true)];
    for (const layout of [radialLayout, forceLayout, orthogonalLayout]) expect(layout(nodes, []).size).toBe(0);
  });
});
