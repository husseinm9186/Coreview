/**
 * Rack elevations: which box is in which rack, at which U, on
 * which face.
 *
 * A rack is a project-wide thing with a name and a height in U. A device is in
 * it when its `rack` field names it — the same "Rack / room" field the
 * inspector, CSV import and export already carry — and it has a U position, the
 * lowest U it occupies. So the elevation is a second drawing of the devices
 * already on the diagram, not a copy of them: nothing on the logical diagram
 * moves when a box is racked, and renaming a rack re-labels its
 * devices.
 *
 * Positions are whole U and nothing else. U alignment is correctness, not a
 * preference — a switch cannot be mounted a third of a unit down — so, unlike
 * grid snap on the canvas, it cannot be turned off (the amendment).
 *
 * Depth: a full-depth box fills the rack front to back, so it blocks that U on
 * both faces and is drawn on both (from the other face, as its back). A
 * half-depth box — a patch panel, a small switch — is on one face only, and a
 * different half-depth box can share its U on the other face.
 */
import type { DeviceNodeData, HealthStatus } from '../types/domain';
import type { FurnitureKind } from './rackFurniture';

export interface Rack {
  id: string;
  name: string;
  /** Height in U. */
  units: number;
  /** Where the rack stands. All optional; a rack with none of
   *  them is simply "here". */
  building?: string;
  floor?: string;
  room?: string;
  row?: string;
  /** The rack's number or position in its row, as written on it. */
  position?: string;
  notes?: string;
  /** What the rack may carry, for the budgets. */
  powerLimitW?: number;
  weightLimitKg?: number;
  /** The rack's own size, for the side view and the label. */
  widthMm?: number;
  depthMm?: number;
  /** Which way the U are counted on the rails — from the bottom,
   *  the default, or from the top as some sites label them. A box's U is
   *  always the physical one from the bottom; this is what the rail says. */
  numbering?: 'bottom' | 'top';
  /** What kind of rack it is, for the drawing. */
  form?: '2-post' | '4-post' | 'enclosed';
  /** The drawing's revision, for the title block. */
  revision?: string;
  /** Where the rack stands on the floor, mm from the room's
   *  origin, when it has been dragged there; absent, its row and position
   *  place it. `facing` is which way its front looks on the plan. */
  floorX?: number;
  floorY?: number;
  facing?: 'n' | 'e' | 's' | 'w';
  /** What the rack holds that is not on the diagram —
   *  patch panels, PDUs, shelves, blanks, and reservations. */
  items?: RackFurniture[];
}

/** A thing in a rack that is not a network device. */
export interface RackFurniture {
  id: string;
  kind: FurnitureKind;
  label: string;
  /** Height in U; 0 for a vertical PDU or a cable manager down the post. */
  units: number;
  /** The lowest U it occupies; unset while it waits beside the rack. */
  u?: number;
  face?: RackFace;
  depth?: 'full' | 'half';
  airflow?: Airflow;
  /** What a reservation is for; also any item's note. */
  note?: string;
  powerW?: number;
  weightKg?: number;
  /** A chosen colour for the faceplate. */
  colour?: string;
  /** How deep it is, for the side view. */
  depthMm?: number;
  /** A PDU's outlets, where it is one; and what feeds this item. */
  outlets?: number;
  /** Jacks or ports, where a template said how many. */
  ports?: number;
  powerFeeds?: { pduId: string; outlet: number }[];
}

/** Which way a box breathes. */
export type Airflow = 'front-to-back' | 'back-to-front' | 'side-to-side' | 'passive';
export const AIRFLOWS: Airflow[] = ['front-to-back', 'back-to-front', 'side-to-side', 'passive'];

export type RackFace = 'front' | 'rear';

export const DEFAULT_RACK_UNITS = 42;
export const MAX_RACK_UNITS = 60;

/** The part of a device — or a piece of furniture — a rack cares
 *  about. The placement rules read only the first block; the drawing reads
 *  the rest. */
export interface Rackable {
  id: string;
  label: string;
  rack?: string;
  rackU?: number;
  rackUnits?: number;
  rackFace?: RackFace;
  rackDepth?: 'full' | 'half';
  /** A device from the diagram, or furniture kept on the rack. */
  kind?: 'device' | 'furniture';
  deviceType?: string;
  furniture?: FurnitureKind;
  airflow?: Airflow;
  note?: string;
  portCount?: number;
  portNaming?: string;
  powerW?: number;
  weightKg?: number;
  colour?: string;
  depthMm?: number;
  outlets?: number;
  powerFeeds?: { pduId: string; outlet: number }[];
  /** Where it came from, when a template made it. */
  template?: string;
  status?: HealthStatus;
  /** The stack this device is in, and its member number. */
  stack?: { id: string; name: string; member: number; role?: string };
}

export function rackableOf(id: string, d: DeviceNodeData): Rackable {
  return {
    id, label: d.label, rack: d.rack, rackU: d.rackU, rackUnits: d.rackUnits, rackFace: d.rackFace, rackDepth: d.rackDepth,
    kind: 'device', deviceType: d.deviceType, airflow: d.airflow, portCount: d.portCount, portNaming: d.portNaming,
    powerW: d.powerW, weightKg: d.weightKg, colour: d.rackColour, depthMm: d.depthMm, powerFeeds: d.powerFeeds,
  };
}

/** A rack's furniture as the placement rules and the drawing see it. */
export function furnitureRackables(rack: Pick<Rack, 'name' | 'items'>): Rackable[] {
  return (rack.items ?? []).map((f) => ({
    id: f.id, label: f.label, rack: rack.name, rackU: f.u, rackUnits: f.units, rackFace: f.face, rackDepth: f.depth,
    kind: 'furniture', furniture: f.kind, airflow: f.airflow, note: f.note, powerW: f.powerW, weightKg: f.weightKg,
    colour: f.colour, depthMm: f.depthMm, outlets: f.outlets, powerFeeds: f.powerFeeds, portCount: f.ports,
  }));
}

/** The label the rail shows for a physical U, by the rack's numbering. */
export function uLabel(rack: Pick<Rack, 'units' | 'numbering'>, u: number): number {
  return rack.numbering === 'top' ? rack.units - u + 1 : u;
}

/** The millimetres a rack's units stand for. */
export const U_MM = 44.45;
export function rackHeightMm(rack: Pick<Rack, 'units'>): number {
  return Math.round(rack.units * U_MM);
}

/** Where a rack is, in one line — "Building A · Floor 2 · Room 2.14 · Row B · 03". */
export function placeOf(rack: Pick<Rack, 'building' | 'floor' | 'room' | 'row' | 'position'>): string {
  return [rack.building, rack.floor && `Floor ${rack.floor}`, rack.room && `Room ${rack.room}`, rack.row && `Row ${rack.row}`, rack.position]
    .map((v) => (v ?? '').toString().trim())
    .filter(Boolean)
    .join(' · ');
}

/** Racks grouped by building, then floor, then room, each group in
 *  row and position order. Racks with no place come first, under no heading. */
export function groupRacks<R extends Pick<Rack, 'building' | 'floor' | 'room' | 'row' | 'position' | 'name'>>(racks: readonly R[]): { heading: string; racks: R[] }[] {
  const key = (r: R) => [r.building, r.floor, r.room].map((v) => (v ?? '').trim()).join('\u0000');
  const groups = new Map<string, R[]>();
  for (const r of racks) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const cmp = (a: string | undefined, b: string | undefined) => (a ?? '').localeCompare(b ?? '', undefined, { numeric: true });
  return [...groups.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([k, list]) => ({
      heading: k.split('\u0000').map((v, i) => (v ? (i === 1 ? `Floor ${v}` : i === 2 ? `Room ${v}` : v) : '')).filter(Boolean).join(' · '),
      racks: list.sort((a, b) => cmp(a.row, b.row) || cmp(a.position, b.position) || cmp(a.name, b.name)),
    }));
}

/** The rack's depth a box takes, 0–1, for the side view: its own
 *  millimetres against the rack's where both are given; otherwise most of
 *  the rack for a full-depth box and well under half for a half-depth one. */
export const DEFAULT_RACK_DEPTH_MM = 1000;
export const DEFAULT_RACK_WIDTH_MM = 600;
export function depthFraction(d: Pick<Rackable, 'depthMm' | 'rackDepth'>, rack: Pick<Rack, 'depthMm'>): number {
  const rackDepth = rack.depthMm ?? DEFAULT_RACK_DEPTH_MM;
  if (typeof d.depthMm === 'number' && d.depthMm > 0) return Math.max(0.06, Math.min(1, d.depthMm / rackDepth));
  return d.rackDepth === 'half' ? 0.4 : 0.85;
}

/** How a rack breathes, from what is in it. */
export function airflowOf(items: readonly Rackable[]): { frontToBack: number; backToFront: number; side: number; passive: number; unset: number; mixed: boolean } {
  const out = { frontToBack: 0, backToFront: 0, side: 0, passive: 0, unset: 0, mixed: false };
  for (const d of items) {
    switch (d.airflow) {
      case 'front-to-back': out.frontToBack += 1; break;
      case 'back-to-front': out.backToFront += 1; break;
      case 'side-to-side': out.side += 1; break;
      case 'passive': out.passive += 1; break;
      default: out.unset += 1;
    }
  }
  out.mixed = out.frontToBack > 0 && out.backToFront > 0;
  return out;
}

/** What a rack carries, in U, watts and kilograms. */
export function usageOf(rack: Pick<Rack, 'units'>, items: readonly Rackable[]): { used: number; reserved: number; free: number; powerW: number; weightKg: number; unknownPower: number } {
  let used = 0;
  let reserved = 0;
  let powerW = 0;
  let weightKg = 0;
  let unknownPower = 0;
  const seen = new Set<number>();
  for (const d of items) {
    const span = spanOf(d);
    if (span) {
      for (let u = span.bottom; u <= span.top; u++) {
        if (seen.has(u)) continue;
        seen.add(u);
        if (d.furniture === 'reserved') reserved += 1; else used += 1;
      }
    }
    if (typeof d.powerW === 'number') powerW += d.powerW; else if (d.kind === 'device') unknownPower += 1;
    if (typeof d.weightKg === 'number') weightKg += d.weightKg;
  }
  return { used, reserved, free: Math.max(0, rack.units - used - reserved), powerW, weightKg, unknownPower };
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
 * Racks from the devices that name one: a rack for every distinct
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
