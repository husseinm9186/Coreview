import { describe, expect, it } from 'vitest';

import {
  commandsFor,
  newCommandSet,
  parseCommandSets,
  serializeCommandSets,
  setApplies,
  setsFor,
  type CommandSet,
} from './commandSets';

// Invented for the test (D-027): generic role words, nothing from any network.
const set = (over: Partial<CommandSet>): CommandSet => ({
  id: 'x', name: 'x', commands: '', roles: '', tags: '', ...over,
});

describe('command sets (LT-150)', () => {
  it('applies by role, ignoring case and spacing', () => {
    const s = set({ roles: 'Core Switch, edge router' });
    expect(setApplies(s, { role: 'core  switch' })).toBe(true);
    expect(setApplies(s, { role: 'EDGE ROUTER' })).toBe(true);
    expect(setApplies(s, { role: 'access switch' })).toBe(false);
    expect(setApplies(s, {})).toBe(false);
  });

  it('applies by tag', () => {
    const s = set({ tags: 'lab, wan' });
    expect(setApplies(s, { tags: ['WAN'] })).toBe(true);
    expect(setApplies(s, { tags: ['other'] })).toBe(false);
  });

  it('a set naming no role and no tag applies to nothing', () => {
    expect(setApplies(set({ commands: 'show version' }), { role: '', tags: [] })).toBe(false);
    expect(setApplies(set({ roles: ' , ' }), { role: '' })).toBe(false);
  });

  it('gives a device every matching set in list order, then its own, without repeats', () => {
    const sets = [
      set({ id: 'a', roles: 'core', commands: 'show version\nshow clock' }),
      set({ id: 'b', roles: 'access', commands: 'show vlan' }),
      set({ id: 'c', tags: 'lab', commands: 'show clock\nshow interfaces' }),
    ];
    const target = { role: 'Core', tags: ['lab'], showCommands: 'show interfaces\nshow log' };
    expect(setsFor(sets, target).map((s) => s.id)).toEqual(['a', 'c']);
    expect(commandsFor(sets, target)).toEqual(['show version', 'show clock', 'show interfaces', 'show log']);
  });

  it('a device no set matches keeps just its own list', () => {
    const sets = [set({ roles: 'core', commands: 'show version' })];
    expect(commandsFor(sets, { role: 'firewall', showCommands: 'get system status' })).toEqual([
      'get system status',
    ]);
    expect(commandsFor([], {})).toEqual([]);
  });

  it('round-trips through the stored setting and drops anything malformed', () => {
    const sets = [set({ id: 'a', name: 'One', roles: 'core', commands: 'show version' })];
    expect(parseCommandSets(serializeCommandSets(sets))).toEqual(sets);
    expect(serializeCommandSets([])).toBeNull();
    expect(parseCommandSets('not json')).toEqual([]);
    expect(parseCommandSets('{"a":1}')).toEqual([]);
    expect(parseCommandSets('[null, 3, {"name":"no id"}, {"id":"k","roles":5}]')).toEqual([
      { id: 'k', name: '', commands: '', roles: '', tags: '' },
    ]);
    expect(parseCommandSets('[{"id":"d"},{"id":"d"}]')).toHaveLength(1);
  });

  it('a new set starts empty — nothing pre-filled (D-027)', () => {
    const s = newCommandSet([set({ name: 'Set 1' })]);
    expect(s.commands).toBe('');
    expect(s.roles).toBe('');
    expect(s.tags).toBe('');
    expect(s.name).toBe('Set 2');
  });
});
