/**
 * Named show-command sets applied by device role or tag (LT-150).
 *
 * A per-device list (LT-149) does not scale to a network where every core
 * switch wants the same dozen commands: typing them into each inspector means
 * editing them in each inspector. A set is written once, says which roles and
 * tags it applies to, and every matching device gets it.
 *
 * The sets are the operator's own, stored as one setting on his machine.
 * **None ships built in** — a set lifted from any real project is exactly what
 * D-027 forbids.
 *
 * Order for one device: the Backups tab's global list, then every matching set
 * in the order the sets are listed, then the device's own commands. The global
 * list is merged by the backend (`showcmd::plan_for`); this module produces the
 * device half.
 */
import { parseCommandList } from './showCommands';

export interface CommandSet {
  id: string;
  name: string;
  /** One command per line, as typed. */
  commands: string;
  /** Role words, comma separated, matched against the device's Role field. */
  roles: string;
  /** Tags, comma separated, matched against the device's tags. */
  tags: string;
}

/** What a set is matched against. */
export interface SetTarget {
  role?: string;
  tags?: string[];
  /** The device's own list, one per line. */
  showCommands?: string;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** A comma list as normalised words, blanks dropped. */
export function splitWords(text: string | undefined | null): string[] {
  return (text ?? '').split(',').map(norm).filter(Boolean);
}

/**
 * Reads the stored setting. Anything malformed is dropped rather than thrown:
 * a hand-edited or half-written setting must not stop the Backups tab opening.
 */
export function parseCommandSets(json: string | undefined | null): CommandSet[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const seen = new Set<string>();
  const out: CommandSet[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: str(o.name), commands: str(o.commands), roles: str(o.roles), tags: str(o.tags) });
  }
  return out;
}

/** What is stored, or null when there is nothing worth storing. */
export function serializeCommandSets(sets: CommandSet[]): string | null {
  return sets.length ? JSON.stringify(sets) : null;
}

/**
 * Whether a set applies to a device: its role is one of the set's roles, or
 * one of its tags is one of the set's tags. Case and spacing are ignored —
 * "Core Switch" and "core  switch" are the same role to a person. A set with
 * no roles and no tags applies to nothing; the global list is for everything.
 */
export function setApplies(set: CommandSet, target: SetTarget): boolean {
  return matchesRoleOrTag(set.roles, set.tags, target);
}

/**
 * The one matching rule shared by command sets (LT-150) and collection groups
 * (LT-154): the device's role is one of the comma-separated roles, or one of
 * its tags is one of the tags. Case and spacing are ignored; naming nothing
 * matches nothing.
 */
export function matchesRoleOrTag(
  rolesText: string,
  tagsText: string,
  target: { role?: string; tags?: string[] },
): boolean {
  const roles = splitWords(rolesText);
  const tags = splitWords(tagsText);
  const role = norm(target.role ?? '');
  if (role && roles.includes(role)) return true;
  return (target.tags ?? []).some((t) => tags.includes(norm(t)));
}

/** The sets that apply to a device, in the order they are listed. */
export function setsFor(sets: CommandSet[], target: SetTarget): CommandSet[] {
  return sets.filter((s) => setApplies(s, target));
}

/**
 * The device half of the plan: every matching set's commands, then the
 * device's own, with repeats removed and the first position kept.
 */
export function commandsFor(sets: CommandSet[], target: SetTarget): string[] {
  const out: string[] = [];
  const add = (list: string[]) => {
    for (const c of list) if (!out.includes(c)) out.push(c);
  };
  for (const s of setsFor(sets, target)) add(parseCommandList(s.commands));
  add(parseCommandList(target.showCommands));
  return out;
}

/** A fresh, empty set. The name is a label for the operator, not content. */
export function newCommandSet(existing: CommandSet[]): CommandSet {
  let n = existing.length + 1;
  const names = new Set(existing.map((s) => s.name));
  while (names.has(`Set ${n}`)) n++;
  const id = `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, name: `Set ${n}`, commands: '', roles: '', tags: '' };
}
