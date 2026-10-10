/**
 * A device an arrangement placed and somebody then moved by hand stays
 * where it was put through the next arrangement, until it is unpinned.
 * Anything never arranged is free to move, so the first arrangement of a
 * hand-drawn page still rearranges all of it.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { activePage, withPage } from '../lib/pages';
import type { DeviceNodeData, DeviceType } from '../types/domain';
import { emptyDocument, useStore, type TopoNode } from './store';

const device = (id: string, deviceType: DeviceType, x: number, y: number): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x, y },
    width: 76,
    height: 76,
    data: { label: id, deviceType, tags: [], addresses: [], locked: false, maintenance: false, showDetails: false },
  }) as TopoNode;

const link = (id: string, source: string, target: string) =>
  ({ id, source, target, type: 'live', data: { label: '', pathType: 'straight', direction: 'none' } }) as never;

const nodeOf = (id: string) => activePage(useStore.getState().doc).nodes.find((n) => n.id === id)!;
const dataOf = (id: string) => nodeOf(id).data as DeviceNodeData;

beforeEach(() => {
  const doc = emptyDocument();
  useStore.setState({
    doc: withPage(doc, {
      nodes: [device('net', 'internet', 0, 0), device('core', 'core-switch', 0, 0), device('a1', 'access-switch', 0, 0), device('a2', 'access-switch', 0, 0)],
      edges: [link('l1', 'net', 'core'), link('l2', 'core', 'a1'), link('l3', 'core', 'a2')],
    }),
    dirty: false,
  });
});

describe('arranging by layer and the pins it leaves', () => {
  it('signs what it placed, and a hand move after that pins the device', () => {
    const first = useStore.getState().flowLayout();
    expect(first.moved).toBe(4);
    expect(first.pinned).toBe(0);
    for (const id of ['net', 'core', 'a1', 'a2']) expect(dataOf(id).placedBy).toBe('layout');

    const dropped = { x: 1500, y: 900 };
    useStore.getState().onNodesChange([{ type: 'position', id: 'a1', position: dropped, dragging: false }]);
    expect(dataOf('a1').placedBy).toBe('hand');
    expect(dataOf('a2').placedBy).toBe('layout');

    const again = useStore.getState().flowLayout();
    expect(again.pinned).toBe(1);
    expect(nodeOf('a1').position).toEqual(dropped);
    expect(again.moved).toBe(3);
  });

  it('unpins on request, after which the arrangement moves the device again', () => {
    useStore.getState().flowLayout();
    useStore.getState().onNodesChange([{ type: 'position', id: 'a1', position: { x: 1500, y: 900 }, dragging: false }]);
    expect(useStore.getState().unpinMoved()).toBe(1);
    expect(dataOf('a1').placedBy).toBeUndefined();
    expect(useStore.getState().unpinMoved()).toBe(0);
    const after = useStore.getState().flowLayout();
    expect(after.pinned).toBe(0);
    expect(nodeOf('a1').position).not.toEqual({ x: 1500, y: 900 });
  });

  it('is free to move anything never arranged, so a hand-drawn page is arranged whole', () => {
    // Every device moved by hand before any arrangement: nothing is pinned.
    for (const id of ['net', 'core', 'a1', 'a2']) {
      useStore.getState().onNodesChange([{ type: 'position', id, position: { x: 50, y: 50 }, dragging: false }]);
      expect(dataOf(id).placedBy).toBeUndefined();
    }
    expect(useStore.getState().flowLayout().moved).toBe(4);
  });

  it('says so when everything on the page is pinned', () => {
    useStore.getState().flowLayout();
    for (const id of ['net', 'core', 'a1', 'a2']) {
      useStore.getState().onNodesChange([{ type: 'position', id, position: { x: 50, y: 50 + 100 * id.length }, dragging: false }]);
    }
    const r = useStore.getState().flowLayout();
    expect(r.moved).toBe(0);
    expect(r.pinned).toBe(4);
  });

  it('holds for the radial layout as well', () => {
    useStore.getState().flowLayout();
    useStore.getState().onNodesChange([{ type: 'position', id: 'core', position: { x: 700, y: 700 }, dragging: false }]);
    const r = useStore.getState().autoLayout('radial');
    expect(r.pinned).toBe(1);
    expect(nodeOf('core').position).toEqual({ x: 700, y: 700 });
    // And the radial layout signs its own placements.
    expect(dataOf('a1').placedBy).toBe('layout');
  });

  it('one undo takes the pin away with the move', () => {
    useStore.getState().flowLayout();
    useStore.getState().commit();
    useStore.getState().onNodesChange([{ type: 'position', id: 'a1', position: { x: 1500, y: 900 }, dragging: false }]);
    expect(dataOf('a1').placedBy).toBe('hand');
    useStore.getState().undo();
    expect(dataOf('a1').placedBy).toBe('layout');
  });
});
