import { describe, expect, it } from 'vitest';

import type { Rack, Rackable } from './rack';
import { closeGapsPlan, layoutOf, pastePlan, shiftPlan } from './rackLayout';

const rack: Rack = { id: 'r1', name: 'R1', units: 12, items: [{ id: 'f1', kind: 'patch-panel', label: 'PP-1', units: 1, u: 12, powerFeeds: [{ pduId: 'p', outlet: 1 }] }, { id: 'f2', kind: 'shelf', label: 'Shelf', units: 2 }] };
const box = (id: string, u: number, units = 1): Rackable => ({ id, label: id.toUpperCase(), rack: 'R1', rackU: u, rackUnits: units, kind: 'device', deviceType: 'server' });

describe('moving several boxes together', () => {
  it('shifts the chosen boxes as one, through each other but not into anything else', () => {
    const all = [box('a', 10), box('b', 9), box('c', 5)];
    expect(shiftPlan(rack, all, ['a', 'b'], -1)).toEqual({ moves: [{ id: 'a', u: 9 }, { id: 'b', u: 8 }] });
    // Down three would put b on c.
    expect(shiftPlan(rack, all, ['a', 'b'], -4)).toMatchObject({ problem: expect.stringMatching(/^B: .*taken by C/) });
    // Up past the top.
    expect(shiftPlan(rack, all, ['a'], 3)).toMatchObject({ problem: expect.stringMatching(/^A: /) });
    expect(shiftPlan(rack, all, ['zzz'], 1)).toEqual({ problem: 'Nothing placed is chosen.' });
  });

  it('closes the gaps under the highest chosen box, and stops at what is not chosen', () => {
    const all = [box('a', 11, 2), box('b', 9), box('c', 3, 2)];
    expect(closeGapsPlan(rack, all, ['a', 'b', 'c'])).toEqual({ moves: [{ id: 'b', u: 10 }, { id: 'c', u: 8 }] });
    // b, at U9, is in the way of packing c under a.
    expect(closeGapsPlan(rack, all, ['a', 'c'])).toMatchObject({ problem: expect.stringMatching(/^C: .*taken by B/) });
    expect(closeGapsPlan(rack, all, ['a'])).toEqual({ problem: 'Choose two or more boxes in one rack.' });
  });
});

describe('a rack\'s layout, copied', () => {
  it('carries the furniture without ids or feeds', () => {
    const layout = layoutOf(rack);
    expect(layout).toEqual({ from: 'R1', units: 12, items: [{ kind: 'patch-panel', label: 'PP-1', units: 1, u: 12 }, { kind: 'shelf', label: 'Shelf', units: 2 }] });
  });

  it('pastes into another rack at the same U where free, else unplaced', () => {
    const layout = layoutOf(rack);
    const other: Rack = { id: 'r2', name: 'R2', units: 12 };
    const free = pastePlan(other, [], layout, ['n1', 'n2']);
    expect(free.items.map((f) => [f.id, f.u])).toEqual([['n1', 12], ['n2', undefined]]);
    expect([free.placed, free.left]).toEqual([1, 0]);
    const busy = pastePlan(other, [{ ...box('x', 12), rack: 'R2' }], layout, ['n1', 'n2']);
    expect(busy.items[0]!.u).toBeUndefined();
    expect([busy.placed, busy.left]).toEqual([0, 1]);
  });
});
