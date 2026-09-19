import type { ProjectDocument, ProjectPage, TopoEdge, TopoNode } from '../state/store';
import type { DeviceNodeData } from '../types/domain';
import { entriesOf } from './ipam';
import { uid } from './id';
import { DEFAULT_PAGE_CANVAS, newPage } from './pages';

/** Shapes that are boxes by definition and keep card proportions; everything
 *  else that is a device draws as a glyph, whose bounds are square since
 *  LT-053 so the selection ring and resize corners sit on the drawn symbol. */
const BOXY = new Set(['rectangle', 'rounded', 'circle', 'diamond', 'cloud', 'text', 'zone', 'callout']);

/** The square a device glyph is drawn at when placed today. */
const GLYPH = 76;

/** The shape a document was saved in before LT-094 introduced pages: one
 *  flat canvas, read here only on the way through `toPagesShape`. */
interface LegacyDocument {
  nodes?: TopoNode[];
  edges?: TopoEdge[];
  canvas?: ProjectPage['canvas'];
  probes?: ProjectDocument['probes'];
}

/**
 * Wraps a document saved before LT-094 into a single page named "Page 1" —
 * everything that was on it stays exactly where it was, just inside the new
 * shape. A no-op (beyond filling in a missing/stale activePageId) on a
 * document that already has pages, so this is safe to run unconditionally.
 */
function toPagesShape(raw: unknown): { doc: ProjectDocument; wrapped: boolean } {
  const r = (raw ?? {}) as Partial<ProjectDocument> & LegacyDocument;
  // LT-276: whatever belongs to the whole project — captured shapes, grid
  // snap, racks and anything added later — is carried over as it is. Rebuilding
  // the document from only the fields this function knows about dropped them
  // all on every open.
  const project: Partial<ProjectDocument> = { ...r };
  for (const own of ['nodes', 'edges', 'canvas', 'pages', 'activePageId', 'probes']) {
    delete (project as Record<string, unknown>)[own];
  }
  if (Array.isArray(r.pages) && r.pages.length > 0) {
    const activePageId =
      typeof r.activePageId === 'string' && r.pages.some((p) => p.id === r.activePageId)
        ? r.activePageId
        : r.pages[0]!.id;
    return { doc: { ...project, pages: r.pages, activePageId, probes: r.probes ?? [] }, wrapped: false };
  }
  const page: ProjectPage = {
    ...newPage('Page 1', uid()),
    nodes: r.nodes ?? [],
    edges: r.edges ?? [],
    canvas: r.canvas ?? { ...DEFAULT_PAGE_CANVAS },
  };
  return {
    doc: { ...project, pages: [page], activePageId: page.id, probes: r.probes ?? [] },
    wrapped: true,
  };
}

/**
 * Bring a document up to date on open.
 *
 * Two steps, in order: first LT-094's page wrapping (above), then LT-065's
 * device-glyph squaring, which now runs across every page rather than one
 * flat node list. Both are idempotent, so opening an already-migrated
 * document changes nothing.
 */
export function migrateDocument(raw: unknown): { doc: ProjectDocument; changed: number } {
  const { doc: wrappedDoc, wrapped } = toPagesShape(raw);
  let changed = wrapped ? 1 : 0;

  const pages = wrappedDoc.pages.map((page): ProjectPage => {
    const nodes = page.nodes.map((n): TopoNode => {
      if (n.type !== 'device') return n;
      const d = n.data as DeviceNodeData;
      if (BOXY.has(d.deviceType)) return n;
      const w = n.width ?? 0;
      const h = n.height ?? 0;
      // The tell of an un-migrated glyph: the old default box, or any node
      // wider than it is tall by more than a little. A deliberately-resized
      // square glyph (already w≈h) is left alone.
      const isOldBox = (w === 168 && h === 92) || (w > 0 && h > 0 && Math.abs(w - h) > 12);
      if (!isOldBox) return n;
      changed += 1;
      // Keep the centre so the device does not appear to jump.
      const cx = n.position.x + w / 2;
      const cy = n.position.y + h / 2;
      return {
        ...n,
        width: GLYPH,
        height: GLYPH,
        position: { x: cx - GLYPH / 2, y: cy - GLYPH / 2 },
      } as TopoNode;
    });
    return { ...page, nodes };
  });

  // LT-289: the address register's held addresses became records with a kind.
  // `reservations` shipped in 6bfeee6 and lasted one morning, so this will
  // find it in very few projects — but dropping it silently would lose the
  // only part of the register a person had typed by hand.
  let ipam = wrappedDoc.ipam;
  if (ipam?.reservations?.length) {
    ipam = { ...ipam, entries: entriesOf(ipam), reservations: undefined };
    changed += 1;
  }

  return { doc: { ...wrappedDoc, pages, ...(ipam ? { ipam } : {}) }, changed };
}
