import { describe, expect, it } from 'vitest';

import { nearestInDirection, nearestTo, type NavBox } from './spatialNav';

const box = (id: string, x: number, y: number): NavBox => ({ id, x, y, w: 76, h: 76 });

describe('keyboard movement between devices (LT-240)', () => {
  //      core
  //   a1   a2   a3
  //  far-left       aside (far right, level with core)
  const boxes = [box('core', 400, 0), box('a1', 200, 200), box('a2', 400, 200), box('a3', 600, 200), box('far-left', 0, 400), box('aside', 1400, 0)];

  it('goes to the nearest device in the direction of the arrow', () => {
    expect(nearestInDirection(boxes, 'core', 'down')).toBe('a2');
    expect(nearestInDirection(boxes, 'a2', 'left')).toBe('a1');
    expect(nearestInDirection(boxes, 'a2', 'right')).toBe('a3');
    expect(nearestInDirection(boxes, 'a2', 'up')).toBe('core');
    expect(nearestInDirection(boxes, 'core', 'right')).toBe('aside');
  });

  it('prefers straight ahead to far off to the side, and stops at the edge', () => {
    expect(nearestInDirection(boxes, 'a1', 'down')).toBe('far-left');
    expect(nearestInDirection(boxes, 'far-left', 'left')).toBeNull();
    expect(nearestInDirection(boxes, 'missing', 'left')).toBeNull();
  });

  it('starts from the device nearest a point', () => {
    expect(nearestTo(boxes, 590, 250)).toBe('a3');
    expect(nearestTo([], 0, 0)).toBeNull();
  });
});
