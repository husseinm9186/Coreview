import { describe, expect, it } from 'vitest';

import { DEFAULT_DOCK_SIDE, dockSideFor, dockWidthClass } from './dockPlacement';

describe('dockSideFor', () => {
  it('opens discovering devices and the terminal down the right', () => {
    expect(dockSideFor('crawl', {})).toBe('right');
    expect(dockSideFor('discover', {})).toBe('right');
    expect(dockSideFor('ssh', {})).toBe('right');
  });

  it('keeps the wide tables along the bottom', () => {
    for (const tab of ['objects', 'events', 'trace', 'path', 'tracert', 'whereis', 'backup'] as const) {
      expect(dockSideFor(tab, {})).toBe('bottom');
    }
  });

  it('lets an override win, per tab', () => {
    expect(dockSideFor('crawl', { crawl: 'bottom' })).toBe('bottom');
    expect(dockSideFor('objects', { objects: 'right' })).toBe('right');
    // An override on one tab does not move another.
    expect(dockSideFor('ssh', { crawl: 'bottom' })).toBe('right');
  });
});

describe('dockWidthClass', () => {
  it('gives the terminal half the window and discovery a narrow column', () => {
    expect(dockWidthClass('ssh')).toBe('is-dock-wide');
    expect(dockWidthClass('crawl')).toBe('is-dock-narrow');
    expect(dockWidthClass('discover')).toBe('is-dock-narrow');
  });
});

describe('the defaults', () => {
  it('names only the three that open on the right', () => {
    expect(Object.keys(DEFAULT_DOCK_SIDE).sort()).toEqual(['crawl', 'discover', 'ssh']);
  });
});
