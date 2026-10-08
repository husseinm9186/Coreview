import { describe, expect, it } from 'vitest';

import { gridSpacing, snapStep } from './gridScale';

describe('a grid that follows the zoom', () => {
  it('is 12 and 60 at 100 %', () => {
    expect(gridSpacing(1)).toEqual({ minor: 12, major: 60, level: 0 });
  });

  it('doubles as the zoom falls so the lines stay at least 8 px apart on screen', () => {
    expect(gridSpacing(0.5)).toEqual({ minor: 24, major: 120, level: 1 });
    expect(gridSpacing(0.25)).toEqual({ minor: 48, major: 240, level: 2 });
    expect(gridSpacing(0.1)).toEqual({ minor: 96, major: 480, level: 3 });
    // Never under 8 px, never 16 or over, across the whole range.
    // Up to the finest level; past it the gap is held at 1.5 (below).
    for (let z = 0.02; z <= 10; z *= 1.17) {
      const px = gridSpacing(z).minor * z;
      expect(px).toBeGreaterThanOrEqual(8);
      expect(px).toBeLessThan(16);
    }
  });

  it('halves as the zoom rises, to a limit, and the major stays every fifth', () => {
    expect(gridSpacing(2)).toEqual({ minor: 6, major: 30, level: -1 });
    expect(gridSpacing(4)).toEqual({ minor: 3, major: 15, level: -2 });
    expect(gridSpacing(8)).toEqual({ minor: 1.5, major: 7.5, level: -3 });
    expect(gridSpacing(40).minor).toBe(1.5);
  });

  it('snaps to the gap that is drawn, and shrugs at nonsense', () => {
    expect(snapStep(1)).toBe(12);
    expect(snapStep(0.3)).toBe(48);
    expect(gridSpacing(NaN)).toEqual(gridSpacing(1));
    expect(gridSpacing(0)).toEqual(gridSpacing(1));
  });
});
