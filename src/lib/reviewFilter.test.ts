import { describe, expect, it } from 'vitest';

import type { Change } from './reconcile';
import { reviewable } from './reviewFilter';
import type { TopoNode } from '../state/store';

const node = (id: string, label: string, address: string, tags: string[] = []): TopoNode =>
  ({ id, type: 'device', position: { x: 0, y: 0 }, data: { label, addresses: [{ id: `${id}-a`, label: 'x', address, isPrimary: true }], tags } }) as unknown as TopoNode;
const addDevice = (n: TopoNode): Change => ({ id: `c-${n.id}`, kind: 'added', subject: 'device', accept: true, addNodes: [n] }) as unknown as Change;
const addLink = (id: string, source: string, target: string): Change =>
  ({ id, kind: 'added', subject: 'link', accept: true, addEdges: [{ id, source, target }] }) as unknown as Change;

describe('what of a crawl reaches the review', () => {
  // Invented names and documentation addresses.
  const sw = node('sw', 'CORE-SW1', '192.0.2.10');
  const printer = node('prn', 'PRN-1', '192.0.2.40', ['seen-only', 'attached']);
  const unmanaged = node('hub', 'Unmanaged switch', '', ['inferred', 'attached']);
  const unticked = node('rtr', 'EDGE-RTR1', '192.0.2.1');
  const topo = { nodes: [sw, printer, unmanaged, unticked] };
  const changes = [addDevice(sw), addDevice(printer), addDevice(unmanaged), addDevice(unticked), addLink('l1', 'sw', 'prn'), addLink('l2', 'sw', 'rtr')];
  // Only CORE-SW1's row is ticked.
  const keep = new Set(['a:192.0.2.10']);

  it('keeps the silent devices the Add button counted, and their links', () => {
    const ids = reviewable(changes, { nodes: [] }, topo, keep).map((c) => c.id);
    expect(ids).toContain('c-prn');
    expect(ids).toContain('c-hub');
    expect(ids).toContain('l1');
  });

  it('still leaves out an unticked crawled device and the link to it', () => {
    const ids = reviewable(changes, { nodes: [] }, topo, keep).map((c) => c.id);
    expect(ids).not.toContain('c-rtr');
    expect(ids).not.toContain('l2');
    expect(ids).toContain('c-sw');
  });
});
