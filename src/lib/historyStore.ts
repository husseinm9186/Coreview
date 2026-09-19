/**
 * Undo history that survives closing the app (LT-185).
 *
 * Kept on this machine only — the webview's IndexedDB, never the project file
 * or any export. History holds what was deleted, which is not something a
 * package sent to a colleague should carry.
 *
 * Each history entry shares every object that did not change with its
 * neighbours, so two hundred steps of a large diagram cost little more than
 * the diagram. Packing keeps that sharing: every device, link and page is
 * written once, and entries refer to it by index. Unpacking rebuilds the same
 * sharing.
 *
 * History belongs to one save. It is stored with the save's timestamp and
 * restored only when the project on disk still carries that timestamp — so an
 * undo can never step into the history of some other version of the file.
 */
import type { HistoryEntry, ProjectPage, TopoEdge, TopoNode } from '../state/store';

interface PackedPage {
  /** The page's own fields, without its nodes and edges. */
  shell: Omit<ProjectPage, 'nodes' | 'edges'>;
  nodes: number[];
  edges: number[];
}

interface PackedEntry {
  activePageId: string;
  pages: number[];
  probes: number;
  customShapes: number | null;
  /** LT-285. Null for every entry written before the register existed. */
  ipam?: number | null;
}

export interface PackedHistory {
  version: 1;
  /** The `updatedAt` of the save this history belongs to. */
  stamp: number;
  /** Every distinct device, link, page, probe list and shape list, once. */
  pool: unknown[];
  past: PackedEntry[];
  future: PackedEntry[];
}

export function packHistory(stamp: number, past: HistoryEntry[], future: HistoryEntry[]): PackedHistory {
  const pool: unknown[] = [];
  const index = new Map<object, number>();
  const put = (obj: object, make: () => unknown): number => {
    const at = index.get(obj);
    if (at !== undefined) return at;
    // Reserved before `make`, which may put children of its own.
    const slot = pool.length;
    pool.push(null);
    index.set(obj, slot);
    pool[slot] = make();
    return slot;
  };
  const packEntry = (e: HistoryEntry): PackedEntry => ({
    activePageId: e.activePageId,
    pages: e.pages.map((page) =>
      put(page, () => {
        const { nodes, edges, ...shell } = page;
        return {
          shell,
          nodes: nodes.map((n) => put(n, () => n)),
          edges: edges.map((ed) => put(ed, () => ed)),
        } satisfies PackedPage;
      }),
    ),
    probes: put(e.probes, () => e.probes),
    customShapes: e.customShapes ? put(e.customShapes, () => e.customShapes) : null,
    ipam: e.ipam ? put(e.ipam, () => e.ipam) : null,
  });
  return { version: 1, stamp, pool, past: past.map(packEntry), future: future.map(packEntry) };
}

export function unpackHistory(packed: PackedHistory): { past: HistoryEntry[]; future: HistoryEntry[] } {
  const pages = new Map<number, ProjectPage>();
  const pageAt = (i: number): ProjectPage => {
    let page = pages.get(i);
    if (!page) {
      const p = packed.pool[i] as PackedPage;
      page = {
        ...p.shell,
        nodes: p.nodes.map((n) => packed.pool[n] as TopoNode),
        edges: p.edges.map((e) => packed.pool[e] as TopoEdge),
      } as ProjectPage;
      pages.set(i, page);
    }
    return page;
  };
  const unpackEntry = (e: PackedEntry): HistoryEntry => ({
    activePageId: e.activePageId,
    pages: e.pages.map(pageAt),
    probes: packed.pool[e.probes] as HistoryEntry['probes'],
    customShapes: e.customShapes === null ? undefined : (packed.pool[e.customShapes] as HistoryEntry['customShapes']),
    ipam: e.ipam == null ? undefined : (packed.pool[e.ipam] as HistoryEntry['ipam']),
  });
  return { past: packed.past.map(unpackEntry), future: packed.future.map(unpackEntry) };
}

// ---------------------------------------------------------------- IndexedDB

const DB_NAME = 'coreview-history';
const STORE = 'projects';

function openDb(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const opening = openDb();
  if (!opening) return undefined;
  const db = await opening;
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Keeps a project's history for the save stamped `stamp`. Failure to store
 *  it is not an error the operator needs to see: undo still works this
 *  session, it just does not outlive it. */
export async function saveHistory(projectId: string, stamp: number, past: HistoryEntry[], future: HistoryEntry[]): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.put(packHistory(stamp, past, future), projectId));
  } catch (err) {
    console.warn('undo history not kept:', err);
  }
}

/** The history kept for this project, if it belongs to the save stamped
 *  `stamp`; otherwise none. */
export async function loadHistory(
  projectId: string,
  stamp: number,
): Promise<{ past: HistoryEntry[]; future: HistoryEntry[] } | null> {
  try {
    const packed = (await withStore('readonly', (s) => s.get(projectId))) as PackedHistory | undefined;
    if (!packed || packed.version !== 1 || packed.stamp !== stamp) return null;
    return unpackHistory(packed);
  } catch {
    return null;
  }
}

export async function deleteHistory(projectId: string): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(projectId));
  } catch {
    /* nothing kept, nothing to delete */
  }
}
