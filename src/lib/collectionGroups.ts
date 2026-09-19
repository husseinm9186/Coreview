/**
 * Collect in an order, in groups (LT-154), the parts with no network in them.
 *
 * A collection plan runs in a sequence: the edge first, then what sits behind
 * it, then the rest, stopping to look between groups. A group is written once
 * and says which roles and tags belong to it, the same rule command sets use
 * (LT-150). Each selected device goes into the **first** group it matches,
 * so a device is never collected twice; whatever matches no group is
 * collected last, in *Everything else*.
 *
 * **No groups ship built in** (D-027); with none defined, a backup is one
 * group of everything selected, exactly as before.
 */
import { matchesRoleOrTag } from './commandSets';

export interface CollectionGroup {
  id: string;
  name: string;
  /** Comma-separated roles. */
  roles: string;
  /** Comma-separated tags. */
  tags: string;
}

/** One step of a planned collection. */
export interface PlannedGroup<T> {
  /** The group's id, or `rest` for Everything else. */
  id: string;
  name: string;
  targets: T[];
}

export const REST_ID = 'rest';
export const REST_NAME = 'Everything else';

export function parseGroups(json: string | undefined | null): CollectionGroup[] {
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
  const out: CollectionGroup[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    if (!id || id === REST_ID || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: str(o.name), roles: str(o.roles), tags: str(o.tags) });
  }
  return out;
}

export function serializeGroups(groups: CollectionGroup[]): string | null {
  return groups.length ? JSON.stringify(groups) : null;
}

export function newGroup(existing: CollectionGroup[]): CollectionGroup {
  let n = existing.length + 1;
  const names = new Set(existing.map((g) => g.name));
  while (names.has(`Group ${n}`)) n++;
  const id = `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, name: `Group ${n}`, roles: '', tags: '' };
}

/** Moves one group up (-1) or down (+1); out of range is a no-op. */
export function moveGroup(groups: CollectionGroup[], id: string, by: -1 | 1): CollectionGroup[] {
  const i = groups.findIndex((g) => g.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= groups.length) return groups;
  const out = [...groups];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** The group a device falls into: the first that matches, else the rest. */
export function groupOf(
  groups: CollectionGroup[],
  target: { role?: string; tags?: string[] },
): { id: string; name: string } {
  const g = groups.find((x) => matchesRoleOrTag(x.roles, x.tags, target));
  return g ? { id: g.id, name: g.name.trim() || 'unnamed group' } : { id: REST_ID, name: REST_NAME };
}

/**
 * The selected devices as ordered steps. Groups that end up empty are left
 * out, so a run never waits on a step with nothing in it. With no groups
 * defined there is one step holding everything, in the order given.
 */
export function planGroups<T extends { role?: string; tags?: string[] }>(
  groups: CollectionGroup[],
  targets: T[],
): PlannedGroup<T>[] {
  const steps: PlannedGroup<T>[] = [
    ...groups.map((g) => ({ id: g.id, name: g.name.trim() || 'unnamed group', targets: [] as T[] })),
    { id: REST_ID, name: REST_NAME, targets: [] as T[] },
  ];
  for (const t of targets) {
    const { id } = groupOf(groups, t);
    steps.find((s) => s.id === id)!.targets.push(t);
  }
  return steps.filter((s) => s.targets.length > 0);
}
