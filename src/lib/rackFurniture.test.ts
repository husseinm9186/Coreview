import { describe, expect, it } from 'vitest';

import { airflowOf, depthFraction, furnitureRackables, groupRacks, placeOf, placementProblem, usageOf, type Rack } from './rack';
import { FURNITURE, furnitureProblem, furnitureSpec, newFurniture } from './rackFurniture';

describe('rack furniture (LT-682, LT-686, D-065)', () => {
  it('has a default height and mounting for every kind, and a patch panel is half depth', () => {
    for (const f of FURNITURE) {
      expect(Number.isInteger(f.units)).toBe(true);
      expect(['front', 'rear']).toContain(f.face);
    }
    expect(furnitureSpec('patch-panel')).toMatchObject({ units: 1, depth: 'half', ports: 24 });
    expect(furnitureSpec('pdu-vertical').units).toBe(0);
    expect(furnitureSpec('ups').units).toBe(2);
    expect(furnitureSpec('not-a-kind' as never).kind).toBe('other');
  });

  it('a new item takes the spec, a name of its own, and a height if given', () => {
    const f = newFurniture('reserved', 'f1', ' the new core ', 4);
    expect(f).toMatchObject({ id: 'f1', kind: 'reserved', label: 'the new core', units: 4, face: 'front', depth: 'full' });
    expect(newFurniture('shelf', 'f2').label).toBe('Shelf');
    expect(newFurniture('ups', 'f3').airflow).toBe('front-to-back');
  });

  it('refuses a nameless item or a height that is not whole U', () => {
    expect(furnitureProblem({ label: ' ', units: 1 })).toMatch(/name/);
    expect(furnitureProblem({ label: 'x', units: 1.5 })).toMatch(/whole/);
    expect(furnitureProblem({ label: 'x', units: 0 })).toBeNull();
  });

  it('shares the placement rules with devices: a reservation takes its U', () => {
    const rack: Rack = { id: 'r', name: 'R1', units: 10, items: [newFurniture('reserved', 'res', 'Reserved', 2)] };
    rack.items![0]!.u = 5;
    const all = [...furnitureRackables(rack)];
    expect(placementProblem(rack, all, { id: 'sw', label: 'SW', rack: 'R1', rackUnits: 1 }, 6)).toMatch(/taken by Reserved/);
    expect(placementProblem(rack, all, { id: 'sw', label: 'SW', rack: 'R1', rackUnits: 1 }, 7)).toBeNull();
  });
});

describe('where a rack stands (LT-685)', () => {
  it('says the place in one line, skipping what is not given', () => {
    expect(placeOf({ building: 'HQ', floor: '2', room: '2.14', row: 'B', position: '03' })).toBe('HQ · Floor 2 · Room 2.14 · Row B · 03');
    expect(placeOf({ room: 'MDF' })).toBe('Room MDF');
    expect(placeOf({})).toBe('');
  });

  it('groups racks by building, floor and room, in row and position order, with the unplaced first', () => {
    const racks = [
      { name: 'Z', building: 'HQ', floor: '2', room: 'A', row: 'B', position: '2' },
      { name: 'Y', building: 'HQ', floor: '2', room: 'A', row: 'B', position: '10' },
      { name: 'X', building: 'HQ', floor: '2', room: 'A', row: 'A', position: '1' },
      { name: 'Lab' },
      { name: 'DC', building: 'DC1' },
    ];
    const groups = groupRacks(racks);
    expect(groups.map((g) => g.heading)).toEqual(['', 'DC1', 'HQ · Floor 2 · Room A']);
    expect(groups[2]!.racks.map((r) => r.name)).toEqual(['X', 'Z', 'Y']);
  });
});

describe('airflow and budgets (LT-684, LT-689)', () => {
  it('counts the ways a rack breathes and says when they fight', () => {
    const a = airflowOf([{ id: '1', label: 'a', airflow: 'front-to-back' }, { id: '2', label: 'b', airflow: 'front-to-back' }, { id: '3', label: 'c' }]);
    expect(a).toMatchObject({ frontToBack: 2, backToFront: 0, unset: 1, mixed: false });
    expect(airflowOf([{ id: '1', label: 'a', airflow: 'front-to-back' }, { id: '2', label: 'b', airflow: 'back-to-front' }]).mixed).toBe(true);
  });

  it('sums U, watts and kilograms, counting a reserved U apart and a device with no figure', () => {
    const u = usageOf({ units: 12 }, [
      { id: 'a', label: 'a', rackU: 1, rackUnits: 2, kind: 'device', powerW: 150, weightKg: 4.5 },
      { id: 'b', label: 'b', rackU: 5, rackUnits: 1, kind: 'device' },
      { id: 'r', label: 'r', rackU: 10, rackUnits: 3, kind: 'furniture', furniture: 'reserved' },
      { id: 'z', label: 'z', rackUnits: 0, kind: 'furniture', furniture: 'pdu-vertical', powerW: 0, weightKg: 3 },
    ]);
    expect(u).toEqual({ used: 3, reserved: 3, free: 6, powerW: 150, weightKg: 7.5, unknownPower: 1 });
  });
});

describe('the side view (LT-695)', () => {
  it('sizes a box against the rack: millimetres where given, most of the rack for full depth, well under half for half', () => {
    expect(depthFraction({ depthMm: 730 }, { depthMm: 1000 })).toBeCloseTo(0.73);
    expect(depthFraction({ depthMm: 730 }, { depthMm: 800 })).toBeCloseTo(0.9125);
    expect(depthFraction({ depthMm: 2000 }, {})).toBe(1);
    expect(depthFraction({ rackDepth: 'full' }, {})).toBe(0.85);
    expect(depthFraction({ rackDepth: 'half' }, {})).toBe(0.4);
    expect(depthFraction({}, {})).toBe(0.85);
  });
});
