/**
 * A grid that follows the zoom.
 *
 * The grid is 12 units with a major line every fifth, and at 100 % that is a
 * readable spacing. Zoomed out to a quarter the minor lines are three
 * pixels apart and the page is a grey slab; zoomed in to four times they
 * are 48 apart and the page is mostly empty. So the gap doubles or halves
 * with the zoom to keep what is on screen between 8 and 16 pixels, the
 * major line stays every fifth, and snapping snaps to whatever is drawn —
 * the grid a person sees is the grid things land on.
 */

/** The grid at 100 %: minor, and a major every `MAJOR_EVERY` minors. */
export const BASE_MINOR = 12;
export const MAJOR_EVERY = 5;

/** The smallest spacing, on screen, before the gap doubles. */
const MIN_PX = 8;

export type GridStyle = 'lines' | 'dots' | 'none';

export interface GridSpacing {
  /** The minor gap, in flow units. */
  minor: number;
  /** The major gap, in flow units: five minors. */
  major: number;
  /** How many doublings from the base: 0 at 100 %, 1 at half, −1 at twice. */
  level: number;
}

/** The grid spacing for a zoom: the base gap doubled until it is at least
 *  MIN_PX on screen, or halved while twice it still is. */
export function gridSpacing(zoom: number): GridSpacing {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  let level = 0;
  let minor = BASE_MINOR;
  while (minor * z < MIN_PX) { minor *= 2; level += 1; }
  while ((minor / 2) * z >= MIN_PX && level > -3) { minor /= 2; level -= 1; }
  return { minor, major: minor * MAJOR_EVERY, level };
}

/** The step snapping should use at this zoom: the visible minor gap. */
export function snapStep(zoom: number): number {
  return gridSpacing(zoom).minor;
}
