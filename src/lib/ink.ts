/**
 * Freehand ink on a page (LT-238): circling a problem, an arrow to a rack,
 * handwriting "this one" during a call — marks a structured shape cannot make.
 *
 * Strokes are kept in diagram coordinates on the page, so they stay on what
 * they were drawn over as the view pans and zooms, and they go into exports
 * while shown. A stroke is thinned as it is drawn (a point closer than a pixel
 * or two to the line through its neighbours adds nothing) and drawn as a
 * smoothed path.
 */
export interface InkStroke {
  id: string;
  /** Flat x,y pairs in diagram coordinates. */
  points: number[];
  color: string;
  width: number;
}

type Pt = [number, number];

const pairs = (flat: readonly number[]): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
};

function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker: the fewest points that stay within `tolerance`. */
export function simplifyStroke(flat: readonly number[], tolerance = 1.5): number[] {
  const pts = pairs(flat);
  if (pts.length <= 2) return pts.flat();
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let far = -1;
    let best = tolerance;
    for (let i = s + 1; i < e; i++) {
      const d = distanceToSegment(pts[i]!, pts[s]!, pts[e]!);
      if (d > best) {
        best = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = true;
      stack.push([s, far], [far, e]);
    }
  }
  return pts.filter((_, i) => keep[i]).flat();
}

const r = (v: number) => Math.round(v * 10) / 10;

/** A smoothed SVG path through the points: straight to the first midpoint,
 *  then a curve through each point to the next midpoint. A dot for one point. */
export function strokePath(flat: readonly number[]): string {
  const pts = pairs(flat);
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${r(pts[0]![0])},${r(pts[0]![1])}l0.1,0`;
  let d = `M${r(pts[0]![0])},${r(pts[0]![1])}`;
  if (pts.length === 2) return `${d}L${r(pts[1]![0])},${r(pts[1]![1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    d += `Q${r(x)},${r(y)} ${r((x + nx) / 2)},${r((y + ny) / 2)}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d}L${r(last[0])},${r(last[1])}`;
}

/** Whether a point is on a stroke, within half its width plus `slop`. */
export function hitsStroke(stroke: InkStroke, x: number, y: number, slop = 4): boolean {
  const pts = pairs(stroke.points);
  const reach = stroke.width / 2 + slop;
  if (pts.length === 1) return Math.hypot(pts[0]![0] - x, pts[0]![1] - y) <= reach;
  for (let i = 0; i + 1 < pts.length; i++) if (distanceToSegment([x, y], pts[i]!, pts[i + 1]!) <= reach) return true;
  return false;
}

/** Only `#rrggbb`, and a width a pen could have — a stroke from an imported
 *  file cannot put anything else into the page or an export. */
export function safeStroke(s: InkStroke): InkStroke | null {
  if (!Array.isArray(s.points) || s.points.length < 2 || s.points.some((v) => !Number.isFinite(v))) return null;
  return {
    id: String(s.id),
    points: s.points,
    color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#e4564a',
    width: Math.min(24, Math.max(1, Number(s.width) || 3)),
  };
}

/** The strokes as SVG markup, for the export. */
export function inkMarkup(strokes: readonly InkStroke[]): string {
  return strokes
    .map(safeStroke)
    .filter((s): s is InkStroke => s !== null)
    .map((s) => `<path d="${strokePath(s.points)}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('');
}
