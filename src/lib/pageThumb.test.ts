import { describe, expect, it } from 'vitest';

import type { TopoEdge, TopoNode } from '../state/store';
import { THUMB_MAX_NODES, thumbnailOf } from './pageThumb';

const node = (id: string, x: number, y: number, deviceType = 'switch', w = 76, h = 76) =>
  ({ id, type: 'device', position: { x, y }, width: w, height: h, data: { deviceType } }) as unknown as TopoNode;
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target }) as unknown as TopoEdge;

describe('page thumbnails (LT-183)', () => {
  it('is empty for an empty page', () => {
    expect(thumbnailOf({ nodes: [], edges: [] }, 120, 80)).toEqual({ boxes: [], lines: [], omitted: 0 });
  });

  it('fits the whole page inside the thumbnail, keeping its shape', () => {
    const t = thumbnailOf({ nodes: [node('a', 0, 0), node('b', 1924, 0)], edges: [edge('a', 'b')] }, 120, 80);
    for (const b of t.boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(120);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(80);
    }
    // Two thousand wide and 76 tall: a thin band across the middle.
    expect(t.boxes[0]!.y).toBeGreaterThan(30);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]!.y1).toBe(t.lines[0]!.y2);
  });

  it('never blows a small page up past its real size', () => {
    const t = thumbnailOf({ nodes: [node('a', 500, 500, 'switch', 40, 30)], edges: [] }, 120, 80);
    expect(t.boxes[0]!.w).toBe(40);
  });

  it('draws sections under devices and skips links to nothing', () => {
    const t = thumbnailOf({ nodes: [node('a', 20, 20), node('z', 0, 0, 'zone', 300, 200)], edges: [edge('a', 'gone')] }, 120, 80);
    expect(t.boxes.map((b) => b.zone)).toEqual([true, false]);
    expect(t.lines).toHaveLength(0);
  });

  it('stops at a limit on a huge page and says how many it left out', () => {
    const nodes = Array.from({ length: THUMB_MAX_NODES + 25 }, (_, i) => node(`n${i}`, i * 90, 0));
    const t = thumbnailOf({ nodes, edges: [] }, 120, 80);
    expect(t.boxes).toHaveLength(THUMB_MAX_NODES);
    expect(t.omitted).toBe(25);
  });
});
