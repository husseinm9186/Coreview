import { describe, expect, it } from 'vitest';

import { hitsStroke, inkMarkup, safeStroke, simplifyStroke, strokePath } from './ink';

describe('freehand ink (LT-238)', () => {
  it('thins a stroke to the points that shape it', () => {
    const straight = [0, 0, 1, 0.2, 2, -0.1, 3, 0.1, 4, 0];
    expect(simplifyStroke(straight)).toEqual([0, 0, 4, 0]);
    const corner = [0, 0, 5, 0, 10, 0, 10, 5, 10, 10];
    expect(simplifyStroke(corner)).toEqual([0, 0, 10, 0, 10, 10]);
  });

  it('draws a smooth path, a line for two points and a dot for one', () => {
    expect(strokePath([0, 0, 10, 0, 10, 10])).toBe('M0,0Q10,0 10,5L10,10');
    expect(strokePath([0, 0, 5, 5])).toBe('M0,0L5,5');
    expect(strokePath([3, 4])).toBe('M3,4l0.1,0');
  });

  it('knows when a click is on a stroke', () => {
    const s = { id: 's', points: [0, 0, 100, 0], color: '#e4564a', width: 4 };
    expect(hitsStroke(s, 50, 5)).toBe(true);
    expect(hitsStroke(s, 50, 7)).toBe(false);
  });

  it('lets nothing but a colour and a sane width out of a stroke', () => {
    expect(safeStroke({ id: 'x', points: [0, 0, 1, 1], color: 'red" onload="x', width: 500 })).toEqual({ id: 'x', points: [0, 0, 1, 1], color: '#e4564a', width: 24 });
    expect(safeStroke({ id: 'x', points: [0, Number.NaN], color: '#000000', width: 2 })).toBeNull();
    const svg = inkMarkup([{ id: 'a', points: [0, 0, 10, 10], color: '#123456', width: 3 }]);
    expect(svg).toBe('<path d="M0,0L10,10" fill="none" stroke="#123456" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>');
  });
});
