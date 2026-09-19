import { describe, expect, it } from 'vitest';

import {
  REST_NAME,
  groupOf,
  moveGroup,
  newGroup,
  parseGroups,
  planGroups,
  serializeGroups,
  type CollectionGroup,
} from './collectionGroups';

// Generic role words, invented for the test (D-027).
const group = (id: string, over: Partial<CollectionGroup> = {}): CollectionGroup => ({
  id, name: id, roles: '', tags: '', ...over,
});
const dev = (name: string, role = '', tags: string[] = []) => ({ name, role, tags });

describe('collection groups (LT-154)', () => {
  it('with no groups everything is one step, in the order given', () => {
    const plan = planGroups([], [dev('a'), dev('b')]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.name).toBe(REST_NAME);
    expect(plan[0]!.targets.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('runs groups in list order, then everything else, dropping empty groups', () => {
    const groups = [
      group('edge', { name: 'Edge', roles: 'lab router' }),
      group('empty', { name: 'Nothing here', roles: 'no such role' }),
      group('switches', { name: 'Switches', tags: 'bench' }),
    ];
    const plan = planGroups(groups, [
      dev('sw', '', ['BENCH']),
      dev('fw', 'lab firewall'),
      dev('rtr', 'Lab  Router'),
    ]);
    expect(plan.map((s) => [s.name, s.targets.map((t) => t.name)])).toEqual([
      ['Edge', ['rtr']],
      ['Switches', ['sw']],
      [REST_NAME, ['fw']],
    ]);
  });

  it('a device matching two groups is collected once, in the first', () => {
    const groups = [group('one', { roles: 'core' }), group('two', { tags: 'lab' })];
    const plan = planGroups(groups, [dev('x', 'core', ['lab'])]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.id).toBe('one');
    expect(groupOf(groups, dev('x', 'core', ['lab'])).id).toBe('one');
    expect(groupOf(groups, dev('y')).name).toBe(REST_NAME);
  });

  it('moves a group up and down, and ignores moves off either end', () => {
    const gs = [group('a'), group('b'), group('c')];
    expect(moveGroup(gs, 'c', -1).map((g) => g.id)).toEqual(['a', 'c', 'b']);
    expect(moveGroup(gs, 'a', 1).map((g) => g.id)).toEqual(['b', 'a', 'c']);
    expect(moveGroup(gs, 'a', -1)).toBe(gs);
    expect(moveGroup(gs, 'c', 1)).toBe(gs);
    expect(moveGroup(gs, 'nope', 1)).toBe(gs);
  });

  it('round-trips through the stored setting, dropping malformed rows and the reserved id', () => {
    const gs = [group('a', { name: 'Edge', roles: 'router' })];
    expect(parseGroups(serializeGroups(gs))).toEqual(gs);
    expect(serializeGroups([])).toBeNull();
    expect(parseGroups('x')).toEqual([]);
    expect(parseGroups('[{"id":"rest"},{"id":"k","roles":3},{"id":"k"}]')).toEqual([
      { id: 'k', name: '', roles: '', tags: '' },
    ]);
  });

  it('a new group starts matching nothing — nothing pre-filled (D-027)', () => {
    const g = newGroup([group('x', { name: 'Group 1' })]);
    expect([g.roles, g.tags]).toEqual(['', '']);
    expect(g.name).toBe('Group 2');
    expect(planGroups([g], [dev('d', 'anything')])[0]!.name).toBe(REST_NAME);
  });
});
