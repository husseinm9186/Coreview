/**
 * Folders on the project screen, as the page reads them.
 *
 * The tree is kept by Rust in the local database — never in a project's
 * document — and arrives as a flat list of folders with their parents, plus
 * which folder each project sits in. Everything here is arithmetic over that:
 * what is in a folder, the path to it, and where a folder may be moved.
 */
import type { ProjectMeta } from '../types/domain';

export interface ProjectFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface FolderTree {
  folders: ProjectFolder[];
  /** Project id → folder id. A project not listed is at the top. */
  placement: Record<string, string>;
}

export const EMPTY_TREE: FolderTree = { folders: [], placement: {} };

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/** The folder a project is in, or null at the top — and null too when the
 *  folder it names is gone, so a project is never lost from view. */
export function folderOf(tree: FolderTree, projectId: string): string | null {
  const id = tree.placement[projectId];
  return id && tree.folders.some((f) => f.id === id) ? id : null;
}

/** The folders directly inside `parent` (null is the top), by name. */
export function childFolders(tree: FolderTree, parent: string | null): ProjectFolder[] {
  return tree.folders.filter((f) => (f.parentId ?? null) === parent).sort(byName);
}

/** The projects directly inside `parent`. Order is the caller's. */
export function projectsIn<P extends Pick<ProjectMeta, 'id'>>(tree: FolderTree, projects: readonly P[], parent: string | null): P[] {
  return projects.filter((p) => folderOf(tree, p.id) === parent);
}

/** From the top down to `id`, inclusive. Empty for the top itself or a
 *  folder that no longer exists. Stops on a cycle rather than spinning. */
export function pathTo(tree: FolderTree, id: string | null): ProjectFolder[] {
  const out: ProjectFolder[] = [];
  const seen = new Set<string>();
  let at = id ? tree.folders.find((f) => f.id === id) : undefined;
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    out.unshift(at);
    at = at.parentId ? tree.folders.find((f) => f.id === at!.parentId) : undefined;
  }
  return out;
}

/** "Customer A / Site 1", or the empty string at the top. */
export function pathLabel(tree: FolderTree, id: string | null): string {
  return pathTo(tree, id).map((f) => f.name).join(' / ');
}

/** The folder and every folder under it. */
export function subtreeIds(tree: FolderTree, id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of tree.folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** How many projects are in a folder, counting every folder under it. */
export function projectCountWithin<P extends Pick<ProjectMeta, 'id'>>(tree: FolderTree, projects: readonly P[], id: string): number {
  const inside = subtreeIds(tree, id);
  return projects.filter((p) => {
    const f = folderOf(tree, p.id);
    return f !== null && inside.has(f);
  }).length;
}

/** Every folder as a destination, labelled by its path and ordered by it.
 *  `moving` leaves out a folder and everything under it — a folder cannot
 *  be moved into itself. */
export function destinations(tree: FolderTree, moving?: string): { id: string; label: string }[] {
  const excluded = moving ? subtreeIds(tree, moving) : new Set<string>();
  return tree.folders
    .filter((f) => !excluded.has(f.id))
    .map((f) => ({ id: f.id, label: pathLabel(tree, f.id) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }));
}

/** A reply from Rust, or from a stub that knows nothing of folders, as a tree. */
export function readTree(raw: unknown): FolderTree {
  const r = (raw ?? {}) as { folders?: unknown; placement?: unknown };
  const folders = Array.isArray(r.folders)
    ? r.folders
        .filter((f): f is { id: string; name: string; parentId?: string | null } => typeof f?.id === 'string' && typeof f?.name === 'string')
        .map((f) => ({ id: f.id, name: f.name, parentId: f.parentId ?? null }))
    : [];
  const placement = r.placement && typeof r.placement === 'object' && !Array.isArray(r.placement) ? (r.placement as Record<string, string>) : {};
  return { folders, placement };
}
