import { describe, expect, it } from 'vitest';
import { migrateDocument } from './migrate';

const legacyDoc = (nodes: unknown[]) => ({ nodes, edges: [], probes: [], canvas: {} });
/** A document already in the post-LT-094 shape, so a test can isolate
 *  glyph-squaring's `changed` count from the page-wrap's own. */
const pagedDoc = (nodes: unknown[]) => ({
  pages: [{ id: 'p1', name: 'Page 1', nodes, edges: [], canvas: {} }],
  activePageId: 'p1',
  probes: [],
});
const node = (over: Record<string, unknown>) => ({
  id: 'n', type: 'device', position: { x: 100, y: 100 }, width: 168, height: 92,
  data: { label: 'Dev', deviceType: 'router', tags: [], addresses: [], locked: false, maintenance: false, showDetails: true },
  ...over,
}) as never;

describe('migrateDocument — LT-094 page wrapping', () => {
  it('wraps a pre-pages document into one page named "Page 1"', () => {
    const { doc, changed } = migrateDocument(legacyDoc([node({})]));
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0]!.name).toBe('Page 1');
    expect(doc.pages[0]!.id).toBe(doc.activePageId);
    expect(changed).toBeGreaterThan(0);
  });

  it('carries nodes, edges and canvas settings onto the new page unchanged', () => {
    const raw = {
      nodes: [node({ width: 76, height: 76 })],
      edges: [{ id: 'e', source: 'n', target: 'n' }],
      probes: [],
      canvas: { gridEnabled: false, snapEnabled: true, minimap: true, nodeStyle: 'card' as const },
    };
    const { doc } = migrateDocument(raw);
    expect(doc.pages[0]!.nodes).toHaveLength(1);
    expect(doc.pages[0]!.edges).toHaveLength(1);
    expect(doc.pages[0]!.canvas.gridEnabled).toBe(false);
    expect(doc.pages[0]!.canvas.nodeStyle).toBe('card');
  });

  it('is idempotent on a document that already has pages', () => {
    const once = migrateDocument(legacyDoc([node({ width: 76, height: 76 })])).doc;
    const { doc: twice, changed } = migrateDocument(once);
    expect(twice.pages).toHaveLength(1);
    expect(twice.activePageId).toBe(once.activePageId);
    expect(changed).toBe(0);
  });

  it('falls back to a fresh empty page for a completely empty document', () => {
    const { doc } = migrateDocument({});
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0]!.nodes).toEqual([]);
    expect(doc.activePageId).toBe(doc.pages[0]!.id);
  });
});

describe('migrateDocument — keeps what belongs to the whole project (LT-276)', () => {
  it('keeps captured shapes, grid snap and racks on a document that already has pages', () => {
    const shape = { id: 's1', name: 'Captured', path: 'project:s1', svg: '<svg/>' };
    const raw = { ...pagedDoc([]), customShapes: [shape], gridSnap: true, racks: [{ id: 'r1', name: 'R1', units: 42 }] };
    const { doc } = migrateDocument(raw);
    expect(doc.customShapes).toEqual([shape]);
    expect(doc.gridSnap).toBe(true);
    expect(doc.racks).toEqual([{ id: 'r1', name: 'R1', units: 42 }]);
  });

  it('keeps them through the pre-pages wrapping too', () => {
    const { doc } = migrateDocument({ ...legacyDoc([]), gridSnap: true });
    expect(doc.gridSnap).toBe(true);
  });
});

describe('migrateDocument — LT-065 glyph squaring', () => {
  it('squares an old 168x92 device glyph and keeps its centre', () => {
    // Already paged with the oversized node still on it, so `changed`
    // reflects only the glyph square, not the page-wrap itself (see the
    // page-wrapping describe block above for that).
    const { doc: out, changed } = migrateDocument(pagedDoc([node({})]));
    expect(changed).toBe(1);
    const n = out.pages[0]!.nodes[0]!;
    expect(n.width).toBe(76);
    expect(n.height).toBe(76);
    // Old centre was (184, 146); new top-left keeps it.
    expect(n.position.x + 38).toBeCloseTo(184, 0);
    expect(n.position.y + 38).toBeCloseTo(146, 0);
  });

  it('leaves a shape node alone', () => {
    const doc = pagedDoc([
      node({ data: { label: 'Box', deviceType: 'rectangle', tags: [], addresses: [], locked: false, maintenance: false, showDetails: true } }),
    ]);
    expect(migrateDocument(doc).changed).toBe(0);
  });

  it('leaves an already-square glyph alone (idempotent)', () => {
    expect(migrateDocument(pagedDoc([node({ width: 76, height: 76 })])).changed).toBe(0);
    // And running it twice does nothing more.
    const once = migrateDocument(pagedDoc([node({})])).doc;
    expect(migrateDocument(once).changed).toBe(0);
  });
});

describe('the address register (LT-289)', () => {
  it('turns held addresses into records with a kind', () => {
    const raw = {
      ...pagedDoc([]),
      ipam: {
        subnets: [{ id: 's1', cidr: '192.0.2.0/24' }],
        reservations: [{ id: 'r1', address: '192.0.2.5', label: 'New firewall', note: 'Held' }],
      },
    };
    const { doc, changed } = migrateDocument(raw);
    expect(changed).toBe(1);
    expect(doc.ipam?.entries).toEqual([
      { id: 'r1', address: '192.0.2.5', label: 'New firewall', note: 'Held', kind: 'reserved' },
    ]);
    expect(doc.ipam?.reservations).toBeUndefined();
    // The subnets it did not touch are still there.
    expect(doc.ipam?.subnets).toHaveLength(1);
  });

  it('leaves a register that has already moved, and one that is empty', () => {
    const already = {
      ...pagedDoc([]),
      ipam: { entries: [{ id: 'e1', address: '192.0.2.5', label: 'Printer', kind: 'in-use' as const }] },
    };
    expect(migrateDocument(already).changed).toBe(0);
    expect(migrateDocument(already).doc.ipam?.entries).toHaveLength(1);
    expect(migrateDocument(pagedDoc([])).doc.ipam).toBeUndefined();
  });
});
