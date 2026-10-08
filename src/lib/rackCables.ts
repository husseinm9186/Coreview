/**
 * The cables a rack elevation draws.
 *
 * Patch cables are the diagram's links: every link between two devices
 * placed in one rack runs from the port its label names on one faceplate to
 * the port on the other, coloured by its cable type; a link to a device
 * elsewhere ends in a stub that names where. Power cords are the rack's own
 * fact: a device's or item's `powerFeeds` name the PDU and the outlet each
 * supply is plugged into. Both are pure geometry-free facts here; the panel
 * and the export decide where a port sits on a faceplate.
 */
import type { CableType } from './cables';
import type { Rackable } from './rack';
import { furnitureSpec } from './rackFurniture';

/** A PDU's outlets: what it says, else what its kind usually has, else eight. */
export function outletsOf(pdu: Pick<Rackable, 'outlets' | 'furniture'> | undefined): number {
  if (!pdu) return 8;
  return pdu.outlets ?? (pdu.furniture ? furnitureSpec(pdu.furniture).ports : undefined) ?? 8;
}

/** The number a port label carries: the last run of digits — `Gi1/0/5` is
 *  port 5, `eth12` is 12, `Port 3` is 3, `24` is 24. Null when it has none. */
export function portNumber(label: string | undefined): number | null {
  if (!label) return null;
  const m = /(\d+)(?!.*\d)/.exec(label.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

export interface PatchEnd {
  itemId: string;
  label: string;
  /** The port's number on the faceplate, or null when the label names none. */
  port: number | null;
  portLabel: string;
}

/** The other end of a link that leaves the rack — in another rack
 *  (`rack` names it) or in none (`rack` absent), which the elevation does
 *  not draw: where a device is not is no fact about this rack. */
export interface AwayEnd {
  elsewhere: string;
  rack?: string;
  label: string;
  portLabel: string;
}

export interface PatchCable {
  edgeId: string;
  from: PatchEnd;
  /** The other end: in this rack, or elsewhere with where. */
  to: PatchEnd | AwayEnd;
  cableType: CableType | null;
  status?: string;
  cableLength?: string;
  /** The link's own colour, over the cable type's. */
  colour?: string;
}

export const CABLE_COLOURS: Record<CableType, string> = {
  // The jacket colours the trade uses, more or less: blue copper, yellow
  // single-mode, aqua multimode, grey coax; the rest are ours.
  copper: '#5ea1ff',
  'fiber-sm': '#f2d36b',
  'fiber-mm': '#2cc6c6',
  coax: '#98a3b3',
  wireless: '#b07ff0',
  wan: '#e8a33d',
  trunk: '#3fb66a',
};

export interface LinkLike {
  id: string;
  source: string;
  target: string;
  sourcePortLabel?: string;
  targetPortLabel?: string;
  cableType?: string;
  cableLength?: string;
  /** A colour of the link's own, when `colorMode` is 'fixed'. */
  color?: string;
  colorMode?: string;
}

const sameRack = (a: string | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The patch cables for one rack: each link with at least one end placed in
 * it. Both ends in the rack: a cable between the two faceplates. One end
 * elsewhere: a stub from the end that is here.
 */
export function patchCablesFor(
  rackName: string,
  items: readonly Rackable[],
  links: readonly LinkLike[],
  statusOf?: (edgeId: string) => string,
): PatchCable[] {
  const here = new Map(items.filter((d) => sameRack(d.rack, rackName) && d.rackU !== undefined).map((d) => [d.id, d]));
  const anywhere = new Map(items.map((d) => [d.id, d]));
  const out: PatchCable[] = [];
  for (const l of links) {
    const a = here.get(l.source);
    const b = here.get(l.target);
    if (!a && !b) continue;
    const end = (d: Rackable, portLabel: string | undefined): PatchEnd => ({ itemId: d.id, label: d.label, port: portNumber(portLabel), portLabel: portLabel ?? '' });
    const away = (id: string, portLabel: string | undefined): AwayEnd => {
      const d = anywhere.get(id);
      const racked = d?.rackU !== undefined && Boolean(d.rack?.trim());
      const where = racked ? `${d!.rack} U${d!.rackU}` : d?.rack ? d.rack : 'not racked';
      return { elsewhere: where, ...(racked ? { rack: d!.rack!.trim() } : {}), label: d?.label ?? id, portLabel: portLabel ?? '' };
    };
    const cableType = (l.cableType ?? null) as CableType | null;
    const common = { edgeId: l.id, cableType, status: statusOf?.(l.id), cableLength: l.cableLength, ...(l.colorMode === 'fixed' && l.color ? { colour: l.color } : {}) };
    if (a && b) out.push({ ...common, from: end(a, l.sourcePortLabel), to: end(b, l.targetPortLabel) });
    else if (a) out.push({ ...common, from: end(a, l.sourcePortLabel), to: away(l.target, l.targetPortLabel) });
    else out.push({ ...common, from: end(b!, l.targetPortLabel), to: away(l.source, l.sourcePortLabel) });
  }
  return out;
}

/** A cord from one of an item's supplies to a PDU outlet in this rack. */
export interface PowerCord {
  itemId: string;
  label: string;
  /** Which supply, 0 for A, 1 for B. */
  supply: number;
  pduId: string;
  pduLabel: string;
  outlet: number;
  /** Beyond the PDU's outlets, or the PDU is not in this rack. */
  problem?: string;
}

export function powerCordsFor(rackName: string, items: readonly Rackable[]): PowerCord[] {
  const here = items.filter((d) => sameRack(d.rack, rackName));
  const byId = new Map(items.map((d) => [d.id, d]));
  const out: PowerCord[] = [];
  for (const d of here) {
    (d.powerFeeds ?? []).forEach((f, supply) => {
      const pdu = byId.get(f.pduId);
      const outlets = outletsOf(pdu);
      out.push({
        itemId: d.id,
        label: d.label,
        supply,
        pduId: f.pduId,
        pduLabel: pdu?.label ?? f.pduId,
        outlet: f.outlet,
        problem: !pdu
          ? 'the PDU is no longer there'
          : !sameRack(pdu.rack, rackName)
            ? `${pdu.label} is in ${pdu.rack ?? 'another rack'}`
            : f.outlet > outlets
              ? `${pdu.label} has ${outlets} outlets`
              : undefined,
      });
    });
  }
  return out;
}

/** What a PDU carries — outlets taken, and the watts of what it feeds. */
export function pduLoad(pdu: Rackable, items: readonly Rackable[]): { outlets: number; used: number; free: number; watts: number; twice: string[] } {
  const outlets = outletsOf(pdu);
  const taken = new Set<number>();
  let watts = 0;
  const twice: string[] = [];
  for (const d of items) {
    const feeds = (d.powerFeeds ?? []).filter((f) => f.pduId === pdu.id);
    if (feeds.length === 0) continue;
    for (const f of feeds) taken.add(f.outlet);
    // A box with two supplies on one PDU has no redundancy worth the name.
    if (feeds.length > 1 || ((d.powerFeeds?.length ?? 0) > 1 && feeds.length === d.powerFeeds!.length)) twice.push(d.label);
    // Each supply shares the draw; a box on two PDUs puts half on each.
    watts += (d.powerW ?? 0) * (feeds.length / Math.max(1, d.powerFeeds?.length ?? 1));
  }
  return { outlets, used: taken.size, free: Math.max(0, outlets - taken.size), watts: Math.round(watts), twice };
}

/** A link that leaves the rack for a device in no rack. */
export function isUnracked(to: PatchCable['to']): boolean {
  return 'elsewhere' in to && !to.rack;
}

/** Per box, the links out to devices in no rack — the count the
 *  faceplate carries and the list under the rack. */
export function linksOutOf(cables: readonly PatchCable[]): Map<string, { label: string; lines: string[] }> {
  const out = new Map<string, { label: string; lines: string[] }>();
  for (const c of cables) {
    if (!('elsewhere' in c.to) || !isUnracked(c.to)) continue;
    const entry = out.get(c.from.itemId) ?? { label: c.from.label, lines: [] };
    entry.lines.push(`${c.from.portLabel || '?'} → ${c.to.label}${c.to.portLabel ? ` ${c.to.portLabel}` : ''}`);
    out.set(c.from.itemId, entry);
  }
  return out;
}

/** Stub labels that would print over each other spread apart. Each
 *  wanted `y` is kept in order and pushed down just enough to sit `gap`
 *  below the one before it; the result is in the input's order. */
export function spreadStubs(ys: readonly number[], gap: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const out = new Array<number>(ys.length);
  let last = -Infinity;
  for (const { y, i } of order) {
    const at = Math.max(y, last + gap);
    out[i] = at;
    last = at;
  }
  return out;
}

/** What a cable is drawn in — the link's own colour when it has
 *  one, else its cable type's, else grey. */
export function cableColour(c: Pick<PatchCable, 'colour' | 'cableType'>, fallback = '#98a3b3'): string {
  return c.colour ?? (c.cableType ? CABLE_COLOURS[c.cableType] : fallback);
}
