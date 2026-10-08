import { describe, expect, it } from 'vitest';

import { AISLE_MM, airBands, floorBounds, floorSvg, footprintBox, footprintsFor, numberAsTheyStand, snapFloor } from './floorPlan';
import type { Rack } from './rack';

const rack = (id: string, row: string, position: string, extra: Partial<Rack> = {}): Rack => ({ id, name: id.toUpperCase(), units: 42, row, position, ...extra });

describe('the floor', () => {
  it('stands racks in their rows, shoulder to shoulder, an aisle apart, facing each other across it', () => {
    const fps = footprintsFor([rack('b2', 'B', '02'), rack('a1', 'A', '01'), rack('a2', 'A', '02'), rack('b1', 'B', '01', { widthMm: 800 })]);
    expect(fps.map((f) => f.rack.id)).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(fps[0]).toMatchObject({ x: 0, y: 0, w: 600, h: 1000, facing: 's', placed: false });
    expect(fps[1]).toMatchObject({ x: 600, y: 0 });
    expect(fps[2]).toMatchObject({ x: 0, y: 1000 + AISLE_MM, w: 800, facing: 'n' });
    expect(fps[3]).toMatchObject({ x: 800, y: 1000 + AISLE_MM });
  });

  it('keeps a rack where it was put, and turns its box with its facing', () => {
    const fps = footprintsFor([rack('a1', 'A', '01', { floorX: 3000, floorY: 400, facing: 'e' })]);
    expect(fps[0]).toMatchObject({ x: 3000, y: 400, placed: true, facing: 'e' });
    expect(footprintBox(fps[0]!)).toEqual({ x: 3000, y: 400, w: 1000, h: 600 });
  });

  it('shades the air: cold in front and hot behind for front-to-back, the other way round for back-to-front, mixed for both, none for none', () => {
    const [fp] = footprintsFor([rack('a1', 'A', '01')]);
    const bands = airBands(fp!, { frontToBack: 3, backToFront: 0 });
    expect(bands).toEqual([
      { kind: 'cold', x: 0, y: 1000, w: 600, h: 600 },
      { kind: 'hot', x: 0, y: -600, w: 600, h: 600 },
    ]);
    expect(airBands(fp!, { frontToBack: 0, backToFront: 1 }).map((b) => b.kind)).toEqual(['hot', 'cold']);
    expect(airBands(fp!, { frontToBack: 1, backToFront: 1 }).map((b) => b.kind)).toEqual(['mixed', 'mixed']);
    expect(airBands(fp!, { frontToBack: 0, backToFront: 0 })).toEqual([]);
    const [north] = footprintsFor([rack('n', 'B', '01', { facing: 'n' })]);
    expect(airBands(north!, { frontToBack: 1, backToFront: 0 })[0]!.y).toBe(-600);
  });

  it('reads rows and positions back off the floor', () => {
    const fps = footprintsFor([
      rack('x', 'Q', '09', { floorX: 1200, floorY: 0 }),
      rack('y', 'Q', '08', { floorX: 0, floorY: 300 }),
      rack('z', 'Z', '01', { floorX: 600, floorY: 2500 }),
    ]);
    expect(numberAsTheyStand(fps)).toEqual([
      { id: 'y', row: 'A', position: '01' },
      { id: 'x', row: 'A', position: '02' },
      { id: 'z', row: 'B', position: '01' },
    ]);
    expect(snapFloor(1249)).toBe(1200);
    expect(snapFloor(1250)).toBe(1300);
  });

  it('draws the floor as an SVG with a metre grid, the air, each rack named with its front marked, and a legend', () => {
    const fps = footprintsFor([rack('a1', 'A', '01'), rack('b1', 'B', '01')]);
    const svg = floorSvg('HQ · Floor 2 · Room 2.14', fps, (r) => (r.id === 'a1' ? { frontToBack: 2, backToFront: 0 } : { frontToBack: 0, backToFront: 0 }));
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('HQ · Floor 2 · Room 2.14');
    expect(svg).toContain('>A1<');
    expect(svg).toContain('>B1<');
    expect(svg).toContain('Row A · 01');
    expect((svg.match(/fill="#bfe0ff"/g) ?? []).length).toBe(2); // the cold band and the legend's swatch
    expect(svg).toContain('stroke-width="3.5"');
    const b = floorBounds(fps);
    expect(b).toEqual({ x: -1000, y: -1000, w: 2600, h: 5200 });
  });
});
