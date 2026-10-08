import { describe, expect, it } from 'vitest';

import { PRINT_ACTUAL_ZOOM, UNITS_PER_MM, marginRect, pageRectFor, rulerScale, rulerTicks } from './pageSize';

describe('the page as paper', () => {
  it('turns a preset into a sheet in units, 144 to the inch', () => {
    expect(pageRectFor('a4', 'portrait', { x: 0, y: 0 })).toEqual({ x: 0, y: 0, w: 1191, h: 1684 });
    expect(pageRectFor('a4', 'landscape', { x: 60, y: -120 })).toEqual({ x: 60, y: -120, w: 1684, h: 1191 });
    expect(pageRectFor('letter', 'landscape', { x: 0, y: 0 })).toEqual({ x: 0, y: 0, w: 1584, h: 1224 });
    expect(pageRectFor('tabloid', 'portrait', { x: 0, y: 0 })).toEqual({ x: 0, y: 0, w: 1584, h: 2448 });
  });

  it('draws the 10 mm margin inside the sheet', () => {
    const m = marginRect({ x: 0, y: 0, w: 1191, h: 1684 });
    expect(m.x).toBeCloseTo(10 * UNITS_PER_MM);
    expect(m.w).toBeCloseTo(1191 - 20 * UNITS_PER_MM);
  });

  it('prints one unit at 1/144 inch', () => {
    expect(PRINT_ACTUAL_ZOOM).toBeCloseTo(2 / 3);
  });

  it('picks a ruler step the zoom can show: 10 mm at 100 %, 50 mm at a quarter, 5 mm at four times', () => {
    expect(rulerScale(1, 'mm').major).toBeCloseTo(10 * UNITS_PER_MM);
    expect(rulerScale(1, 'mm').minor).toBeCloseTo(2 * UNITS_PER_MM);
    expect(rulerScale(0.25, 'mm').major).toBeCloseTo(50 * UNITS_PER_MM);
    expect(rulerScale(4, 'mm').major).toBeCloseTo(5 * UNITS_PER_MM);
    expect(rulerScale(10, 'mm').major).toBeCloseTo(1 * UNITS_PER_MM);
    // A labelled step is at least 48 px, so its fifths are never under 5 px:
    // the small ticks are always there.
    for (const z of [0.05, 0.3, 1, 4, 20]) expect(rulerScale(z, 'mm').minor * z).toBeGreaterThanOrEqual(5);
    expect(rulerScale(1, 'in').major).toBe(72); // half an inch at 100 %
    expect(rulerScale(1, 'in').label(2)).toBe('1″');
    expect(rulerScale(1, 'mm').label(3)).toBe('30');
  });

  it('lists the ticks across a range from the page\'s corner, labelled on the majors', () => {
    const scale = rulerScale(1, 'mm');
    const ticks = rulerTicks(-20, 80, 0, scale);
    const majors = ticks.filter((t) => t.major);
    expect(majors.map((t) => t.label)).toEqual(['0', '10']);
    expect(majors[0]!.at).toBe(0);
    expect(ticks.filter((t) => !t.major).length).toBeGreaterThan(4);
    // The origin is the page's corner, not the world's.
    expect(rulerTicks(100, 200, 100, scale).find((t) => t.label === '0')?.at).toBe(100);
  });
});
