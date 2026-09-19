import { describe, expect, it } from 'vitest';

import type { HistoryEntry, ProjectPage, TopoNode } from '../state/store';
import { packHistory, unpackHistory } from './historyStore';

const node = (id: string, x: number): TopoNode =>
  ({ id, type: 'device', position: { x, y: 0 }, data: { label: id } }) as unknown as TopoNode;
const page = (id: string, nodes: TopoNode[]): ProjectPage =>
  ({ id, name: id, nodes, edges: [], canvas: { minimap: true } }) as unknown as ProjectPage;

describe('undo history kept between sessions (LT-185)', () => {
  // Three steps of one page where each step moves one device: most objects are
  // the same object in every step, as they are in the store.
  const a = node('a', 0);
  const b = node('b', 100);
  const b2 = { ...b, position: { x: 150, y: 0 } } as TopoNode;
  const b3 = { ...b, position: { x: 200, y: 0 } } as TopoNode;
  const probes: HistoryEntry['probes'] = [];
  const p1 = page('p1', [a, b]);
  const p2 = { ...p1, nodes: [a, b2] };
  const p3 = { ...p1, nodes: [a, b3] };
  const past: HistoryEntry[] = [
    { pages: [p1], activePageId: 'p1', probes },
    { pages: [p2], activePageId: 'p1', probes },
  ];
  const future: HistoryEntry[] = [{ pages: [p3], activePageId: 'p1', probes, customShapes: [] }];

  it('writes each shared object once', () => {
    const packed = packHistory(42, past, future);
    // a once, b three ways, three pages, one probe list, one shape list.
    expect(packed.pool.length).toBe(1 + 3 + 3 + 1 + 1);
    expect(packed.stamp).toBe(42);
  });

  it('carries the address register, so removing a subnet is undoable (LT-285)', () => {
    const ipam = { subnets: [{ id: 's1', cidr: '192.0.2.0/24', name: 'Site' }] };
    const withIpam: HistoryEntry[] = [{ pages: [p1], activePageId: 'p1', probes, ipam }];
    const back = unpackHistory(JSON.parse(JSON.stringify(packHistory(1, withIpam, []))));
    expect(back.past[0]!.ipam).toEqual(ipam);
    // An entry from before the register existed comes back without one,
    // rather than with an empty one that would wipe a later edit.
    const older = unpackHistory(JSON.parse(JSON.stringify(packHistory(1, past, []))));
    expect(older.past[0]!.ipam).toBeUndefined();
  });

  it('comes back equal, and still sharing what was shared', () => {
    const packed = JSON.parse(JSON.stringify(packHistory(42, past, future)));
    const back = unpackHistory(packed);
    expect(back.past).toEqual(past);
    expect(back.future.map((e) => e.pages[0]!.nodes[1]!.position)).toEqual([{ x: 200, y: 0 }]);
    const [first, second] = back.past;
    expect(first!.pages[0]!.nodes[0]).toBe(second!.pages[0]!.nodes[0]);
    expect(first!.probes).toBe(back.future[0]!.probes);
    expect(back.past[0]!.customShapes).toBeUndefined();
    expect(back.future[0]!.customShapes).toEqual([]);
  });

  it('keeps an empty history as an empty history', () => {
    expect(unpackHistory(packHistory(1, [], []))).toEqual({ past: [], future: [] });
  });
});
