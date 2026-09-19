import { describe, expect, it } from 'vitest';

import { routeAround, routePath, simplify, type Pt, type Rect } from './avoidRoute';

/** Whether any run of the route passes through the inside of a box. */
const crosses = (route: Pt[], box: Rect) =>
  route.slice(1).some((b, i) => {
    const a = route[i]!;
    if (a.x === b.x) {
      const [y1, y2] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
      return a.x > box.x && a.x < box.x + box.w && y2 > box.y && y1 < box.y + box.h;
    }
    const [x1, x2] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
    return a.y > box.y && a.y < box.y + box.h && x2 > box.x && x1 < box.x + box.w;
  });
const orthogonal = (route: Pt[]) => route.slice(1).every((b, i) => b.x === route[i]!.x || b.y === route[i]!.y);

describe('routing round devices (LT-178)', () => {
  it('goes straight when nothing is in the way', () => {
    const route = routeAround({ x: 100, y: 50 }, 'right', { x: 400, y: 50 }, 'left', []);
    expect(route).toEqual([{ x: 100, y: 50 }, { x: 400, y: 50 }]);
  });

  it('goes round a device standing between the ends', () => {
    const wall = { x: 220, y: 0, w: 60, h: 100 };
    const route = routeAround({ x: 100, y: 50 }, 'right', { x: 400, y: 50 }, 'left', [wall])!;
    expect(route).not.toBeNull();
    expect(orthogonal(route)).toBe(true);
    expect(crosses(route, wall)).toBe(false);
    expect(route[0]).toEqual({ x: 100, y: 50 });
    expect(route[route.length - 1]).toEqual({ x: 400, y: 50 });
  });

  it('keeps clear of several devices at once', () => {
    const walls = [
      { x: 200, y: -40, w: 40, h: 180 },
      { x: 300, y: -140, w: 40, h: 180 },
    ];
    const route = routeAround({ x: 100, y: 50 }, 'right', { x: 450, y: 50 }, 'left', walls)!;
    expect(route).not.toBeNull();
    for (const w of walls) expect(crosses(route, w)).toBe(false);
  });

  it('prefers fewer turns', () => {
    // Up and over is two more turns than needed when a straight line is free.
    const route = routeAround({ x: 0, y: 0 }, 'bottom', { x: 0, y: 300 }, 'top', [{ x: 200, y: 100, w: 50, h: 50 }])!;
    expect(route).toHaveLength(2);
  });

  it('does not cut through its own device to reach the far side of it', () => {
    const own = { x: 400, y: 20, w: 80, h: 60 };
    // Arriving at the right-hand side of a device that sits to the right.
    const route = routeAround({ x: 100, y: 50 }, 'right', { x: 480, y: 50 }, 'right', [own])!;
    expect(route).not.toBeNull();
    expect(crosses(route, own)).toBe(false);
    expect(route[route.length - 1]).toEqual({ x: 480, y: 50 });
  });

  it('ignores a device lying over an end, but still goes round the rest', () => {
    const over = { x: 90, y: 30, w: 50, h: 40 };
    const wall = { x: 220, y: 0, w: 60, h: 100 };
    const route = routeAround({ x: 100, y: 50 }, 'right', { x: 400, y: 50 }, 'left', [over, wall])!;
    expect(route).not.toBeNull();
    expect(crosses(route, wall)).toBe(false);
  });

  it('says there is no way when an end is walled in on every side', () => {
    // A ring of four walls round the target, touching at the corners.
    const walls = [
      { x: 340, y: -60, w: 160, h: 40 },
      { x: 340, y: 120, w: 160, h: 40 },
      { x: 340, y: -60, w: 40, h: 220 },
      { x: 460, y: -60, w: 40, h: 220 },
    ];
    expect(routeAround({ x: 100, y: 50 }, 'right', { x: 420, y: 50 }, 'left', walls)).toBeNull();
  });

  it('draws rounded corners and finds the halfway point', () => {
    const { path, labelAt } = routePath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10);
    expect(path).toBe('M0,0L90,0Q100,0 100,10L100,100');
    expect(labelAt).toEqual({ x: 100, y: 0 });
  });

  it('simplifies away straight-through points', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }])).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ]);
  });
});
