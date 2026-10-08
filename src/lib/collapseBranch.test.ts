import { describe, expect, it } from 'vitest';

import { collapseLabel, foldedCount, hiddenByAll, hiddenByCollapsing, worthCollapsing } from './collapseBranch';
import type { TopoEdge, TopoNode } from '../state/store';

/** A device as the diagram actually holds one — with its type, which is what
 *  tells the hierarchy which way is up. */
const node = (id: string, deviceType = 'endpoint'): TopoNode =>
  ({ id, type: 'device', position: { x: 0, y: 0 }, data: { label: id, deviceType } }) as unknown as TopoNode;

const link = (a: string, b: string): TopoEdge => ({ id: `${a}-${b}`, source: a, target: b }) as TopoEdge;

/**
 * The operator's shape: a core, two distribution switches, access points
 * under each, and a firewall above the core.
 *
 *            fw
 *            |
 *           core
 *          /    \
 *      dist1     dist2
 *      /   \       |
 *    ap1   ap2    ap3
 */
const nodes = [
  node('fw', 'firewall'),
  node('core', 'core-switch'),
  node('dist1', 'distribution-switch'),
  node('dist2', 'distribution-switch'),
  node('ap1', 'access-point'),
  node('ap2', 'access-point'),
  node('ap3', 'access-point'),
];
const edges = [
  link('fw', 'core'),
  link('core', 'dist1'),
  link('core', 'dist2'),
  link('dist1', 'ap1'),
  link('dist1', 'ap2'),
  link('dist2', 'ap3'),
];

describe('collapsing a branch', () => {
  it('folds what hangs below, and nothing above', () => {
    // The whole point: collapsing an access switch must not swallow the core.
    expect([...hiddenByCollapsing('dist1', nodes, edges)].sort()).toEqual(['ap1', 'ap2']);
    expect([...hiddenByCollapsing('dist2', nodes, edges)].sort()).toEqual(['ap3']);
  });

  it('keeps the collapsed device itself on the page', () => {
    expect(hiddenByCollapsing('dist1', nodes, edges).has('dist1')).toBe(false);
  });

  it('folds the whole network below the core, but not the firewall above it', () => {
    expect([...hiddenByCollapsing('core', nodes, edges)].sort()).toEqual(
      ['ap1', 'ap2', 'ap3', 'dist1', 'dist2'],
    );
    expect(hiddenByCollapsing('core', nodes, edges).has('fw')).toBe(false);
  });

  it('holds nothing when the device is a leaf', () => {
    expect(hiddenByCollapsing('ap1', nodes, edges).size).toBe(0);
    expect(worthCollapsing('ap1', nodes, edges)).toBe(false);
    expect(worthCollapsing('dist1', nodes, edges)).toBe(true);
  });

  it('does not fold a device that has another way round', () => {
    // A ring: ap1 also reaches the core directly, so it is not hanging off
    // dist1 — it is beside it, and folding it would hide a live path.
    const ring = [...edges, link('ap1', 'core')];
    expect([...hiddenByCollapsing('dist1', nodes, ring)]).toEqual(['ap2']);
  });

  it('counts what it is holding, for the badge', () => {
    expect(foldedCount('dist1', nodes, edges)).toBe(2);
    expect(foldedCount('core', nodes, edges)).toBe(5);
    expect(foldedCount('fw', nodes, edges)).toBe(6);
  });

  describe('several collapsed at once', () => {
    it('adds up', () => {
      expect([...hiddenByAll(['dist1', 'dist2'], nodes, edges)].sort()).toEqual(['ap1', 'ap2', 'ap3']);
    });

    it('keeps every collapsed device visible, even one inside another branch', () => {
      // dist1 is inside what core folds away. Collapsing both must not hide
      // dist1 itself, or there is nothing left to click to get it back.
      const hidden = hiddenByAll(['core', 'dist1'], nodes, edges);
      expect(hidden.has('core')).toBe(false);
      expect(hidden.has('dist1')).toBe(false);
      expect(hidden.has('ap1')).toBe(true);
      expect(hidden.has('ap3')).toBe(true);
    });

    it('is the same however the ids are ordered', () => {
      expect([...hiddenByAll(['core', 'dist1'], nodes, edges)].sort()).toEqual(
        [...hiddenByAll(['dist1', 'core'], nodes, edges)].sort(),
      );
    });
  });

  describe('the shapes that would otherwise crash or mislead', () => {
    it('answers nothing for a device that is not on the page', () => {
      expect(hiddenByCollapsing('nowhere', nodes, edges).size).toBe(0);
      expect(hiddenByAll(['nowhere'], nodes, edges).size).toBe(0);
    });

    it('answers nothing on an empty diagram', () => {
      expect(hiddenByCollapsing('a', [], []).size).toBe(0);
    });

    it('holds nothing when a device is the only thing on the page', () => {
      expect(hiddenByCollapsing('only', [node('only', 'core-switch')], []).size).toBe(0);
    });

    it('does not fold an island that was never joined to it', () => {
      // Two separate diagrams on one page: collapsing in one must not take
      // the other with it.
      const islands = [...nodes, node('other1', 'access-switch'), node('other2', 'endpoint')];
      const joined = [...edges, link('other1', 'other2')];
      const hidden = hiddenByCollapsing('dist1', islands, joined);
      expect(hidden.has('other1')).toBe(false);
      expect(hidden.has('other2')).toBe(false);
      expect([...hidden].sort()).toEqual(['ap1', 'ap2']);
    });

    it('ignores a link to something that is not on the page', () => {
      const dangling = [...edges, link('dist1', 'ghost')];
      expect([...hiddenByCollapsing('dist1', nodes, dangling)].sort()).toEqual(['ap1', 'ap2']);
    });
  });

  it('says what will happen, both ways round', () => {
    expect(collapseLabel('dist1', nodes, edges, new Set())).toBe('Collapse — 2 devices');
    expect(collapseLabel('dist2', nodes, edges, new Set())).toBe('Collapse — 1 device');
    expect(collapseLabel('dist1', nodes, edges, new Set(['dist1']))).toBe('Expand — 2 devices hidden');
  });
});
