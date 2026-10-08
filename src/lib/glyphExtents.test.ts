import { describe, expect, it } from 'vitest';

import { ICONS } from '../components/icons';
import extents from './glyphExtents.json';
import { glyphBox, glyphExtent, glyphIsRound, glyphOutlineAnchor } from './glyphExtents';

describe('the glyph extents', () => {
  it('has a measured extent for every built-in glyph, inside the 24-grid — regenerate with scripts/glyph-extents.ts when a glyph changes', () => {
    for (const type of Object.keys(ICONS)) {
      const e = (extents as Record<string, { x: number; y: number; w: number; h: number }>)[type];
      expect(e, `${type} is not in glyphExtents.json`).toBeDefined();
      expect(e!.x).toBeGreaterThanOrEqual(0);
      expect(e!.y).toBeGreaterThanOrEqual(0);
      expect(e!.x + e!.w).toBeLessThanOrEqual(24.01);
      expect(e!.y + e!.h).toBeLessThanOrEqual(24.01);
      expect(e!.w).toBeGreaterThan(4);
      expect(e!.h).toBeGreaterThan(4);
    }
    expect(glyphExtent('something-else')).toEqual({ x: 0, y: 0, w: 24, h: 24 });
  });

  it('knows a router is round and a switch is a tile', () => {
    expect(glyphIsRound('router')).toBe(true);
    expect(glyphIsRound('core-switch')).toBe(false);
    expect(glyphIsRound('access-switch')).toBe(false);
  });

  it('meets the drawing, not the square: a link from below a switch ends at the tile\'s bottom edge', () => {
    const box = { x: 100, y: 100, w: 96, h: 96 };
    const a = glyphOutlineAnchor(box, 'core-switch', { x: 148, y: 500 });
    const inner = glyphBox(box, 'core-switch');
    expect(a.x).toBeCloseTo(0.5);
    expect(a.y).toBeCloseTo((inner.y + inner.h - box.y) / box.h);
    expect(a.y).toBeLessThan(0.9);
    // From the right, the tile's right edge, which is nearly the square's.
    const r = glyphOutlineAnchor(box, 'core-switch', { x: 900, y: 148 });
    expect(r.y).toBeCloseTo(0.5);
    expect(r.x).toBeCloseTo((inner.x + inner.w - box.x) / box.w);
  });

  it('meets a round glyph on its circle, on the bearing', () => {
    const box = { x: 0, y: 0, w: 100, h: 100 };
    const a = glyphOutlineAnchor(box, 'router', { x: 500, y: 500 });
    const inner = glyphBox(box, 'router');
    const c = { x: inner.x + inner.w / 2, y: inner.y + inner.h / 2 };
    const p = { x: a.x * 100, y: a.y * 100 };
    // On the ellipse: ((px-cx)/hw)^2 + ((py-cy)/hh)^2 = 1.
    expect(((p.x - c.x) / (inner.w / 2)) ** 2 + ((p.y - c.y) / (inner.h / 2)) ** 2).toBeCloseTo(1);
    expect(p.x).toBeGreaterThan(c.x);
    expect(p.y).toBeGreaterThan(c.y);
    expect(glyphOutlineAnchor(box, 'router', { x: 50, y: 50 })).toEqual({ x: 1, y: 0.5 });
  });
});
