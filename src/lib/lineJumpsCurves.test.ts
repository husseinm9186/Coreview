import { describe, expect, it } from 'vitest';

import { jumpsFor, straightRuns, withJumps } from './lineJumps';

// LT-161: every link path type hops where links cross, not only step paths.

/** A gentle S-bend from top-left to bottom-right, as getBezierPath draws. */
const BEZIER_DOWN = 'M0,0 C0,100 200,100 200,200';
/** Its mirror, bottom-left to top-right, crossing it in the middle. */
const BEZIER_UP = 'M0,200 C0,100 200,100 200,0';
/** A straight horizontal link through the middle. */
const STRAIGHT = 'M-50,100 L250,100';

describe('line jumps on curved links (LT-161)', () => {
  it('a bezier link now has runs to cross', () => {
    const runs = straightRuns(BEZIER_DOWN);
    expect(runs.length).toBeGreaterThan(10);
    expect(runs.every((r) => r.curved)).toBe(true);
  });

  it('two crossing bezier links hop exactly once, on one of them', () => {
    const a = jumpsFor('a', BEZIER_DOWN, [['b', BEZIER_UP]]);
    const b = jumpsFor('b', BEZIER_UP, [['a', BEZIER_DOWN]]);
    expect(a.length + b.length).toBe(1);
    const hop = [...a, ...b][0]!;
    expect(hop.x).toBeCloseTo(100, 0);
    expect(hop.y).toBeCloseTo(100, 0);
  });

  it('a straight link and a bezier crossing hop once between them', () => {
    const onStraight = jumpsFor('s', STRAIGHT, [['c', BEZIER_DOWN]]);
    const onCurve = jumpsFor('c', BEZIER_DOWN, [['s', STRAIGHT]]);
    expect(onStraight.length + onCurve.length).toBe(1);
  });

  it('two links meeting at a device are not a crossing', () => {
    // Both start at the same point, as two links leaving one device do.
    const fan = 'M0,0 C100,0 200,100 300,100';
    expect(jumpsFor('a', BEZIER_DOWN, [['f', fan]])).toEqual([]);
    expect(jumpsFor('f', fan, [['a', BEZIER_DOWN]])).toEqual([]);
  });

  it('a hopped bezier is drawn with an arc and keeps its ends', () => {
    const hops = jumpsFor('c', BEZIER_DOWN, [['s', STRAIGHT]]);
    const drawnOn = hops.length ? BEZIER_DOWN : STRAIGHT;
    const theHops = hops.length ? hops : jumpsFor('s', STRAIGHT, [['c', BEZIER_DOWN]]);
    const drawn = withJumps(drawnOn, theHops, 6);
    expect(drawn).toMatch(/A6,6 0 0 1 /);
    if (drawnOn === BEZIER_DOWN) {
      expect(drawn.startsWith('M0,0')).toBe(true);
      expect(drawn.endsWith('L200,200')).toBe(true);
    }
  });

  it('a bezier with no crossings is left exactly as it was', () => {
    expect(withJumps(BEZIER_DOWN, [], 6)).toBe(BEZIER_DOWN);
    expect(jumpsFor('a', BEZIER_DOWN, [['far', 'M500,500 L600,600']])).toEqual([]);
  });

  it('a smooth-step corner still does not hop', () => {
    // An L-shaped step path with a rounded Q corner, crossed right at the
    // corner by a vertical line: the corner is skipped as before.
    const step = 'M0,0 L88,0 Q100,0 100,12 L100,200';
    const through = 'M94,-50 L94,50';
    const onStep = jumpsFor('step', step, [['v', through]]);
    expect(onStep.every((p) => p.x < 88 || p.y > 12)).toBe(true);
  });
});
