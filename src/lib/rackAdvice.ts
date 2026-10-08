/**
 * What a rack planner should tell you: the things a person who
 * has built a few racks checks by eye, computed from what the rack holds.
 * Pure: the panel lists what comes back under the rack, the test reads it.
 *
 * - top-heavy: more weight above the rack's middle than below it;
 * - unblanked U in a front-to-back rack, where open U let hot air back round;
 * - a PDU over its outlets or its rating;
 * - a device with two supplies on one PDU, which is no redundancy;
 * - stack members not adjacent, which the stack cables may not reach;
 * - a cable shorter than the run between its two ports.
 */
import { U_MM, spanOf, takesSpace, type Rack, type Rackable } from './rack';
import { outletsOf, patchCablesFor, pduLoad, type LinkLike } from './rackCables';
import type { Stack } from './stacking';

export type AdviceKind = 'top-heavy' | 'unblanked' | 'pdu-outlets' | 'pdu-rating' | 'no-redundancy' | 'stack-apart' | 'cable-short';

export interface Advice {
  kind: AdviceKind;
  /** One line, for the list under the rack. */
  text: string;
  /** The items it is about, for highlighting. */
  items: string[];
  severity: 'warn' | 'note';
}

/** A cable length as typed — "2 m", "0.5m", "50 cm", "3 ft", "10'" — in millimetres, or null. */
export function lengthMm(text: string | undefined): number | null {
  if (!text) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m|ft|feet|foot|'|in|")?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  switch ((m[2] ?? 'm').toLowerCase()) {
    case 'mm': return n;
    case 'cm': return n * 10;
    case 'ft': case 'feet': case 'foot': case "'": return n * 304.8;
    case 'in': case '"': return n * 25.4;
    default: return n * 1000;
  }
}

/** The run a patch cable needs between two U in one rack: the vertical
 *  distance plus a loop at each end and the width of the opening it crosses. */
export function runMm(uA: number, uB: number): number {
  return Math.abs(uA - uB) * U_MM + 2 * 150 + 300;
}

export function rackAdvice(
  rack: Rack,
  members: readonly Rackable[],
  stacks: readonly Stack[] = [],
  links: readonly LinkLike[] = [],
): Advice[] {
  const out: Advice[] = [];
  const placed = members.filter((d) => d.rackU !== undefined && takesSpace(d));

  // Top-heavy: weight above the middle U against weight below it, when
  // anything has a weight at all and the rack is tall enough to matter.
  if (rack.units >= 12) {
    const mid = rack.units / 2;
    let above = 0;
    let below = 0;
    const heavy: string[] = [];
    for (const d of placed) {
      const span = spanOf(d);
      if (!span || !d.weightKg) continue;
      const centre = (span.bottom + span.top) / 2;
      if (centre > mid) { above += d.weightKg; heavy.push(d.id); } else below += d.weightKg;
    }
    if (above > 0 && above > below * 1.5 && above - below >= 10) {
      out.push({ kind: 'top-heavy', severity: 'warn', items: heavy, text: `Top-heavy: ${Math.round(above)} kg above the middle, ${Math.round(below)} kg below — move the heavy boxes down.` });
    }
  }

  // Unblanked U in a front-to-back rack: open U between the boxes let the
  // hot aisle's air back round to the inlets. Only when the rack is cooled
  // that way, which its boxes' airflow says.
  const f2b = placed.filter((d) => d.airflow === 'front-to-back').length;
  if (f2b >= 2) {
    const taken = new Set<number>();
    for (const d of placed) {
      const span = spanOf(d);
      if (span) for (let u = span.bottom; u <= span.top; u++) taken.add(u);
    }
    const lowest = Math.min(...[...taken]);
    const highest = Math.max(...[...taken]);
    const gaps: number[] = [];
    for (let u = lowest; u <= highest; u++) if (!taken.has(u)) gaps.push(u);
    if (gaps.length > 0) {
      out.push({ kind: 'unblanked', severity: 'note', items: [], text: `${gaps.length} open U between the boxes (U${gaps[0]}${gaps.length > 1 ? `–U${gaps[gaps.length - 1]}` : ''}) in a front-to-back rack — blank them, or hot air comes back round.` });
    }
  }

  // PDUs: outlets and rating, and the box on one PDU twice.
  for (const p of members.filter((d) => d.furniture === 'pdu' || d.furniture === 'pdu-vertical')) {
    const load = pduLoad(p, members);
    if (load.used > outletsOf(p)) out.push({ kind: 'pdu-outlets', severity: 'warn', items: [p.id], text: `${p.label}: ${load.used} cords on ${load.outlets} outlets.` });
    if (p.powerW && load.watts > p.powerW) out.push({ kind: 'pdu-rating', severity: 'warn', items: [p.id], text: `${p.label}: ${load.watts} W drawn against its ${p.powerW} W rating.` });
    if (load.twice.length > 0) out.push({ kind: 'no-redundancy', severity: 'warn', items: [p.id], text: `${load.twice.join(', ')}: both supplies on ${p.label} — a second feed should come from another PDU.` });
  }

  // Stack members apart: the stack cables are short (0.5–3 m), so members
  // sit one above the other. Flag any member more than one U away from
  // the next in order.
  const here = new Map(members.map((d) => [d.id, d]));
  for (const s of stacks) {
    const inRack = s.members.map((m) => here.get(m.nodeId)).filter((d): d is Rackable => !!d && d.rackU !== undefined);
    if (inRack.length < 2) continue;
    const spans = inRack.map((d) => ({ d, span: spanOf(d)! })).sort((a, b) => a.span.bottom - b.span.bottom);
    const apart: string[] = [];
    for (let i = 1; i < spans.length; i++) {
      const gap = spans[i]!.span.bottom - spans[i - 1]!.span.top - 1;
      if (gap > 1) apart.push(spans[i - 1]!.d.id, spans[i]!.d.id);
    }
    if (apart.length > 0) out.push({ kind: 'stack-apart', severity: 'note', items: [...new Set(apart)], text: `${s.name}: its members are not next to each other — stack cables are short, keep them together.` });
  }

  // Cables shorter than their run.
  for (const c of patchCablesFor(rack.name, members, links)) {
    if ('elsewhere' in c.to) continue;
    const have = lengthMm(c.cableLength);
    if (have === null) continue;
    const a = here.get(c.from.itemId);
    const b = here.get(c.to.itemId);
    if (!a || !b || a.rackU === undefined || b.rackU === undefined) continue;
    const need = runMm(a.rackU, b.rackU);
    if (have < need) {
      out.push({ kind: 'cable-short', severity: 'warn', items: [a.id, b.id], text: `${c.from.label} ${c.from.portLabel} ↔ ${c.to.label} ${c.to.portLabel}: ${c.cableLength!.trim()} is short for ${Math.abs(a.rackU - b.rackU)}U apart — about ${(need / 1000).toFixed(1)} m with slack.` });
    }
  }

  return out;
}
