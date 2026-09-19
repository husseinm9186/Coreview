import { describe, expect, it } from 'vitest';

import type { TopoNode } from '../state/store';
import { addPoint, insidePolygon, lassoed } from './lasso';

const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
const node = (id: string, x: number, y: number) =>
  ({ id, position: { x, y }, width: 20, height: 20 }) as TopoNode;

describe('lasso selection (LT-173)', () => {
  it('knows inside from outside', () => {
    expect(insidePolygon({ x: 50, y: 50 }, square)).toBe(true);
    expect(insidePolygon({ x: 150, y: 50 }, square)).toBe(false);
  });

  it('follows a concave outline', () => {
    // An L shape: the notch at the top right is outside.
    const l = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(insidePolygon({ x: 75, y: 25 }, l)).toBe(false);
    expect(insidePolygon({ x: 75, y: 75 }, l)).toBe(true);
  });

  it('selects by an object’s middle', () => {
    const nodes = [node('in', 30, 30), node('mostly-out', 95, 30), node('out', 300, 300)];
    // mostly-out's middle is at 105: outside, though its edge is inside.
    expect(lassoed(nodes, square)).toEqual(['in']);
  });

  it('encloses nothing with fewer than three points', () => {
    expect(lassoed([node('a', 0, 0)], [{ x: 0, y: 0 }, { x: 100, y: 100 }])).toEqual([]);
  });

  it('thins a slow drag', () => {
    let o = addPoint([], { x: 0, y: 0 });
    o = addPoint(o, { x: 1, y: 1 });
    o = addPoint(o, { x: 10, y: 0 });
    expect(o).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });
});
