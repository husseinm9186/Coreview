import { afterEach, describe, expect, it, vi } from 'vitest';

import { allPaths, pathStart, pathVersion, rankAtStart, registerPath, resetPaths } from './pathRegistry';

afterEach(() => {
  resetPaths();
  vi.useRealTimers();
});

/** The old way: walk every registered path. */
const slowRank = (id: string, d: string) => {
  let rank = 0;
  for (const [otherId, otherPath] of allPaths()) {
    if (otherId !== id && pathStart(otherPath) === pathStart(d) && otherId < id) rank += 1;
  }
  return rank;
};

describe('ranking links that leave from one point (LT-055, LT-189)', () => {
  it('agrees with walking every path, for every link', () => {
    vi.useFakeTimers();
    const paths: [string, string][] = [
      ['e3', 'M0,0L10,0L10,10'], ['e1', 'M0,0L20,0'], ['e2', 'M0,0L30,5'], ['x', 'M5,5L9,9'], ['e0', 'M0,0 C1,1 2,2 3,3'],
    ];
    for (const [id, d] of paths) registerPath(id, d);
    vi.runAllTimers();
    expect(pathVersion()).toBeGreaterThan(0);
    for (const [id, d] of paths) expect(rankAtStart(id, d), id).toBe(slowRank(id, d));
    expect(rankAtStart('e3', 'M0,0L10,0L10,10')).toBe(2);
    expect(rankAtStart('x', 'M5,5L9,9')).toBe(0);
  });

  it('re-ranks once the registry settles after a link is added', () => {
    vi.useFakeTimers();
    registerPath('b', 'M0,0L5,0');
    vi.runAllTimers();
    expect(rankAtStart('b', 'M0,0L5,0')).toBe(0);
    registerPath('a', 'M0,0L9,9');
    vi.runAllTimers();
    expect(rankAtStart('b', 'M0,0L5,0')).toBe(1);
  });
});
