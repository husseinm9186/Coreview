/**
 * Orthogonal links that go round the devices in their way (LT-178).
 *
 * A step link turns once or twice at fixed points and runs straight through
 * whatever is between its ends. This one finds a route of horizontal and
 * vertical runs that stays a margin clear of every other device, preferring the
 * shortest route with the fewest turns.
 *
 * The search is on a grid made only of the lines that matter — each device's
 * edges pushed out by the margin, and the two ends' own lines — so it is small
 * however far apart the ends are. Only devices near the link are obstacles,
 * which keeps it cheap on a large diagram; a device far off cannot be in the
 * way. A device lying over one of the ends is not treated as in the way — there
 * is no going round what a link starts inside. When there is no route at all
 * (an end walled in on every side), it says so and the link falls back to a step
 * path.
 *
 * Pure geometry, shared by the canvas and the export so a routed link is drawn
 * the same in both.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

export type Side = 'top' | 'right' | 'bottom' | 'left';

const MARGIN = 16;
const BEND_COST = 60;
const NEAR = 400;
const MAX_OBSTACLES = 60;

function inflate(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

/** Strictly inside: a route may run along an inflated edge, not through it. */
function inside(p: Pt, r: Rect): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}

function segmentHits(a: Pt, b: Pt, r: Rect): boolean {
  if (a.x === b.x) {
    if (a.x <= r.x || a.x >= r.x + r.w) return false;
    const [y1, y2] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
    return y2 > r.y && y1 < r.y + r.h;
  }
  if (a.y <= r.y || a.y >= r.y + r.h) return false;
  const [x1, x2] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
  return x2 > r.x && x1 < r.x + r.w;
}

function stub(p: Pt, side: Side, m: number): Pt {
  switch (side) {
    case 'top':
      return { x: p.x, y: p.y - m };
    case 'bottom':
      return { x: p.x, y: p.y + m };
    case 'left':
      return { x: p.x - m, y: p.y };
    default:
      return { x: p.x + m, y: p.y };
  }
}

/**
 * The route between two link ends — each a point on its device's outline and
 * the side it leaves by — round `obstacles`, as the list of corner points from
 * one end to the other; `null` when there is no way through.
 */
export function routeAround(
  from: Pt,
  fromSide: Side,
  to: Pt,
  toSide: Side,
  obstacles: readonly Rect[],
): Pt[] | null {
  const a = stub(from, fromSide, MARGIN);
  const b = stub(to, toSide, MARGIN);
  const span = {
    x: Math.min(a.x, b.x) - NEAR,
    y: Math.min(a.y, b.y) - NEAR,
    w: Math.abs(a.x - b.x) + 2 * NEAR,
    h: Math.abs(a.y - b.y) + 2 * NEAR,
  };
  const overlaps = (r: Rect) => r.x < span.x + span.w && r.x + r.w > span.x && r.y < span.y + span.h && r.y + r.h > span.y;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const blocks = obstacles
    .filter(overlaps)
    .map((r) => inflate(r, MARGIN - 1))
    .sort((p, q) => Math.hypot(p.x + p.w / 2 - mid.x, p.y + p.h / 2 - mid.y) - Math.hypot(q.x + q.w / 2 - mid.x, q.y + q.h / 2 - mid.y))
    .slice(0, MAX_OBSTACLES);

  // A device lying over an end cannot be gone round — the link starts inside
  // it — so it is not an obstacle; everything else still is.
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (inside(a, blocks[i]!) || inside(b, blocks[i]!)) blocks.splice(i, 1);
  }

  const xs = new Set<number>([a.x, b.x]);
  const ys = new Set<number>([a.y, b.y]);
  for (const r of blocks) {
    xs.add(r.x);
    xs.add(r.x + r.w);
    ys.add(r.y);
    ys.add(r.y + r.h);
  }
  const X = [...xs].sort((p, q) => p - q);
  const Y = [...ys].sort((p, q) => p - q);
  const key = (i: number, j: number) => i * Y.length + j;
  const free = (i: number, j: number) => !blocks.some((r) => inside({ x: X[i]!, y: Y[j]! }, r));

  // Dijkstra over (grid point, heading), so a turn costs extra.
  const start = key(X.indexOf(a.x), Y.indexOf(a.y));
  const goal = key(X.indexOf(b.x), Y.indexOf(b.y));
  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const initialDir = fromSide === 'left' || fromSide === 'right' ? (fromSide === 'right' ? 0 : 1) : fromSide === 'bottom' ? 2 : 3;
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const state = (k: number, d: number) => k * 4 + d;
  // A small binary heap keyed on cost.
  const heap: [number, number][] = [];
  const push = (cost: number, s: number) => {
    heap.push([cost, s]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]![0] <= heap[i]![0]) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = (): [number, number] | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  const s0 = state(start, initialDir);
  dist.set(s0, 0);
  push(0, s0);
  let found: number | null = null;
  while (heap.length) {
    const [cost, s] = pop()!;
    if (cost > (dist.get(s) ?? Infinity)) continue;
    const k = Math.floor(s / 4);
    const d = s % 4;
    if (k === goal) {
      found = s;
      break;
    }
    const i = Math.floor(k / Y.length);
    const j = k % Y.length;
    for (let nd = 0; nd < 4; nd++) {
      const [di, dj] = DIRS[nd]!;
      // Never straight back the way it came.
      if (DIRS[d]![0] === -di && DIRS[d]![1] === -dj) continue;
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= X.length || nj >= Y.length) continue;
      if (!free(ni, nj)) continue;
      const p1 = { x: X[i]!, y: Y[j]! };
      const p2 = { x: X[ni]!, y: Y[nj]! };
      if (blocks.some((r) => segmentHits(p1, p2, r))) continue;
      const step = Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y) + (nd === d ? 0 : BEND_COST);
      const ns = state(key(ni, nj), nd);
      const nc = cost + step;
      if (nc < (dist.get(ns) ?? Infinity)) {
        dist.set(ns, nc);
        prev.set(ns, s);
        push(nc, ns);
      }
    }
  }
  if (found === null) return null;

  const path: Pt[] = [];
  for (let s: number | undefined = found; s !== undefined; s = prev.get(s)) {
    const k = Math.floor(s / 4);
    path.push({ x: X[Math.floor(k / Y.length)]!, y: Y[k % Y.length]! });
  }
  path.reverse();
  return simplify([from, ...path, to]);
}

/** Drops repeated points and points in the middle of a straight run. */
export function simplify(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const before = out[out.length - 2];
    if (before && last && ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/** The route as an SVG path with rounded corners, and the point halfway along
 *  it for the label. */
export function routePath(points: readonly Pt[], radius = 10): { path: string; labelAt: Pt } {
  if (points.length < 2) return { path: '', labelAt: points[0] ?? { x: 0, y: 0 } };
  let d = `M${points[0]!.x},${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const a = points[i - 1]!;
    const b = points[i + 1]!;
    const r = Math.min(radius, Math.hypot(p.x - a.x, p.y - a.y) / 2, Math.hypot(b.x - p.x, b.y - p.y) / 2);
    const inX = p.x + Math.sign(a.x - p.x) * r;
    const inY = p.y + Math.sign(a.y - p.y) * r;
    const outX = p.x + Math.sign(b.x - p.x) * r;
    const outY = p.y + Math.sign(b.y - p.y) * r;
    d += `L${inX},${inY}Q${p.x},${p.y} ${outX},${outY}`;
  }
  const end = points[points.length - 1]!;
  d += `L${end.x},${end.y}`;
  // Halfway along by length.
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  let remaining = lengths.reduce((s, l) => s + l, 0) / 2;
  let labelAt = points[0]!;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]!) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const t = lengths[i]! === 0 ? 0 : remaining / lengths[i]!;
      labelAt = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      break;
    }
    remaining -= lengths[i]!;
  }
  return { path: d, labelAt };
}

/** The devices a link routes round: every device and drawn shape on the page,
 *  its own two ends included — so it cannot cut through its own device to reach
 *  the far side — but not sections or text (backgrounds and words, not things
 *  in the way) or notes. Each end's first step out clears its own device. */
export function obstaclesFor(
  nodes: readonly { id: string; type?: string; position: Pt; width?: number; height?: number; measured?: { width?: number; height?: number }; data?: unknown }[],
): Rect[] {
  return nodes
    .filter((n) => {
      if (n.type !== 'device') return false;
      const kind = (n.data as { deviceType?: string } | undefined)?.deviceType;
      return kind !== 'zone' && kind !== 'text';
    })
    .map((n) => ({
      x: n.position.x,
      y: n.position.y,
      w: n.width ?? n.measured?.width ?? 76,
      h: n.height ?? n.measured?.height ?? 76,
    }));
}

