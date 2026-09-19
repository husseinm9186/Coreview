import { describe, expect, it } from 'vitest';

import { renderDiagramSvg } from './diagram';
import { printFriendly, printGrey } from './printTheme';
import type { TopoEdge, TopoNode } from '../state/store';
import { STATUS_COLOR_LIGHT } from '../theme';

const isGrey = (hex: string) => /^#([0-9a-f]{2})\1\1$/i.test(hex);

describe('print-friendly colours (LT-194)', () => {
  it('turns paper and pale surfaces white', () => {
    expect(printGrey('#ffffff')).toBe('#ffffff');
    expect(printGrey('#eef3f8')).toBe('#ffffff');
    expect(printGrey('#f4f7fa')).toBe('#ffffff');
  });

  it('keeps dark ink dark and grey', () => {
    const ink = printGrey('#0d1722');
    expect(isGrey(ink)).toBe(true);
    expect(parseInt(ink.slice(1, 3), 16)).toBeLessThan(40);
  });

  it('turns every status colour into a grey dark enough for a white glyph', () => {
    for (const [status, colour] of Object.entries(STATUS_COLOR_LIGHT)) {
      const g = printGrey(colour);
      expect(isGrey(g), `${status} ${colour} -> ${g}`).toBe(true);
      if (g !== '#ffffff') expect(parseInt(g.slice(1, 3), 16), status).toBeLessThanOrEqual(128);
    }
  });

  it('handles short hex and leaves what is not a colour alone', () => {
    expect(isGrey(printGrey('#f00'))).toBe(true);
    expect(printGrey('none')).toBe('none');
    expect(printFriendly('<a href="#frag">x</a><rect fill="#0b5fce"/>')).toBe('<a href="#frag">x</a><rect fill="#2f2f2f"/>'.replace('#2f2f2f', printGrey('#0b5fce')));
  });
});

describe('the print-friendly export', () => {
  const node = (id: string, x: number): TopoNode =>
    ({
      id, type: 'device', position: { x, y: 0 }, width: 176, height: 96,
      data: { label: `Device ${id}`, deviceType: 'firewall', tags: [], addresses: [], locked: false, maintenance: false, showDetails: true },
    }) as TopoNode;
  const link = {
    id: 'e', source: 'a', target: 'b', sourceHandle: 'r', targetHandle: 'l',
    data: { sourcePortLabel: '', targetPortLabel: '', label: 'Uplink', pathType: 'straight', direction: 'none', width: 2,
      color: '#2fbf6b', enabled: true, maintenance: false, healthRule: { type: 'manual' } },
  } as TopoEdge;
  const render = (print: boolean, ground: 'dark' | 'light' = 'dark') =>
    renderDiagramSvg({
      meta: { id: 'p', name: 'P', customer: '', site: '', ticket: '', engineer: '', description: '', createdAt: 0, updatedAt: 0, archived: false },
      nodes: [node('a', 0), node('b', 400)], edges: [link],
      nodeStatus: (id) => (id === 'a' ? 'down' : 'healthy'), linkStatus: () => 'down',
      includeTitleBlock: true, nodeStyle: 'card', ground, print, now: new Date(0),
    });

  it('uses only greys, on white, even from the dark ground', () => {
    const svg = render(true, 'dark');
    const colours = svg.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(colours.length).toBeGreaterThan(5);
    expect(colours.filter((c) => !isGrey(c))).toEqual([]);
    expect(svg).toMatch(/<rect width="100%" height="100%" fill="#ffffff"\/>/);
  });

  it('still says each status in words and glyphs, not colour alone', () => {
    const svg = render(true);
    expect(svg).toContain('✕');
    expect(svg).toContain('✓');
    expect(svg).toContain('Uplink');
  });

  it('keys each status in the legend by its glyph, not only a dot of colour', () => {
    const svg = render(true);
    for (const glyph of ['✓', '!', '✕', '?', '⚙']) {
      expect(svg, glyph).toMatch(new RegExp(`<circle[^>]*r="6"[^>]*/><text[^>]*>${glyph.replace('?', '\\?')}</text>`));
    }
  });

  it('leaves an ordinary export in colour', () => {
    const colours = render(false, 'light').match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(colours.some((c) => !isGrey(c))).toBe(true);
  });
});
