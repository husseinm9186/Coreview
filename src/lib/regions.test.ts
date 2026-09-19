import { describe, expect, it } from 'vitest';

import { nextRegion } from './regions';

describe('F6 between regions (LT-240)', () => {
  it('moves to the next shown region, wrapping, either way', () => {
    const shown = [true, false, true, true, false];
    expect(nextRegion(shown, 0, 1)).toBe(2);
    expect(nextRegion(shown, 3, 1)).toBe(0);
    expect(nextRegion(shown, 0, -1)).toBe(3);
    expect(nextRegion(shown, -1, 1)).toBe(0);
  });
});
