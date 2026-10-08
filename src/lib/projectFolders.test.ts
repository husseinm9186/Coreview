import { describe, expect, it } from 'vitest';

import {
  childFolders,
  destinations,
  folderOf,
  pathLabel,
  pathTo,
  projectCountWithin,
  projectsIn,
  readTree,
  subtreeIds,
  type FolderTree,
} from './projectFolders';

// Invented names only.
const tree: FolderTree = {
  folders: [
    { id: 'a', name: 'Customer A', parentId: null },
    { id: 'b', name: 'Site 2', parentId: 'a' },
    { id: 'c', name: 'Site 10', parentId: 'a' },
    { id: 'd', name: 'Rack room', parentId: 'b' },
    { id: 'e', name: 'another customer', parentId: null },
  ],
  placement: { p1: 'a', p2: 'd', p3: 'gone' },
};
const projects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];

describe('project folders', () => {
  it('lists what is directly inside a folder, folders by name, numbers as numbers', () => {
    expect(childFolders(tree, null).map((f) => f.name)).toEqual(['another customer', 'Customer A']);
    expect(childFolders(tree, 'a').map((f) => f.name)).toEqual(['Site 2', 'Site 10']);
    expect(projectsIn(tree, projects, null).map((p) => p.id)).toEqual(['p3', 'p4']);
    expect(projectsIn(tree, projects, 'a').map((p) => p.id)).toEqual(['p1']);
  });

  it('never loses a project whose folder is gone: it is at the top', () => {
    expect(folderOf(tree, 'p3')).toBeNull();
    expect(folderOf(tree, 'p4')).toBeNull();
  });

  it('names the path to a folder and counts everything under it', () => {
    expect(pathTo(tree, 'd').map((f) => f.id)).toEqual(['a', 'b', 'd']);
    expect(pathLabel(tree, 'd')).toBe('Customer A / Site 2 / Rack room');
    expect(pathLabel(tree, null)).toBe('');
    expect(projectCountWithin(tree, projects, 'a')).toBe(2);
    expect(projectCountWithin(tree, projects, 'c')).toBe(0);
    const loop: FolderTree = { folders: [{ id: 'x', name: 'X', parentId: 'y' }, { id: 'y', name: 'Y', parentId: 'x' }], placement: {} };
    expect(pathTo(loop, 'x')).toHaveLength(2);
  });

  it('offers every destination but a folder and what is under it', () => {
    expect([...subtreeIds(tree, 'a')].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(destinations(tree, 'b').map((d) => d.label)).toEqual(['another customer', 'Customer A', 'Customer A / Site 10']);
    expect(destinations(tree).map((d) => d.label)).toContain('Customer A / Site 2 / Rack room');
  });

  it('reads a stub that knows nothing of folders as an empty tree', () => {
    expect(readTree([])).toEqual({ folders: [], placement: {} });
    expect(readTree(undefined)).toEqual({ folders: [], placement: {} });
    expect(readTree({ folders: [{ id: 'a', name: 'A' }], placement: { p: 'a' } })).toEqual({ folders: [{ id: 'a', name: 'A', parentId: null }], placement: { p: 'a' } });
  });
});
