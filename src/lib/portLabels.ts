/**
 * Where a port label sits on its link.
 *
 * Beside the line, not on it, a fixed distance from the end it belongs to —
 * how ports are labelled on a drawn diagram — and past the device's own
 * name when the link leaves downward through it: on a tiered diagram a
 * glyph's name hangs below it, straight across the path of every link to
 * the tier beneath, and a label a third of the way along landed on top of
 * it. Parallel cables out of one end are ranked and each rank goes a
 * chip-length further along, so two chips never share a spot.
 * Shared by the canvas and the export so both place them the same.
 */

export interface ChipInput {
  /** The link's drawn length. */
  len: number;
  /** This link's rank among those leaving the same point, 0 first. */
  rank: number;
  /** The end's y and the unit direction the path leaves it in. */
  endY: number;
  dirY: number;
  /** Where the device's name block ends below the end, or null when the
   *  device has none in the way (a card, a shape, a link leaving sideways). */
  nameBottom: number | null;
  /** The centre label's width, 0 when there is none. */
  centreW: number;
  /** This chip's own width. */
  chipW: number;
}

export interface ChipPlace {
  /** Distance along the path from this end. */
  along: number;
  /** Perpendicular offset of the chip's centre from the line. */
  off: number;
}

/** A glyph's name block height, in flow units, from what it shows: the name,
 *  then the address and the status when details are on, and a maintenance
 *  line. The canvas sets them at 12 and 10 px with line-height 1.35. */
export function nameBlockHeight(d: { showDetails?: boolean; maintenance?: boolean; addresses?: readonly { address?: string }[]; label?: string }): number {
  let h = 6 + 16; // the gap under the glyph, then the name line
  if (d.showDetails) {
    if (d.addresses?.some((a) => a.address && a.address !== d.label)) h += 14;
    h += 14; // the status line
    if (d.maintenance) h += 14;
  }
  return h;
}

/** A chip's width from its text: the mono face at 10 px, plus the padding. */
export function chipWidthOf(text: string): number {
  return text.length * 6.4 + 12;
}

export function placePortChip(c: ChipInput): ChipPlace {
  // A chip-length per rank, or neighbouring chips still overlap; capped so a
  // short link's chip stays on its own half.
  let along = Math.min(46 + c.rank * 66, c.len * (0.4 - 0.08 * Math.min(c.rank, 3)));
  // Leaving downward through the name: past it, with a little air, but never
  // beyond the middle, where it would be the other end's.
  if (c.nameBottom !== null && c.dirY > 0.5) {
    const clear = (c.nameBottom + 8 - c.endY) / c.dirY;
    along = Math.max(along, Math.min(clear, c.len * 0.5));
  }
  let off = c.chipW / 2 + 6;
  // Level with the centre label, step outside it rather than under it.
  if (c.centreW > 0 && Math.abs(along - c.len / 2) < 14) off = c.centreW / 2 + c.chipW / 2 + 6;
  return { along, off };
}

/**
 * Where the centre label goes when nothing has moved it: the middle, unless
 * the middle of a short link down from a glyph is inside that glyph's name
 * block — two tiers a hand apart put the cable tag straight over the name
 * above it. Then it slides down past the name, never beyond three quarters,
 * where it would be the other end's business. A fraction of the length.
 */
export function centreLabelFraction(c: { len: number; endY: number; dirY: number; nameBottom: number | null }): number {
  if (c.nameBottom === null || c.dirY <= 0.5 || c.len <= 0) return 0.5;
  const clear = (c.nameBottom + 10 - c.endY) / c.dirY;
  const f = clear / c.len;
  return f > 0.5 ? Math.min(0.75, f) : 0.5;
}
