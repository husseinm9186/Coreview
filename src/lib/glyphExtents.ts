/**
 * Where a link meets a glyph.
 *
 * A glyph device is a square node with the artwork inside it, and the
 * artwork rarely fills the square: a switch is a wide, low tile with air
 * above and below, a router a circle, a firewall a brick wall. A link
 * measured against the square — or the ellipse inside it — arrived in that
 * air, visibly short of the drawing. `glyphExtents.json` is each glyph's
 * real extent on its 24-grid, measured by `scripts/glyph-extents.ts`, and
 * the anchor here is where a ray from the glyph's centre towards the other
 * end crosses that extent: as an ellipse when the drawing is about as wide
 * as it is tall (a router, a cloud, an access point), as a box otherwise (a
 * switch, a server, a firewall).
 */
import type { DeviceType } from '../types/domain';
import extents from './glyphExtents.json';
import { type Anchor, type Box, centreOf } from './floatingAnchor';

export interface Extent {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GRID = 24;
const FULL: Extent = { x: 0, y: 0, w: GRID, h: GRID };

/** The glyph's extent on its 24-grid; the whole square for one not measured
 *  (an operator's own image, say). */
export function glyphExtent(type: DeviceType | string): Extent {
  return (extents as Record<string, Extent>)[type] ?? FULL;
}

/** Whether the drawing's outline is better taken as an ellipse than a box. */
export function glyphIsRound(type: DeviceType | string): boolean {
  const e = glyphExtent(type);
  const aspect = e.w / e.h;
  return aspect > 0.8 && aspect < 1.25;
}

/** The box the artwork occupies inside a node's box, in flow units. */
export function glyphBox(box: Box, type: DeviceType | string): Box {
  const e = glyphExtent(type);
  return { x: box.x + (e.x / GRID) * box.w, y: box.y + (e.y / GRID) * box.h, w: (e.w / GRID) * box.w, h: (e.h / GRID) * box.h };
}

/**
 * The anchor, normalised to the node's box, where a link towards `toward`
 * meets the glyph's own outline. It is inside the node's box when the
 * drawing is smaller than the square, which is the point.
 */
export function glyphOutlineAnchor(box: Box, type: DeviceType | string, toward: { x: number; y: number }): Anchor {
  const inner = glyphBox(box, type);
  const c = centreOf(inner);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const hw = inner.w / 2;
  const hh = inner.h / 2;
  if ((dx === 0 && dy === 0) || hw <= 0 || hh <= 0 || box.w <= 0 || box.h <= 0) return { x: 1, y: 0.5 };
  const t = glyphIsRound(type)
    ? 1 / Math.hypot(dx / hw, dy / hh)
    : Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { x: (c.x + dx * t - box.x) / box.w, y: (c.y + dy * t - box.y) / box.h };
}
