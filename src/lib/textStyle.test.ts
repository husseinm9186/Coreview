import { describe, expect, it } from 'vitest';

import { alignedX, cssOf, isStyled, safeColour, safeSize, svgTextAttrs } from './textStyle';

describe('rich text on labels (LT-181)', () => {
  it('turns a style into CSS', () => {
    expect(cssOf({ bold: true, italic: true, size: 16, color: '#112233', background: '#ffeeaa', align: 'left' })).toEqual({
      fontWeight: 700, fontStyle: 'italic', fontSize: '16px', color: '#112233', background: '#ffeeaa',
      padding: '0 4px', borderRadius: '3px', textAlign: 'left',
    });
    expect(cssOf(undefined)).toEqual({});
  });

  it('turns the same style into SVG attributes over the label’s defaults', () => {
    expect(svgTextAttrs({ bold: true, italic: true, size: 16, color: '#112233' }, { size: 12, fill: '#000000' }))
      .toBe(' fill="#112233" font-size="16" font-weight="700" font-style="italic"');
    expect(svgTextAttrs(undefined, { size: 12, fill: '#000000', weight: 600 })).toBe(' fill="#000000" font-size="12" font-weight="600"');
  });

  it('lets nothing but a plain hex colour and a sane size through', () => {
    for (const bad of ['red', '#12', 'url(#x)', '#123456" onload="x', 'expression(1)']) expect(safeColour(bad), bad).toBeUndefined();
    expect(safeColour('#A1b2C3')).toBe('#A1b2C3');
    expect(safeSize(2)).toBe(8);
    expect(safeSize(400)).toBe(48);
    expect(safeSize(Number.NaN)).toBeUndefined();
    expect(svgTextAttrs({ color: '#123456" onload="x' }, { size: 12, fill: '#000000' })).not.toContain('onload');
  });

  it('knows an unstyled label from a styled one', () => {
    expect(isStyled(undefined)).toBe(false);
    expect(isStyled({ align: 'center' })).toBe(false);
    expect(isStyled({ color: 'nonsense' })).toBe(false);
    expect(isStyled({ italic: true })).toBe(true);
  });

  it('places aligned text against the edge of its box', () => {
    expect(alignedX('left', 100, 80)).toEqual({ x: 60, anchor: 'start' });
    expect(alignedX('right', 100, 80)).toEqual({ x: 140, anchor: 'end' });
    expect(alignedX(undefined, 100, 80)).toEqual({ x: 100, anchor: 'middle' });
  });
});
