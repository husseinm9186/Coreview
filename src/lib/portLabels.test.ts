import { describe, expect, it } from 'vitest';

import { centreLabelFraction, chipWidthOf, nameBlockHeight, placePortChip } from './portLabels';

describe('where a port label sits', () => {
  it('is beside the line, a fixed way along, further for each parallel cable', () => {
    const a = placePortChip({ len: 400, rank: 0, endY: 0, dirY: 0, nameBottom: null, centreW: 0, chipW: 60 });
    expect(a).toEqual({ along: 46, off: 36 });
    const b = placePortChip({ len: 400, rank: 1, endY: 0, dirY: 0, nameBottom: null, centreW: 0, chipW: 60 });
    expect(b.along).toBe(112);
    // A short link keeps the chip on its own half.
    expect(placePortChip({ len: 90, rank: 0, endY: 0, dirY: 0, nameBottom: null, centreW: 0, chipW: 60 }).along).toBe(36);
  });

  it('clears the device\'s name when the link leaves downward through it', () => {
    // The glyph ends at y=63 (the tile's bottom), the name block ends at 110.
    const p = placePortChip({ len: 180, rank: 0, endY: 63, dirY: 1, nameBottom: 110, centreW: 0, chipW: 60 });
    expect(p.along).toBe(55); // 110 + 8 - 63
    // Sideways, the name is not in the way.
    expect(placePortChip({ len: 180, rank: 0, endY: 63, dirY: 0, nameBottom: 110, centreW: 0, chipW: 60 }).along).toBe(46);
    // On a very short link the name is unavoidable: the middle is the limit.
    expect(placePortChip({ len: 80, rank: 0, endY: 63, dirY: 1, nameBottom: 110, centreW: 0, chipW: 60 }).along).toBe(40);
  });

  it('steps outside the centre label when level with it', () => {
    const p = placePortChip({ len: 100, rank: 0, endY: 0, dirY: 1, nameBottom: 40, centreW: 90, chipW: 60 });
    expect(p.along).toBe(48);
    expect(p.off).toBe(45 + 30 + 6);
  });

  it('slides the centre label down past a name the middle would sit on, and not otherwise', () => {
    // A 110-long link down from a glyph whose name block ends 66 below the top; the link leaves at 2.7.
    expect(centreLabelFraction({ len: 110, endY: 2.7, dirY: 1, nameBottom: 66 })).toBeCloseTo(0.666);
    expect(centreLabelFraction({ len: 400, endY: 2.7, dirY: 1, nameBottom: 66 })).toBe(0.5);
    expect(centreLabelFraction({ len: 110, endY: 2.7, dirY: 0, nameBottom: 66 })).toBe(0.5);
    expect(centreLabelFraction({ len: 110, endY: 2.7, dirY: 1, nameBottom: null })).toBe(0.5);
    // Never past three quarters.
    expect(centreLabelFraction({ len: 80, endY: 2.7, dirY: 1, nameBottom: 66 })).toBe(0.75);
  });

  it('knows the name block from what the glyph shows', () => {
    expect(nameBlockHeight({ label: 'SW' })).toBe(22);
    expect(nameBlockHeight({ label: 'SW', showDetails: true })).toBe(36);
    expect(nameBlockHeight({ label: 'SW', showDetails: true, addresses: [{ address: '192.0.2.1' }] })).toBe(50);
    expect(nameBlockHeight({ label: 'SW', showDetails: true, addresses: [{ address: '192.0.2.1' }], maintenance: true })).toBe(64);
    expect(chipWidthOf('Gi1/0/48')).toBeCloseTo(63.2);
  });
});
