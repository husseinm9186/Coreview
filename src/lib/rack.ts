/**
 * Rack elevations (LT-195–197): which box is in which rack, at which U, on
 * which face.
 *
 * A rack is a project-wide thing with a name and a height in U. A device is in
 * it when its `rack` field names it — the same "Rack / room" field the
 * inspector, CSV import and export already carry — and it has a U position, the
 * lowest U it occupies. So the elevation is a second drawing of the devices
 * already on the diagram, not a copy of them: nothing on the logical diagram
 * moves when a box is racked (LT-196), and renaming a rack re-labels its
 * devices.
 *
 * Positions are whole U and nothing else. U alignment is correctness, not a
 * preference — a switch cannot be mounted a third of a unit down — so, unlike
 * grid snap on the canvas, it cannot be turned off (the D-013 amendment).
 *
 * Depth: a full-depth box fills the rack front to back, so it blocks that U on
 * both faces and is drawn on both (from the other face, as its back). A
 * half-depth box — a patch panel, a small switch — is on one face only, and a
 * different half-depth box can share its U on the other face.
 */
import type { DeviceNodeData } from '../types/domain';

export interface Rack {
  id: string;
  name: string;
  /** Height in U. */
  units: number;
}

export type RackFace = 'front' | 'rear';

export const DEFAULT_RACK_UNITS = 42;
export const MAX_RACK_UNITS = 60;

/** The part of a device a rack cares about. */
export interface Rackable {
  id: string;
  label: string;
  rack?: string;
  rackU?: number;
  rackUnits?: number;
  rackFace?: RackFace;
  rackDepth?: 'full' | 'half';
}

export function rackableOf(id: string, d: DeviceNodeData): Rackable {
  return { id, label: d.label, rack: d.rack, rackU: d.rackU, rackUnits: d.rackUnits, rackFace: d.rackFace, rackDepth: d.rackDepth };
}

const sameName = (a: string | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/** Whether a device takes rack space at all: 1U or more. A zero-U device (a
 *  vertical PDU) is in the rack but not in a U. */
export function takesSpace(d: Pick<Rackable, 'rackUnits'>): boolean {
  return typeof d.rackUnits === 'number' && Number.isInteger(d.rackUnits) && d.rackUnits >= 1;
}

const faceOf = (d: Rackable): RackFace => (d.rackFace === 'rear' ? 'rear' : 'front');
const fullDepth = (d: Rackable) => d.rackDepth !== 'half';

/** The U range a device occupies, bottom and top inclusive, or null if it is
 *  not placed. */
export function spanOf(d: Rackable): { bottom: number; top: number } | null {
  if (!takesSpace(d) || typeof d.rackU !== 'number' || !Number.isInteger(d.rackU)) return null;
  return { bottom: d.rackU, top: d.rackU + d.rackUnits! - 1 };
}

/** Whether two placed boxes want the same space: their U overlap, and either
 *  fills the depth or both are on the same face. */
export function collide(a: Rackable, b: Rackable): boolean {
  const sa = spanOf(a);
  const sb = spanOf(b);
  if (!sa || !sb) return false;
  if (sa.top < sb.bottom || sb.top < sa.bottom) return false;
  return fullDepth(a) || fullDepth(b) || faceOf(a) === faceOf(b);
}

/** The devices in a rack, by name. */
export function inRack(rack: Rack, devices: readonly Rackable[]): Rackable[] {
  return devices.filter((d) => sameName(d.rack, rack.name));
}

/**
 * Why a device cannot go at `u` (and on `face`) in this rack, or null when it
 * can. Every other device already in the rack is checked; the device itself is
 * ignored, so moving a box within its own span is allowed.
 */
export function placementProblem(
  rack: Rack,
  devices: readonly Rackable[],
  device: Rackable,
  u: number,
  face: RackFace = faceOf(device),
): string | null {
  if (!takesSpace(device)) return `${device.label} has no height in U, so it has no U position.`;
  if (!Number.isInteger(u)) return 'A rack position is a whole U.';
  const top = u + device.rackUnits! - 1;
  if (u < 1 || top > rack.units) {
    return `${device.label} is ${device.rackUnits}U and ${rack.name} is ${rack.units}U: it does not fit at U${u}.`;
  }
  const moved: Rackable = { ...device, rack: rack.name, rackU: u, rackFace: face };
  const blocker = inRack(rack, devices).find((other) => other.id !== device.id && collide(moved, other));
  if (blocker) {
    const s = spanOf(blocker)!;
    return `U${u}${top > u ? `–${top}` : ''} is taken by ${blocker.label} (U${s.bottom}${s.top > s.bottom ? `–${s.top}` : ''}).`;
  }
  return null;
}

/** The U a pointer is over, for a device `units` high whose top edge is under
 *  the pointer — always a whole U, clamped so the device stays in the rack.
 *  `fromTop` is the distance in pixels from the top of the rack's first U. */
export function uAt(fromTop: number, unitPx: number, rackUnits: number, units: number): number {
  const topU = rackUnits - Math.floor(fromTop / unitPx);
  const bottom = topU - units + 1;
  return Math.max(1, Math.min(rackUnits - units + 1, bottom));
}

/** What an elevation draws for one face: each device in the rack with where it
 *  is, whether it is seen from this face or through it (a full-depth box from
 *  its other side), and whether it collides with another — a copy pasted with
 *  the same position, say, which the elevation shows rather than hides. */
export interface RackItem {
  device: Rackable;
  bottom: number;
  top: number;
  seen: 'face' | 'behind';
  clash: boolean;
}

export function elevation(rack: Rack, devices: readonly Rackable[], face: RackFace): { items: RackItem[]; zeroU: Rackable[]; unplaced: Rackable[] } {
  const members = inRack(rack, devices);
  const items: RackItem[] = [];
  const zeroU: Rackable[] = [];
  const unplaced: Rackable[] = [];
  for (const d of members) {
    if (typeof d.rackUnits === 'number' && d.rackUnits === 0) {
      zeroU.push(d);
      continue;
    }
    const span = spanOf(d);
    if (!span || span.top > rack.units) {
      unplaced.push(d);
      continue;
    }
    const onFace = faceOf(d) === face;
    if (!onFace && !fullDepth(d)) continue;
    items.push({
      device: d,
      ...span,
      seen: onFace ? 'face' : 'behind',
      clash: members.some((o) => o.id !== d.id && collide(d, o)),
    });
  }
  items.sort((a, b) => b.top - a.top);
  return { items, zeroU, unplaced };
}

/** The lowest free position from the top down that fits, or null. */
export function firstFreeU(rack: Rack, devices: readonly Rackable[], device: Rackable): number | null {
  if (!takesSpace(device)) return null;
  for (let u = rack.units - device.rackUnits! + 1; u >= 1; u--) {
    if (!placementProblem(rack, devices, device, u)) return u;
  }
  return null;
}

/**
 * Racks from the devices that name one (LT-196): a rack for every distinct
 * rack name not already a rack, tall enough for what is in it, and a position
 * for every device in a rack that has a height and no valid position yet —
 * from the top down, the way a rack is usually filled. Positions that are
 * already valid are kept. Nothing about the logical diagram changes.
 */
export function racksFromDevices(
  racks: readonly Rack[],
  devices: readonly Rackable[],
  makeId: () => string,
): { racks: Rack[]; placed: Map<string, number>; full: Rackable[] } {
  const out = [...racks];
  for (const d of devices) {
    const name = d.rack?.trim();
    if (!name || !takesSpace(d)) continue;
    if (out.some((r) => sameName(r.name, name))) continue;
    const needed = devices.filter((o) => sameName(o.rack, name) && takesSpace(o)).reduce((s, o) => s + o.rackUnits!, 0);
    out.push({ id: makeId(), name, units: Math.min(MAX_RACK_UNITS, Math.max(DEFAULT_RACK_UNITS, needed)) });
  }
  const placed = new Map<string, number>();
  const full: Rackable[] = [];
  for (const rack of out) {
    // What is already validly placed stays; the rest is placed around it in
    // the order the devices are listed.
    const members = inRack(rack, devices).filter(takesSpace);
    const settled: Rackable[] = [];
    const waiting: Rackable[] = [];
    for (const d of members) {
      if (spanOf(d) && !placementProblem(rack, settled, d, d.rackU!)) settled.push(d);
      else waiting.push(d);
    }
    for (const d of waiting) {
      const u = firstFreeU(rack, settled, { ...d, rackU: undefined });
      if (u === null) {
        full.push(d);
        continue;
      }
      placed.set(d.id, u);
      settled.push({ ...d, rackU: u });
    }
  }
  return { racks: out, placed, full };
}
