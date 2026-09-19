import { describe, expect, it } from 'vitest';

import type { TopoNode } from '../state/store';
import { restack, sameOrder } from './zOrder';

const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }) as TopoNode);
const order = (list: TopoNode[]) => list.map((n) => n.id).join('');
const ids = (...x: string[]) => new Set(x);

describe('stacking order (LT-174)', () => {
  it('brings to the front and sends to the back', () => {
    expect(order(restack(nodes, ids('b'), 'front'))).toBe('acdeb');
    expect(order(restack(nodes, ids('d'), 'back'))).toBe('dabce');
  });

  it('moves one step past the next object', () => {
    expect(order(restack(nodes, ids('b'), 'forward'))).toBe('acbde');
    expect(order(restack(nodes, ids('b'), 'backward'))).toBe('bacde');
  });

  it('moves a selection as a block, keeping its own order', () => {
    expect(order(restack(nodes, ids('b', 'd'), 'front'))).toBe('acebd');
    expect(order(restack(nodes, ids('b', 'd'), 'back'))).toBe('bdace');
    expect(order(restack(nodes, ids('a', 'b'), 'forward'))).toBe('cabde');
    expect(order(restack(nodes, ids('d', 'e'), 'backward'))).toBe('abdec');
  });

  it('does nothing past the ends', () => {
    expect(sameOrder(restack(nodes, ids('e'), 'forward'), nodes)).toBe(true);
    expect(sameOrder(restack(nodes, ids('a'), 'backward'), nodes)).toBe(true);
    expect(sameOrder(restack(nodes, ids('e'), 'front'), nodes)).toBe(true);
    expect(sameOrder(restack(nodes, ids(), 'front'), nodes)).toBe(true);
  });

  it('keeps the same node objects', () => {
    const out = restack(nodes, ids('c'), 'front');
    expect(out).toContain(nodes[2]);
    expect(out).not.toBe(nodes);
  });
});
