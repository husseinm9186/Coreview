import { describe, expect, it } from 'vitest';

import { collide, elevation, firstFreeU, placementProblem, racksFromDevices, uAt, type Rack, type Rackable } from './rack';

const rack: Rack = { id: 'r1', name: 'Rack A', units: 10 };
const box = (id: string, over: Partial<Rackable> = {}): Rackable => ({ id, label: id.toUpperCase(), rack: 'Rack A', rackUnits: 1, ...over });

describe('placing a device in a rack (LT-195)', () => {
  it('accepts a free, whole-U position that fits', () => {
    expect(placementProblem(rack, [], box('sw', { rackUnits: 2 }), 9)).toBeNull();
  });

  it('refuses a position off the top or bottom of the rack', () => {
    expect(placementProblem(rack, [], box('sw', { rackUnits: 2 }), 10)).toMatch(/does not fit at U10/);
    expect(placementProblem(rack, [], box('sw'), 0)).toMatch(/does not fit/);
  });

  it('refuses a fraction of a U', () => {
    expect(placementProblem(rack, [], box('sw'), 2.5)).toMatch(/whole U/);
  });

  it('refuses an overlap and names what is in the way', () => {
    const there = box('srv', { rackUnits: 2, rackU: 4 });
    expect(placementProblem(rack, [there], box('sw', { rackUnits: 2 }), 5)).toBe('U5–6 is taken by SRV (U4–5).');
    expect(placementProblem(rack, [there], box('sw', { rackUnits: 2 }), 6)).toBeNull();
    expect(placementProblem(rack, [there], box('sw', { rackUnits: 2 }), 2)).toBeNull();
  });

  it('lets a device move within its own space', () => {
    const self = box('srv', { rackUnits: 2, rackU: 4 });
    expect(placementProblem(rack, [self], self, 5)).toBeNull();
  });

  it('ignores devices in another rack', () => {
    expect(placementProblem(rack, [box('x', { rack: 'Rack B', rackU: 5 })], box('sw'), 5)).toBeNull();
  });

  it('refuses a device with no height', () => {
    expect(placementProblem(rack, [], box('pdu', { rackUnits: 0 }), 1)).toMatch(/no height/);
    expect(placementProblem(rack, [], box('odd', { rackUnits: undefined }), 1)).toMatch(/no height/);
  });

  it('snaps a pointer to whole U and keeps the device inside', () => {
    // 20px a U, 10U rack: 0–19px is U10, 20–39px U9.
    expect(uAt(0, 20, 10, 1)).toBe(10);
    expect(uAt(25, 20, 10, 1)).toBe(9);
    expect(uAt(25, 20, 10, 2)).toBe(8);
    expect(uAt(-50, 20, 10, 2)).toBe(9);
    expect(uAt(900, 20, 10, 3)).toBe(1);
  });

  it('finds the first free space from the top', () => {
    const devices = [box('a', { rackU: 10 }), box('b', { rackUnits: 2, rackU: 7 })];
    expect(firstFreeU(rack, devices, box('c'))).toBe(9);
    expect(firstFreeU(rack, devices, box('d', { rackUnits: 2 }))).toBe(5);
    expect(firstFreeU(rack, devices, box('e', { rackUnits: 11 }))).toBeNull();
  });
});

describe('front and rear (LT-197)', () => {
  const front = box('panel', { rackU: 5, rackDepth: 'half', rackFace: 'front' });
  const rear = box('pdu', { rackU: 5, rackDepth: 'half', rackFace: 'rear' });
  const server = box('srv', { rackU: 5 });

  it('lets two half-depth boxes share a U on opposite faces', () => {
    expect(collide(front, rear)).toBe(false);
    expect(placementProblem(rack, [front], box('pdu', { rackDepth: 'half' }), 5, 'rear')).toBeNull();
    expect(placementProblem(rack, [front], box('pdu', { rackDepth: 'half' }), 5, 'front')).toMatch(/taken by PANEL/);
  });

  it('lets nothing share a U with a full-depth box, on either face', () => {
    expect(collide(server, rear)).toBe(true);
    expect(placementProblem(rack, [server], box('pdu', { rackDepth: 'half' }), 5, 'rear')).toMatch(/taken by SRV/);
  });

  it('draws a box on the face it is mounted on, and a full-depth one from behind on the other', () => {
    const devices = [front, box('srv', { rackU: 8, rackUnits: 2 }), box('rearsw', { rackU: 3, rackFace: 'rear' })];
    const f = elevation(rack, devices, 'front');
    expect(f.items.map((i) => [i.device.id, i.seen])).toEqual([['srv', 'face'], ['panel', 'face'], ['rearsw', 'behind']]);
    const r = elevation(rack, devices, 'rear');
    expect(r.items.map((i) => [i.device.id, i.seen])).toEqual([['srv', 'behind'], ['rearsw', 'face']]);
  });

  it('lists zero-U and unplaced devices apart, and shows a clash instead of hiding it', () => {
    const devices = [box('a', { rackU: 2 }), box('copy', { rackU: 2 }), box('pdu', { rackUnits: 0 }), box('new'), box('tall', { rackU: 10, rackUnits: 2 })];
    const e = elevation(rack, devices, 'front');
    expect(e.items.filter((i) => i.clash).map((i) => i.device.id).sort()).toEqual(['a', 'copy']);
    expect(e.zeroU.map((d) => d.id)).toEqual(['pdu']);
    expect(e.unplaced.map((d) => d.id)).toEqual(['new', 'tall']);
  });
});

describe('racks from devices (LT-196)', () => {
  const ids = () => {
    let n = 0;
    return () => `rack${++n}`;
  };

  it('makes a rack for each rack name and fills it from the top', () => {
    const devices = [
      box('fw', { rack: 'DC1-R01', rackUnits: 1 }),
      box('sw', { rack: 'dc1-r01', rackUnits: 1 }),
      box('srv', { rack: 'DC1-R02', rackUnits: 2 }),
      box('cloud', { rack: '', rackUnits: 1 }),
      box('laptop', { rack: 'DC1-R02', rackUnits: undefined }),
    ];
    const got = racksFromDevices([], devices, ids());
    expect(got.racks).toEqual([
      { id: 'rack1', name: 'DC1-R01', units: 42 },
      { id: 'rack2', name: 'DC1-R02', units: 42 },
    ]);
    expect(Object.fromEntries(got.placed)).toEqual({ fw: 42, sw: 41, srv: 41 });
    expect(got.full).toEqual([]);
  });

  it('keeps valid positions and places the rest around them', () => {
    const existing: Rack = { id: 'r', name: 'Rack A', units: 4 };
    const devices = [box('keep', { rackU: 4 }), box('clash', { rackU: 4 }), box('tall', { rackUnits: 3 }), box('more', { rackUnits: 2 })];
    const got = racksFromDevices([existing], devices, ids());
    expect(got.racks).toEqual([existing]);
    // 4U: KEEP stays at U4, CLASH moves down to U3, TALL (3U) no longer fits,
    // MORE (2U) takes U1–2.
    expect(Object.fromEntries(got.placed)).toEqual({ clash: 3, more: 1 });
    expect(got.full.map((d) => d.id)).toEqual(['tall']);
  });

  it('makes a rack tall enough for what is in it', () => {
    const devices = Array.from({ length: 25 }, (_, i) => box(`b${i}`, { rack: 'Big', rackUnits: 2 }));
    expect(racksFromDevices([], devices, ids()).racks[0]!.units).toBe(50);
  });
});
