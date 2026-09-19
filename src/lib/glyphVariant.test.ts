import { describe, expect, it } from 'vitest';

import { inkOn } from '../theme';
import { glyphMarkup } from './glyphSvg';
import { renderDiagramSvg } from './diagram';
import type { TopoNode } from '../state/store';

describe('solid glyphs (LT-168)', () => {
  it('pick ink that reads on the fill', () => {
    expect(inkOn('#fbbf24')).toBe('#0b1220'); // light amber: dark ink
    expect(inkOn('#0b5fce')).toBe('#ffffff'); // deep blue: white ink
    expect(inkOn('not a colour')).toBe('#ffffff');
  });

  it('draw a filled tile with the glyph in ink, and no stray currentColor', () => {
    const solid = glyphMarkup('router', '#0b5fce', false, true);
    expect(solid).toContain('data-solid');
    expect(solid).toContain('fill="#0b5fce"');
    expect(solid).toContain('stroke="#ffffff"');
    expect(solid).not.toContain('currentColor');
    const outline = glyphMarkup('router', '#0b5fce');
    expect(outline).not.toContain('data-solid');
    expect(outline).toContain('stroke="#0b5fce"');
  });

  it('combine with the stacked glyph', () => {
    const both = glyphMarkup('access-switch', '#fbbf24', true, true);
    expect(both).toContain('data-solid');
    expect(both).toContain('data-stacked');
    expect(both).toContain('stroke="#0b1220"');
  });

  const device = (id: string, x: number, style?: Record<string, string>): TopoNode =>
    ({
      id, type: 'device', position: { x, y: 0 }, width: 76, height: 76,
      data: { label: id, deviceType: 'router', tags: [], addresses: [], locked: false, maintenance: false,
        showDetails: false, ...(style ? { style } : {}) },
    }) as TopoNode;
  const render = (nodes: TopoNode[], glyphVariant?: 'outline' | 'solid') =>
    renderDiagramSvg({
      meta: { id: 'p', name: 'P', customer: '', site: '', ticket: '', engineer: '', description: '', createdAt: 0,
        updatedAt: 0, archived: false },
      nodes, edges: [], nodeStatus: () => 'unknown', linkStatus: () => 'unknown', includeTitleBlock: false,
      nodeStyle: 'glyph', glyphVariant, now: new Date(0),
    });
  const solids = (svg: string) => (svg.match(/data-solid/g) ?? []).length;

  it('follow the page in export, and a device may override it either way', () => {
    expect(solids(render([device('a', 0), device('b', 200)]))).toBe(0);
    expect(solids(render([device('a', 0), device('b', 200)], 'solid'))).toBe(2);
    expect(solids(render([device('a', 0, { glyphVariant: 'outline' }), device('b', 200)], 'solid'))).toBe(1);
    expect(solids(render([device('a', 0, { glyphVariant: 'solid' }), device('b', 200)]))).toBe(1);
  });
});
