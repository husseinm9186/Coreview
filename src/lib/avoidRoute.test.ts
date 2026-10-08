import { describe, expect, it } from 'vitest';

import { laneAmong, laneOffset, laneShift, obstaclesFor, routeAround, routePath, simplify, type Pt, type Rect } from './avoidRoute';

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

describe('routing round devices', () => {
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

describe('lanes for parallel routed links', () => {
  it('shifts the interior runs sideways and keeps both ends', () => {
    // Down, right, down: a Z.
    const route = [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 100 }];
    const shifted = laneOffset(route, 10);
    expect(shifted[0]).toEqual({ x: 0, y: 0 });
    expect(shifted[shifted.length - 1]).toEqual({ x: 100, y: 100 });
    // The first run (down) moves right by 10, the middle run (to the right) moves up by 10.
    expect(shifted[1]).toEqual({ x: 10, y: 40 });
    expect(shifted[2]).toEqual({ x: 110, y: 40 });
    // The other lane goes the other way, and lane 0 does not move.
    expect(laneOffset(route, -10)[1]).toEqual({ x: -10, y: 60 });
    expect(laneOffset(route, 0)).toEqual(route);
    expect(laneOffset([{ x: 0, y: 0 }, { x: 5, y: 5 }], 10)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 5 }]);
  });

  it('numbers the links joining one pair by id, either way round, and spreads them about the middle', () => {
    const edges = [
      { id: 'b', source: 'x', target: 'y' },
      { id: 'a', source: 'y', target: 'x' },
      { id: 'c', source: 'x', target: 'z' },
    ];
    expect(laneAmong(edges, 'a')).toEqual({ index: 0, count: 2 });
    expect(laneAmong(edges, 'b')).toEqual({ index: 1, count: 2 });
    expect(laneAmong(edges, 'c')).toEqual({ index: 0, count: 1 });
    expect(laneShift({ index: 0, count: 2 })).toBe(-5);
    expect(laneShift({ index: 1, count: 2 })).toBe(5);
    expect(laneShift({ index: 1, count: 3 })).toBe(0);
    expect(laneShift(laneAmong(edges, 'zzz'))).toBe(0);
  });

  it('treats a note as something to go round', () => {
    const rects = obstaclesFor([
      { id: 'n', type: 'note', position: { x: 10, y: 10 }, width: 100, height: 50 },
      { id: 'z', type: 'device', position: { x: 0, y: 0 }, width: 300, height: 300, data: { deviceType: 'zone' } },
    ]);
    expect(rects).toEqual([{ x: 10, y: 10, w: 100, h: 50 }]);
  });
});
