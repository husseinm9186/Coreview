/**
 * Grid snap under alignment guides (LT-175, the D-013 amendment).
 *
 * Guides stay the primary way things line up: on an axis where an edge guide
 * or an equal-gap rhythm took the position, it stands. The grid takes only the
 * axes nothing else took.
 */
export interface GuideLike {
  orientation: 'vertical' | 'horizontal';
}

export function snapUnguided(
  settled: { x: number; y: number },
  edgeGuides: readonly GuideLike[],
  spacingGuides: readonly GuideLike[],
  step: number,
): { x: number; y: number } {
  const toGrid = (v: number) => Math.round(v / step) * step;
  // An edge guide is drawn along the axis it holds still — a vertical line
  // fixes x — while a rhythm guide is drawn across the gaps it evens out, so a
  // horizontal one is an x rhythm.
  const xGuided =
    edgeGuides.some((g) => g.orientation === 'vertical') || spacingGuides.some((g) => g.orientation === 'horizontal');
  const yGuided =
    edgeGuides.some((g) => g.orientation === 'horizontal') || spacingGuides.some((g) => g.orientation === 'vertical');
  return { x: xGuided ? settled.x : toGrid(settled.x), y: yGuided ? settled.y : toGrid(settled.y) };
}
