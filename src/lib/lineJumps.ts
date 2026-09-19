/**
 * Little hops where one link crosses another.
 *
 * On a meshed diagram lines cross, and two lines meeting at a point look
 * exactly like two lines joined at a point. A hop is the convention every
 * schematic uses to say "these pass, they do not connect", and it is worth
 * more than any amount of routing because the crossings that remain are the
 * ones that cannot be routed away.
 *
 * The work is done on the path strings the edges already produce, so nothing
 * here needs to know how a link was routed or what shape it is.
 */

export interface Point {
  x: number;
  y: number;
}

interface Segment extends Point {
  /** The other end. */
  x2: number;
  y2: number;
  /** A piece of a flattened curve rather than a straight run (LT-161). Its
   *  ends are sampling joints, not corners, so a crossing at one is real. */
  curved?: boolean;
}

/** How finely a cubic curve is cut into straight pieces (LT-161). Fine enough
 *  that a hop cut into the pieces cannot be told from one on the curve. */
const CURVE_PIECES = 32;

/** A point on a cubic bezier. */
function cubicAt(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
}

/** A point on a quadratic bezier. */
function quadAt(p0: Point, c: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
}

/**
 * The straight runs of a path.
 *
 * Only `L` segments: a crossing lands on a long horizontal or vertical run
 * essentially always, and the rounded corners a step path uses are 12px of
 * arc that a hop would sit awkwardly on. Curves are skipped rather than
 * approximated, which keeps the geometry exact for the paths it does handle.
 */
export function straightRuns(d: string): Segment[] {
  const out: Segment[] = [];
  // Commands are single letters followed by numbers. Only M, L and Q appear
  // in the paths this app draws.
  const tokens = d.match(/[MLQCA][^MLQCA]*/gi) ?? [];
  let at: Point | null = null;
  for (const token of tokens) {
    const kind = token[0]!.toUpperCase();
    const nums = (token.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
    if (kind === 'M' && nums.length >= 2) {
      at = { x: nums[0]!, y: nums[1]! };
    } else if (kind === 'L' && nums.length >= 2) {
      const next = { x: nums[0]!, y: nums[1]! };
      if (at) out.push({ x: at.x, y: at.y, x2: next.x, y2: next.y });
      at = next;
    } else if (kind === 'C' && nums.length >= 6 && at) {
      // LT-161: a bezier link is one cubic curve, and skipping curves meant
      // bezier links never hopped and nothing hopped over them. Cut into
      // short pieces instead. Smooth-step's small `Q` corners stay skipped, as
      // above — a hop does not belong on a 12px corner.
      const c1 = { x: nums[0]!, y: nums[1]! };
      const c2 = { x: nums[2]!, y: nums[3]! };
      const end = { x: nums[4]!, y: nums[5]! };
      let prev = at;
      for (let i = 1; i <= CURVE_PIECES; i++) {
        const p = cubicAt(at, c1, c2, end, i / CURVE_PIECES);
        out.push({ x: prev.x, y: prev.y, x2: p.x, y2: p.y, curved: true });
        prev = p;
      }
      at = end;
    } else if (nums.length >= 2) {
      // Any curve: move the pen to its end without recording a run.
      at = { x: nums[nums.length - 2]!, y: nums[nums.length - 1]! };
    }
  }
  return coalesceCollinear(out);
}

/** Merge consecutive runs that lie on one straight line.
 *
 *  React Flow's smoothstep emits its 20px border offsets as extra waypoints,
 *  so one visually straight segment arrives as two or three collinear runs
 *  (`186.5→206.5→341.5→476.5`, all on the same y). A crossing that lands near
 *  one of those internal joints then falls at a run boundary and the hop is
 *  dropped for being too close to an end — which is why crossings under a
 *  smoothstep link stopped hopping. Coalescing makes each straight line one
 *  run again, so a crossing anywhere along it is comfortably mid-run. */
function coalesceCollinear(runs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const r of runs) {
    if (r.x === r.x2 && r.y === r.y2) continue; // a zero-length joint
    const last = out[out.length - 1];
    if (last && !last.curved && !r.curved) {
      const a = { x: last.x2 - last.x, y: last.y2 - last.y };
      const b = { x: r.x2 - r.x, y: r.y2 - r.y };
      const joined = last.x2 === r.x && last.y2 === r.y;
      const collinear = Math.abs(a.x * b.y - a.y * b.x) < 1e-6 && a.x * b.x + a.y * b.y > 0;
      if (joined && collinear) {
        last.x2 = r.x2;
        last.y2 = r.y2;
        continue;
      }
    }
    out.push({ ...r });
  }
  return out;
}

/** Where two straight runs cross, or null. Touching ends do not count. */
export function crossing(a: Segment, b: Segment): Point | null {
  const r = { x: a.x2 - a.x, y: a.y2 - a.y };
  const s = { x: b.x2 - b.x, y: b.y2 - b.y };
  const denom = r.x * s.y - r.y * s.x;
  // Parallel, including two runs lying along one another. A hop on a line
  // that shares its whole length with another says nothing useful.
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((b.x - a.x) * s.y - (b.y - a.y) * s.x) / denom;
  const u = ((b.x - a.x) * r.y - (b.y - a.y) * r.x) / denom;
  // Strictly inside both, with a margin: a crossing right at an endpoint is
  // two links meeting at a device, which is a join and not a crossing.
  //
  // LT-161: a piece of a flattened curve has sampling joints for ends, and a
  // crossing at one is a real crossing, so it takes [0, 1) instead — the open
  // end stops one crossing being counted on two neighbouring pieces. Where a
  // curve's link actually meets a device is handled in `jumpsFor`.
  const margin = 0.02;
  const inside = (v: number, curved?: boolean) => (curved ? v >= 0 && v < 1 : v > margin && v < 1 - margin);
  if (!inside(t, a.curved) || !inside(u, b.curved)) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/** The rectangle a set of runs sits in. */
function boxOf(runs: Segment[]): { x1: number; y1: number; x2: number; y2: number } {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of runs) {
    x1 = Math.min(x1, r.x, r.x2);
    y1 = Math.min(y1, r.y, r.y2);
    x2 = Math.max(x2, r.x, r.x2);
    y2 = Math.max(y2, r.y, r.y2);
  }
  return { x1, y1, x2, y2 };
}

/** A path's first and last points. */
function endsOf(d: string): Point[] {
  const nums = (d.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
  if (nums.length < 4) return [];
  return [
    { x: nums[0]!, y: nums[1]! },
    { x: nums[nums.length - 2]!, y: nums[nums.length - 1]! },
  ];
}

/** How close to a link's own end a crossing is taken to be two links meeting
 *  at a device rather than crossing (LT-161, for curves; straight runs keep
 *  their own margin). */
const END_GAP = 8;

/**
 * Which of two crossing links should hop.
 *
 * Both hopping at the same point draws two arcs through each other, which is
 * worse than no hop at all. The rule is the schematic one: the horizontal run
 * hops over the vertical. Where both runs are at the same angle the id breaks
 * the tie, so the choice is stable — it must not depend on which edge happened
 * to render first, or the hop would flicker between them.
 */
export function shouldHop(mine: Segment, theirs: Segment, myId: string, theirId: string): boolean {
  const myHorizontal = Math.abs(mine.y2 - mine.y) < Math.abs(mine.x2 - mine.x);
  const theirHorizontal = Math.abs(theirs.y2 - theirs.y) < Math.abs(theirs.x2 - theirs.x);
  if (myHorizontal !== theirHorizontal) return myHorizontal;
  return myId < theirId;
}

/**
 * Every point on this path that should carry a hop.
 *
 * `others` is every other path on the diagram, by id.
 */
export function jumpsFor(
  id: string,
  d: string,
  others: Iterable<[string, string]>,
  minGap = 10,
): Point[] {
  const mine = straightRuns(d);
  if (mine.length === 0) return [];
  const myBox = boxOf(mine);
  const myEnds = endsOf(d);
  const points: Point[] = [];
  for (const [otherId, otherD] of others) {
    if (otherId === id) continue;
    const theirRuns = straightRuns(otherD);
    // A curve is 32 pieces (LT-161), so links that cannot meet are dropped
    // before any piece is compared with any other.
    const box = boxOf(theirRuns);
    if (box.x1 > myBox.x2 || box.x2 < myBox.x1 || box.y1 > myBox.y2 || box.y2 < myBox.y1) continue;
    const theirEnds = endsOf(otherD);
    for (const theirs of theirRuns) {
      for (const run of mine) {
        const at = crossing(run, theirs);
        if (!at) continue;
        // Two links meeting where one ends is a join at a device, not a
        // crossing — the curve pieces have no margin of their own to say so.
        if ((run.curved || theirs.curved) &&
          [...myEnds, ...theirEnds].some((e) => Math.hypot(e.x - at.x, e.y - at.y) < END_GAP)) continue;
        if (!shouldHop(run, theirs, id, otherId)) continue;
        // Two links crossing the same run within a hop's width would draw
        // overlapping arcs; one hop reads better than a scallop.
        if (points.some((p) => Math.hypot(p.x - at.x, p.y - at.y) < minGap)) continue;
        points.push(at);
      }
    }
  }
  return points;
}

/**
 * The same path with a little arc at each crossing.
 *
 * Only `L` runs are rewritten, so the rounded corners of a step path and any
 * curve are handed back untouched.
 */
export function withJumps(d: string, jumps: Point[], radius = 5): string {
  if (jumps.length === 0) return d;
  // LT-161: a path with a cubic curve has no straight run to cut the hop into,
  // so it is drawn as a fine polyline with the hop cut in by distance along it.
  if (/C/i.test(d)) return withJumpsAlongCurve(d, jumps, radius);
  const tokens = d.match(/[MLQCA][^MLQCA]*/gi) ?? [];
  let at: Point | null = null;
  let out = '';
  // Consecutive collinear `L` runs are one straight line for hop purposes —
  // smoothstep splits a straight segment at its border offsets, and a hop
  // near one of those joints was being dropped for sitting at a run's end
  // (the crossings-do-not-hop bug). Buffer a straight run's start and end,
  // and flush it as one span the moment the direction changes.
  let runStart: Point | null = null;
  const flushRun = (end: Point) => {
    if (runStart) out += rewriteRun(runStart, end, jumps, radius);
    else out += `L${end.x},${end.y}`;
    runStart = null;
  };

  for (const token of tokens) {
    const kind = token[0]!.toUpperCase();
    const nums = (token.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
    if (kind === 'L' && nums.length >= 2 && at) {
      const end = { x: nums[0]!, y: nums[1]! };
      if (end.x === at.x && end.y === at.y) continue; // zero-length joint
      if (runStart) {
        const a = { x: at.x - runStart.x, y: at.y - runStart.y };
        const b = { x: end.x - at.x, y: end.y - at.y };
        const collinear = Math.abs(a.x * b.y - a.y * b.x) < 1e-6 && a.x * b.x + a.y * b.y > 0;
        if (!collinear) flushRun(at);
      }
      if (!runStart) runStart = at;
      at = end;
      continue;
    }
    if (runStart && at) flushRun(at);
    out += token;
    if (nums.length >= 2) at = { x: nums[nums.length - 2]!, y: nums[nums.length - 1]! };
  }
  if (runStart && at) flushRun(at);
  return out;
}

/** One straight run, cut at each hop and stitched back with arcs. */
function rewriteRun(from: Point, to: Point, jumps: Point[], radius: number): string {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length < radius * 3) return `L${to.x},${to.y}`;
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;

  const along = jumps
    .map((j) => ({ j, t: (j.x - from.x) * ux + (j.y - from.y) * uy }))
    // On this run, and far enough from either end that the arc is not cut off.
    .filter(({ j, t }) => {
      if (t <= radius * 1.2 || t >= length - radius * 1.2) return false;
      const px = from.x + ux * t;
      const py = from.y + uy * t;
      return Math.hypot(px - j.x, py - j.y) < 0.6;
    })
    .sort((a, b) => a.t - b.t);

  if (along.length === 0) return `L${to.x},${to.y}`;

  const round = (n: number) => Math.round(n * 100) / 100;
  let out = '';
  for (const { t } of along) {
    const ax = from.x + ux * (t - radius);
    const ay = from.y + uy * (t - radius);
    const bx = from.x + ux * (t + radius);
    const by = from.y + uy * (t + radius);
    // sweep 1 so every hop bows the same way along the line's direction,
    // which is what makes a row of them look deliberate rather than random.
    out += `L${round(ax)},${round(ay)}A${radius},${radius} 0 0 1 ${round(bx)},${round(by)}`;
  }
  return `${out}L${to.x},${to.y}`;
}

/** A path as a fine polyline: straight runs kept, curves cut into pieces. */
function flatten(d: string): Point[] {
  const tokens = d.match(/[MLQCA][^MLQCA]*/gi) ?? [];
  const pts: Point[] = [];
  let at: Point | null = null;
  for (const token of tokens) {
    const kind = token[0]!.toUpperCase();
    const nums = (token.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
    if (kind === 'M' && nums.length >= 2) {
      at = { x: nums[0]!, y: nums[1]! };
      pts.push(at);
    } else if (kind === 'L' && nums.length >= 2) {
      at = { x: nums[0]!, y: nums[1]! };
      pts.push(at);
    } else if (kind === 'C' && nums.length >= 6 && at) {
      const c1 = { x: nums[0]!, y: nums[1]! };
      const c2 = { x: nums[2]!, y: nums[3]! };
      const end = { x: nums[4]!, y: nums[5]! };
      for (let i = 1; i <= CURVE_PIECES; i++) pts.push(cubicAt(at, c1, c2, end, i / CURVE_PIECES));
      at = end;
    } else if (kind === 'Q' && nums.length >= 4 && at) {
      const c = { x: nums[0]!, y: nums[1]! };
      const end = { x: nums[2]!, y: nums[3]! };
      for (let i = 1; i <= 8; i++) pts.push(quadAt(at, c, end, i / 8));
      at = end;
    } else if (nums.length >= 2) {
      at = { x: nums[nums.length - 2]!, y: nums[nums.length - 1]! };
      pts.push(at);
    }
  }
  return pts;
}

/**
 * Hops on a path that curves (LT-161): the path redrawn as a fine polyline,
 * with each hop cut in by its distance along the line, so a hop may span
 * several pieces of the curve and still read as one arc.
 */
function withJumpsAlongCurve(d: string, jumps: Point[], radius: number): string {
  const pts = flatten(d);
  if (pts.length < 2) return d;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  }
  const total = cum[cum.length - 1]!;
  const pointAt = (s: number): Point => {
    let i = 1;
    while (i < pts.length - 1 && cum[i]! < s) i++;
    const span = cum[i]! - cum[i - 1]! || 1;
    const f = (s - cum[i - 1]!) / span;
    return { x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * f, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * f };
  };
  // Each hop's distance along the line: the nearest point on the polyline.
  const along: number[] = [];
  for (const j of jumps) {
    let best = Infinity;
    let bestS = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const t = Math.max(0, Math.min(1, ((j.x - a.x) * (b.x - a.x) + (j.y - a.y) * (b.y - a.y)) / (len * len)));
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const dist = Math.hypot(px - j.x, py - j.y);
      if (dist < best) {
        best = dist;
        bestS = cum[i - 1]! + len * t;
      }
    }
    if (best < 1 && bestS > radius * 1.2 && bestS < total - radius * 1.2) along.push(bestS);
  }
  if (along.length === 0) return d;
  along.sort((a, b) => a - b);

  const round = (n: number) => Math.round(n * 100) / 100;
  let out = `M${round(pts[0]!.x)},${round(pts[0]!.y)}`;
  let i = 1;
  let skipTo = -Infinity;
  for (const s of along) {
    if (s - radius < skipTo) continue; // overlapping hops read as one
    while (i < pts.length && cum[i]! < s - radius) {
      if (cum[i]! > skipTo) out += `L${round(pts[i]!.x)},${round(pts[i]!.y)}`;
      i++;
    }
    const a = pointAt(s - radius);
    const b = pointAt(s + radius);
    out += `L${round(a.x)},${round(a.y)}A${radius},${radius} 0 0 1 ${round(b.x)},${round(b.y)}`;
    skipTo = s + radius;
    while (i < pts.length && cum[i]! <= skipTo) i++;
  }
  for (; i < pts.length; i++) out += `L${round(pts[i]!.x)},${round(pts[i]!.y)}`;
  return out;
}
