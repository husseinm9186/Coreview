import { describe, expect, it } from 'vitest';

import { snapUnguided } from './gridSnap';

const v = { orientation: 'vertical' as const };
const h = { orientation: 'horizontal' as const };

describe('grid snap under the guides (LT-175)', () => {
  it('snaps both axes when no guide applies', () => {
    expect(snapUnguided({ x: 31, y: 43 }, [], [], 12)).toEqual({ x: 36, y: 48 });
  });

  it('leaves an axis an edge guide holds', () => {
    expect(snapUnguided({ x: 31, y: 30 }, [h], [], 12)).toEqual({ x: 36, y: 30 });
    expect(snapUnguided({ x: 31, y: 43 }, [v], [], 12)).toEqual({ x: 31, y: 48 });
  });

  it('leaves an axis an equal-gap rhythm holds', () => {
    expect(snapUnguided({ x: 31, y: 43 }, [], [h], 12)).toEqual({ x: 31, y: 48 });
    expect(snapUnguided({ x: 31, y: 43 }, [], [v], 12)).toEqual({ x: 36, y: 43 });
  });

  it('leaves both when both are guided', () => {
    expect(snapUnguided({ x: 31, y: 43 }, [v, h], [], 12)).toEqual({ x: 31, y: 43 });
  });
});
