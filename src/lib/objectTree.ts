/**
 * The Monitor table as a tree: site › role › device, with the links of a
 * site under it.
 *
 * Two thousand rows in a flat table are a list nobody reads. As a tree each
 * branch says how many it holds and the worst of them, the branches that
 * will not fit the panel fold, and the branch holding what is selected on
 * the canvas is always open — so the table follows the drawing rather than
 * asking to be scrolled.
 *
 * Pure: rows in, the rows to draw out. The component only measures the
 * panel and remembers what somebody opened or closed by hand.
 */
import { ROLE_ORDER, ROLE_WORD, worstOf, type RoleKey } from './clusters';
import type { HealthStatus } from '../types/domain';

export interface TreeLeafRow {
  id: string;
  kind: 'node' | 'link';
  status: HealthStatus;
  /** The site the device carries, or the site of a link's source. */
  site: string;
  /** The role bucket; a link's is `links`. */
  role: RoleKey | 'links';
}

export interface TreeBranch<R extends TreeLeafRow> {
  key: string;
  depth: 0 | 1;
  label: string;
  count: number;
  worst: HealthStatus;
  down: number;
  warning: number;
  children: TreeBranch<R>[];
  leaves: R[];
}

export type DrawnRow<R extends TreeLeafRow> = { kind: 'branch'; branch: TreeBranch<R>; open: boolean } | { kind: 'leaf'; row: R; depth: number };

export const NO_SITE = '';

function summarise<R extends TreeLeafRow>(leaves: R[]): Pick<TreeBranch<R>, 'count' | 'worst' | 'down' | 'warning'> {
  return {
    count: leaves.length,
    worst: worstOf(leaves.map((l) => l.status)),
    down: leaves.filter((l) => l.status === 'down').length,
    warning: leaves.filter((l) => l.status === 'warning').length,
  };
}

const roleTitle = (role: RoleKey | 'links'): string => (role === 'links' ? 'Links' : ROLE_WORD[role].title);
const roleRank = (role: RoleKey | 'links'): number => (role === 'links' ? ROLE_ORDER.length : ROLE_ORDER.indexOf(role));

/**
 * The tree. One site means no site level — a diagram of one site is not
 * helped by a branch holding everything — and one role under it means a
 * flat list: the tree appears when there is something to fold.
 */
export function buildTree<R extends TreeLeafRow>(rows: R[], siteLabel: (site: string) => string): TreeBranch<R>[] {
  const bySite = new Map<string, R[]>();
  for (const r of rows) bySite.set(r.site, [...(bySite.get(r.site) ?? []), r]);
  const sites = [...bySite.keys()].sort((a, b) => (a === NO_SITE ? 1 : b === NO_SITE ? -1 : a.localeCompare(b)));
  const roleBranches = (site: string, leaves: R[], depth: 0 | 1): TreeBranch<R>[] => {
    const byRole = new Map<RoleKey | 'links', R[]>();
    for (const r of leaves) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r]);
    return [...byRole.keys()]
      .sort((a, b) => roleRank(a) - roleRank(b))
      .map((role) => {
        const mine = byRole.get(role)!;
        return { key: `${site}\u0000${role}`, depth, label: roleTitle(role), ...summarise(mine), children: [], leaves: mine };
      });
  };
  if (sites.length <= 1) {
    const only = sites[0] ?? NO_SITE;
    const roles = roleBranches(only, bySite.get(only) ?? [], 0);
    // One role: nothing to fold, so no branch at all.
    return roles.length <= 1 ? [] : roles;
  }
  return sites.map((site) => {
    const leaves = bySite.get(site)!;
    return {
      key: `site\u0000${site}`,
      depth: 0,
      label: siteLabel(site),
      ...summarise(leaves),
      children: roleBranches(site, leaves, 1),
      leaves: [],
    };
  });
}

/** Every branch key in the tree. */
export function branchKeys<R extends TreeLeafRow>(tree: TreeBranch<R>[]): string[] {
  return tree.flatMap((b) => [b.key, ...branchKeys(b.children)]);
}

/** The keys on the way to a leaf — its site branch and its role branch. */
export function pathTo<R extends TreeLeafRow>(tree: TreeBranch<R>[], id: string): string[] {
  for (const b of tree) {
    if (b.leaves.some((l) => l.id === id)) return [b.key];
    const under = pathTo(b.children, id);
    if (under.length) return [b.key, ...under];
  }
  return [];
}

/** The rows to draw: a branch, then what is under it while it is open. */
export function flattenTree<R extends TreeLeafRow>(tree: TreeBranch<R>[], open: Set<string>): DrawnRow<R>[] {
  const out: DrawnRow<R>[] = [];
  const walk = (branches: TreeBranch<R>[]) => {
    for (const b of branches) {
      const isOpen = open.has(b.key);
      out.push({ kind: 'branch', branch: b, open: isOpen });
      if (!isOpen) continue;
      walk(b.children);
      for (const l of b.leaves) out.push({ kind: 'leaf', row: l, depth: b.depth + 1 });
    }
  };
  walk(tree);
  return out;
}

/**
 * Which branches to open so that the rows fit the panel.
 *
 * Everything open when it fits. When it does not, the role branches close
 * first (the devices fold under their roles), then the site branches — in
 * each case except the branches on the way to what is selected, which stay
 * open, and except what somebody opened or closed by hand, which stays as
 * they left it.
 */
export function openForFit<R extends TreeLeafRow>(
  tree: TreeBranch<R>[],
  fits: number,
  selectedId: string | null,
  manual: Map<string, boolean>,
): Set<string> {
  const keep = new Set(selectedId ? pathTo(tree, selectedId) : []);
  const apply = (open: Set<string>) => {
    for (const [key, isOpen] of manual) {
      if (isOpen) open.add(key);
      else open.delete(key);
    }
    for (const k of keep) open.add(k);
    return open;
  };
  const all = new Set(branchKeys(tree));
  if (flattenTree(tree, apply(new Set(all))).length <= fits) return apply(new Set(all));
  // Role branches closed, sites open.
  const sitesOnly = new Set(tree.filter((b) => b.children.length > 0).map((b) => b.key));
  if (flattenTree(tree, apply(new Set(sitesOnly))).length <= fits) return apply(new Set(sitesOnly));
  // Sites closed too.
  return apply(new Set());
}
