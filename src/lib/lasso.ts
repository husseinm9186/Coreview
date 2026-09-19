/**
 * Lasso selection (LT-173): a freehand outline selects what it encloses.
 *
 * "Encloses" goes by an object's middle, the rule a section already uses for
 * what stands inside it (D-012): drawn round most of a box, the box is in.
 */
import type { TopoNode } from '../state/store';

export interface Point {
  x: number;
  y: number;
}

/** Even-odd ray casting; a point on an edge may land either side. */
export function insidePolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The ids of the objects whose middles the outline encloses. An outline of
 *  fewer than three points encloses nothing. */
export function lassoed(nodes: readonly TopoNode[], outline: readonly Point[]): string[] {
  if (outline.length < 3) return [];
  return nodes
    .filter((n) => {
      const w = n.width ?? n.measured?.width ?? 76;
      const h = n.height ?? n.measured?.height ?? 76;
      return insidePolygon({ x: n.position.x + w / 2, y: n.position.y + h / 2 }, outline);
    })
    .map((n) => n.id);
}

/** Drops points closer than `step` to the last kept one, so a slow drag does
 *  not build an outline of thousands of points. */
export function addPoint(outline: Point[], p: Point, step = 4): Point[] {
  const last = outline[outline.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < step) return outline;
  return [...outline, p];
}
