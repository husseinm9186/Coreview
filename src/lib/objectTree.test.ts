import { describe, expect, it } from 'vitest';

import type { HealthStatus } from '../types/domain';
import { buildTree, flattenTree, openForFit, pathTo, type TreeLeafRow } from './objectTree';

const leaf = (id: string, site: string, role: TreeLeafRow['role'], status: HealthStatus = 'healthy'): TreeLeafRow & { name: string } => ({
  id, kind: role === 'links' ? 'link' : 'node', status, site, role, name: id,
});

const estate = () => [
  leaf('core', 'HQ', 'core'),
  leaf('d1', 'HQ', 'distribution', 'warning'),
  leaf('a1', 'HQ', 'access'),
  leaf('a2', 'HQ', 'access', 'down'),
  leaf('l1', 'HQ', 'links'),
  leaf('r1', 'Branch', 'edge'),
  leaf('b1', 'Branch', 'access'),
  leaf('b2', 'Branch', 'access'),
  leaf('x1', '', 'other'),
];

describe('buildTree', () => {
  it('groups by site, then by role in tier order, with links last', () => {
    const tree = buildTree(estate(), (s) => s || 'No site');
    expect(tree.map((b) => b.label)).toEqual(['Branch', 'HQ', 'No site']);
    const hq = tree[1]!;
    expect(hq.children.map((b) => b.label)).toEqual(['Core', 'Distribution', 'Access', 'Links']);
    expect(hq.count).toBe(5);
    expect(hq.worst).toBe('down');
    expect(hq.down).toBe(1);
    expect(hq.warning).toBe(1);
  });

  it('skips the site level when there is only one site', () => {
    const rows = estate().filter((r) => r.site === 'HQ');
    const tree = buildTree(rows, (s) => s);
    expect(tree.map((b) => b.label)).toEqual(['Core', 'Distribution', 'Access', 'Links']);
    expect(tree.every((b) => b.depth === 0 && b.children.length === 0)).toBe(true);
  });

  it('is flat — no branches — when there is one site and one role', () => {
    expect(buildTree([leaf('a', '', 'access'), leaf('b', '', 'access')], (s) => s)).toEqual([]);
  });
});

describe('flattenTree and pathTo', () => {
  it('draws a branch, then what is under it while it is open', () => {
    const tree = buildTree(estate(), (s) => s || 'No site');
    const hqKey = tree[1]!.key;
    const accessKey = tree[1]!.children[2]!.key;
    const drawn = flattenTree(tree, new Set([hqKey, accessKey]));
    const text = drawn.map((r) => (r.kind === 'branch' ? `[${r.branch.label}${r.open ? '-' : '+'}]` : r.row.id));
    expect(text).toEqual(['[Branch+]', '[HQ-]', '[Core+]', '[Distribution+]', '[Access-]', 'a1', 'a2', '[Links+]', '[No site+]']);
    expect(pathTo(tree, 'a2')).toEqual([hqKey, accessKey]);
    expect(pathTo(tree, 'nobody')).toEqual([]);
  });
});

describe('openForFit', () => {
  const tree = () => buildTree(estate(), (s) => s || 'No site');

  it('opens everything when it fits', () => {
    const open = openForFit(tree(), 100, null, new Map());
    expect(flattenTree(tree(), open).filter((r) => r.kind === 'leaf').length).toBe(9);
  });

  it('folds the devices under their roles when the rows would not fit', () => {
    // 3 sites + 7 role branches + 9 leaves = 19 rows; 14 fit.
    const open = openForFit(tree(), 14, null, new Map());
    const drawn = flattenTree(tree(), open);
    expect(drawn.length).toBeLessThanOrEqual(14);
    expect(drawn.filter((r) => r.kind === 'leaf').length).toBe(0);
    expect(drawn.filter((r) => r.kind === 'branch' && r.branch.depth === 1).length).toBe(7);
  });

  it('keeps the branch holding the selection open whatever fits', () => {
    const open = openForFit(tree(), 5, 'a2', new Map());
    const drawn = flattenTree(tree(), open);
    expect(drawn.some((r) => r.kind === 'leaf' && r.row.id === 'a2')).toBe(true);
    // And only that site is open.
    expect(drawn.filter((r) => r.kind === 'branch' && r.branch.depth === 0 && r.open).map((r) => (r as { branch: { label: string } }).branch.label)).toEqual(['HQ']);
  });

  it('leaves what somebody opened or closed by hand as they left it', () => {
    const t = tree();
    const branchKey = t[0]!.key;
    const hqAccess = t[1]!.children[2]!.key;
    const open = openForFit(t, 100, null, new Map([[hqAccess, false], [branchKey, false]]));
    expect(open.has(hqAccess)).toBe(false);
    expect(open.has(branchKey)).toBe(false);
    const tight = openForFit(t, 5, null, new Map([[hqAccess, true]]));
    expect(tight.has(hqAccess)).toBe(true);
  });
});
