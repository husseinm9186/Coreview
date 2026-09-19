import { describe, expect, it } from 'vitest';

import { drawioFile } from './drawio';
import type { TopoEdge, TopoNode } from '../state/store';

const device = (id: string, x: number, deviceType: string, label: string, address?: string): TopoNode =>
  ({
    id, type: 'device', position: { x, y: 100 }, width: 76, height: 76,
    data: { label, deviceType, tags: [], addresses: address ? [{ id: 'a', label: 'Mgmt', address, isPrimary: true }] : [], locked: false, maintenance: false },
  }) as unknown as TopoNode;

const link = (id: string, source: string, target: string, over: Record<string, unknown> = {}): TopoEdge =>
  ({ id, source, target, data: { sourcePortLabel: 'Gi0/1', targetPortLabel: 'Gi1/0/1', label: '', colorMode: 'fixed', color: '#0070c0', ...over } }) as unknown as TopoEdge;

const parse = (xml: string) => new DOMParserish(xml);

/** Enough of an XML reader for the assertions, without a DOM. */
class DOMParserish {
  constructor(private xml: string) {}
  all(tag: string) {
    return [...this.xml.matchAll(new RegExp(`<${tag}\\b([^>]*?)/?>`, 'g'))].map((m) => Object.fromEntries([...m[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));
  }
}

describe('draw.io export (LT-250)', () => {
  const file = drawioFile(
    [
      { name: 'Core & edge', nodes: [device('n1', 0, 'router', 'EDGE-RTR1', '192.0.2.1'), device('n2', 300, 'l3-switch', 'CORE-SW1')], edges: [link('e1', 'n1', 'n2', { waypoints: [{ x: 40, y: 20 }, { x: 340, y: 20 }] })] },
      { name: 'Branch', nodes: [device('n1', 0, 'rectangle', 'Room <1>')], edges: [link('e2', 'n1', 'ghost')] },
    ],
    new Date(0),
  );
  const doc = parse(file);

  it('writes one diagram per page, named, with ids unique across the file', () => {
    expect(file.startsWith('<?xml')).toBe(true);
    expect(doc.all('diagram').map((d) => d.name)).toEqual(['Core &amp; edge', 'Branch']);
    const ids = doc.all('mxCell').map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('draws devices as draw.io network stencils with the address under the name', () => {
    const cells = doc.all('mxCell');
    const rtr = cells.find((c) => c.value?.startsWith('EDGE-RTR1'))!;
    expect(rtr.value).toBe('EDGE-RTR1&#10;192.0.2.1');
    expect(rtr.style).toContain('shape=mxgraph.networks.router;');
    expect(cells.find((c) => c.value === 'CORE-SW1')!.style).toContain('shape=mxgraph.networks.switch;');
    expect(cells.find((c) => c.value === 'Room &lt;1&gt;')!.style).toMatch(/^rounded=0;/);
  });

  it('glues links to both ends, keeps bends and colour, and names the ports as a pair', () => {
    const edges = doc.all('mxCell').filter((c) => c.edge === '1');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ value: 'Gi0/1 &lt;&gt; Gi1/0/1' });
    expect(edges[0]!.style).toContain('strokeColor=#0070c0;');
    expect(file).toContain('<Array as="points"><mxPoint x="40" y="20"/><mxPoint x="340" y="20"/></Array>');
  });
});
