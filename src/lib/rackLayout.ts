/**
 * Moving several boxes at once, and a rack's layout as a thing to copy.
 * Pure: each planner returns what would change, or the first
 * problem, and the store applies it in one commit.
 */
import { placementProblem, spanOf, type Rack, type RackFurniture, type Rackable } from './rack';

export interface Move {
  id: string;
  u: number;
}

/** Every chosen box in the rack moved by `delta` U together: a problem if
 *  one would leave the rack or land on something that is not also moving. */
export function shiftPlan(rack: Rack, all: readonly Rackable[], ids: readonly string[], delta: number): { moves: Move[] } | { problem: string } {
  const chosen = new Set(ids);
  const moving = all.filter((d) => chosen.has(d.id) && d.rackU !== undefined && (d.rackUnits ?? 0) > 0 && (d.rack ?? '').trim().toLowerCase() === rack.name.trim().toLowerCase());
  if (moving.length === 0) return { problem: 'Nothing placed is chosen.' };
  const still = all.filter((d) => !chosen.has(d.id));
  const moves: Move[] = [];
  for (const d of moving) {
    const u = d.rackU! + delta;
    const problem = placementProblem(rack, still, d, u, d.rackFace);
    if (problem) return { problem: `${d.label}: ${problem}` };
    moves.push({ id: d.id, u });
  }
  return { moves };
}

/** The chosen boxes packed under the highest of them, in their order from
 *  the top, with no U between. Boxes that are not chosen stay where they
 *  are and stop the packing if they are in the way. */
export function closeGapsPlan(rack: Rack, all: readonly Rackable[], ids: readonly string[]): { moves: Move[] } | { problem: string } {
  const chosen = new Set(ids);
  const moving = all
    .filter((d) => chosen.has(d.id) && d.rackU !== undefined && (d.rackUnits ?? 0) > 0 && (d.rack ?? '').trim().toLowerCase() === rack.name.trim().toLowerCase())
    .sort((a, b) => spanOf(b)!.top - spanOf(a)!.top);
  if (moving.length < 2) return { problem: 'Choose two or more boxes in one rack.' };
  const still = all.filter((d) => !chosen.has(d.id));
  const moves: Move[] = [];
  let next = spanOf(moving[0]!)!.top;
  const placedSoFar: Rackable[] = [];
  for (const d of moving) {
    const u = next - (d.rackUnits ?? 1) + 1;
    const problem = placementProblem(rack, [...still, ...placedSoFar], d, u, d.rackFace);
    if (problem) return { problem: `${d.label}: ${problem}` };
    moves.push({ id: d.id, u });
    placedSoFar.push({ ...d, rackU: u });
    next = u - 1;
  }
  return { moves: moves.filter((m) => all.find((d) => d.id === m.id)?.rackU !== m.u) };
}

/** A rack's furniture as a layout to carry to another rack: everything
 *  but the ids and the feeds, which belong to this rack's PDUs. */
export interface RackLayout {
  from: string;
  units: number;
  items: Omit<RackFurniture, 'id' | 'powerFeeds'>[];
}

export function layoutOf(rack: Rack): RackLayout {
  return {
    from: rack.name,
    units: rack.units,
    items: (rack.items ?? []).map((f) => {
      const rest: Omit<RackFurniture, 'id' | 'powerFeeds'> & { id?: string; powerFeeds?: unknown } = { ...f };
      delete rest.id;
      delete rest.powerFeeds;
      return rest;
    }),
  };
}

/** The layout's items placed in `rack` at the same U where that U is free,
 *  else left unplaced. The caller gives each its id. */
export function pastePlan(rack: Rack, all: readonly Rackable[], layout: RackLayout, ids: readonly string[]): { items: RackFurniture[]; placed: number; left: number } {
  const items: RackFurniture[] = [];
  const taken: Rackable[] = [...all];
  let placed = 0;
  let left = 0;
  layout.items.forEach((f, i) => {
    const item: RackFurniture = { ...f, id: ids[i] ?? `${rack.id}-${i}` };
    if (item.u !== undefined && item.units > 0) {
      const asRackable: Rackable = { id: item.id, label: item.label, rack: rack.name, rackUnits: item.units, rackFace: item.face, rackDepth: item.depth, kind: 'furniture', furniture: item.kind };
      if (placementProblem(rack, taken, asRackable, item.u, item.face)) {
        delete item.u;
        left += 1;
      } else {
        placed += 1;
        taken.push({ ...asRackable, rackU: item.u });
      }
    }
    items.push(item);
  });
  return { items, placed, left };
}
