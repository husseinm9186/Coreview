import { describe, expect, it } from 'vitest';

import { glyphMarkup } from './glyphSvg';
import { drawsStacked } from './stacked';

describe('which devices draw the stacked glyph (LT-159, LT-160)', () => {
  it('a stack or chassis pair discovery reported', () => {
    expect(drawsStacked({ stackKind: 'StackWise' })).toBe(true);
    expect(drawsStacked({ stackMembers: '1 active FOC0000TEST' })).toBe(true);
  });

  it('a device someone marked HA, whatever it is', () => {
    expect(drawsStacked({ ha: true })).toBe(true);
  });

  it('not a single device, nor one whose stack fields were cleared', () => {
    expect(drawsStacked({})).toBe(false);
    expect(drawsStacked({ ha: false })).toBe(false);
    expect(drawsStacked({ stackKind: '  ', stackMembers: '' })).toBe(false);
  });

  it('not one half of a chassis pair drawn as two switches, unless marked HA', () => {
    expect(drawsStacked({ stackKind: 'VSS', stackMembers: '1\n2', stackSplit: true })).toBe(false);
    expect(drawsStacked({ stackKind: 'VSS', stackSplit: true, ha: true })).toBe(true);
  });
});

describe('the stacked glyph as markup', () => {
  it('draws the glyph twice, the one behind masked by the one in front', () => {
    const single = glyphMarkup('access-switch', '#123456');
    const stacked = glyphMarkup('access-switch', '#123456', true);
    expect(single).not.toContain('data-stacked');
    expect(stacked).toContain('data-stacked');
    // The chassis body: behind, in front, and once more as the mask's shape.
    expect(stacked.match(/<rect x="2" y="8"/g)).toHaveLength(3);
    expect(stacked).toContain('mask="url(#cv-stacked-access-switch)"');
    expect(stacked).toContain('<mask id="cv-stacked-access-switch"');
    expect(stacked).not.toContain('currentColor');
    expect(stacked).toContain('#123456');
  });
});
