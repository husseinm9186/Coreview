/**
 * The floor: racks as footprints in a room.
 *
 * Everything is in millimetres on the floor, as the racks are. A rack
 * without a place of its own on the floor stands where its row and
 * position say: rows run across the room one behind the other, an aisle
 * apart, and the racks in a row stand shoulder to shoulder in position
 * order. Rows alternate which way they face, so two rows' fronts look at
 * each other across a cold aisle and their backs across a hot one — the
 * way a room is built. A rack dragged somewhere keeps that spot; "number
 * as they stand" reads rows and positions back off the floor.
 */
import { DEFAULT_RACK_DEPTH_MM, DEFAULT_RACK_WIDTH_MM, type Rack } from './rack';

export type Facing = 'n' | 'e' | 's' | 'w';

/** The aisle between rows, and the band each side of a rack the air uses. */
export const AISLE_MM = 1200;
export const AIR_BAND_MM = 600;
/** The floor is snapped to this when a rack is dropped. */
export const FLOOR_SNAP_MM = 100;

export interface Footprint {
  rack: Rack;
  /** Top-left on the floor, mm. */
  x: number;
  y: number;
  /** As it stands: width across the row, depth into it, before facing. */
  w: number;
  h: number;
  facing: Facing;
  /** Whether the spot is the rack's own or worked out from its row. */
  placed: boolean;
}

const cmp = (a: string | undefined, b: string | undefined) => (a ?? '').localeCompare(b ?? '', undefined, { numeric: true });

/** The racks of one room as footprints. */
export function footprintsFor(racks: readonly Rack[]): Footprint[] {
  const rows = [...new Set(racks.map((r) => (r.row ?? '').trim()))].sort(cmp);
  const depth = Math.max(DEFAULT_RACK_DEPTH_MM, ...racks.map((r) => r.depthMm ?? 0));
  const out: Footprint[] = [];
  const cursor = new Map<string, number>();
  const sorted = [...racks].sort((a, b) => cmp(a.row, b.row) || cmp(a.position, b.position) || cmp(a.name, b.name));
  for (const rack of sorted) {
    const w = rack.widthMm ?? DEFAULT_RACK_WIDTH_MM;
    const h = rack.depthMm ?? DEFAULT_RACK_DEPTH_MM;
    const row = (rack.row ?? '').trim();
    const rowIndex = rows.indexOf(row);
    const defaultFacing: Facing = rowIndex % 2 === 0 ? 's' : 'n';
    const facing = rack.facing ?? defaultFacing;
    if (typeof rack.floorX === 'number' && typeof rack.floorY === 'number') {
      out.push({ rack, x: rack.floorX, y: rack.floorY, w, h, facing, placed: true });
      continue;
    }
    const x = cursor.get(row) ?? 0;
    cursor.set(row, x + w);
    out.push({ rack, x, y: rowIndex * (depth + AISLE_MM), w, h, facing, placed: false });
  }
  return out;
}

/** The footprint's box on the floor, which turns with its facing. */
export function footprintBox(fp: Footprint): { x: number; y: number; w: number; h: number } {
  const turned = fp.facing === 'e' || fp.facing === 'w';
  return { x: fp.x, y: fp.y, w: turned ? fp.h : fp.w, h: turned ? fp.w : fp.h };
}

export type AirKind = 'cold' | 'hot' | 'mixed';

export interface AirBand {
  kind: AirKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The bands of air in front of and behind a rack, from what its boxes do:
 *  front-to-back breathes cold in at the front and blows hot out of the
 *  back; back-to-front the other way; both at once is a mixed aisle; a rack
 *  whose boxes say nothing has none. */
export function airBands(fp: Footprint, air: { frontToBack: number; backToFront: number }): AirBand[] {
  if (air.frontToBack === 0 && air.backToFront === 0) return [];
  const mixed = air.frontToBack > 0 && air.backToFront > 0;
  const front: AirKind = mixed ? 'mixed' : air.frontToBack > 0 ? 'cold' : 'hot';
  const back: AirKind = mixed ? 'mixed' : air.frontToBack > 0 ? 'hot' : 'cold';
  const b = footprintBox(fp);
  const band = AIR_BAND_MM;
  switch (fp.facing) {
    case 's': return [{ kind: front, x: b.x, y: b.y + b.h, w: b.w, h: band }, { kind: back, x: b.x, y: b.y - band, w: b.w, h: band }];
    case 'n': return [{ kind: front, x: b.x, y: b.y - band, w: b.w, h: band }, { kind: back, x: b.x, y: b.y + b.h, w: b.w, h: band }];
    case 'e': return [{ kind: front, x: b.x + b.w, y: b.y, w: band, h: b.h }, { kind: back, x: b.x - band, y: b.y, w: band, h: b.h }];
    default: return [{ kind: front, x: b.x - band, y: b.y, w: band, h: b.h }, { kind: back, x: b.x + b.w, y: b.y, w: band, h: b.h }];
  }
}

/** The floor's extent with room round it, mm. */
export function floorBounds(fps: readonly Footprint[], margin = 1000): { x: number; y: number; w: number; h: number } {
  if (fps.length === 0) return { x: -margin, y: -margin, w: 2 * margin + 3000, h: 2 * margin + 2000 };
  const boxes = fps.map(footprintBox);
  const x0 = Math.min(...boxes.map((b) => b.x)) - margin;
  const y0 = Math.min(...boxes.map((b) => b.y)) - margin;
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + margin;
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + margin;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Rows and positions read back off the floor: racks whose tops are within
 *  half a rack depth of each other are one row, lettered from the top;
 *  positions count from the left, two digits. */
export function numberAsTheyStand(fps: readonly Footprint[]): { id: string; row: string; position: string }[] {
  const byY = [...fps].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Footprint[][] = [];
  for (const fp of byY) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(fp.y - last[0]!.y) <= DEFAULT_RACK_DEPTH_MM / 2) last.push(fp);
    else rows.push([fp]);
  }
  const out: { id: string; row: string; position: string }[] = [];
  rows.forEach((row, i) => {
    const letter = String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');
    [...row].sort((a, b) => a.x - b.x).forEach((fp, j) => out.push({ id: fp.rack.id, row: letter, position: String(j + 1).padStart(2, '0') }));
  });
  return out;
}

export function snapFloor(mm: number): number {
  return Math.round(mm / FLOOR_SNAP_MM) * FLOOR_SNAP_MM;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const AIR_FILL: Record<AirKind, string> = { cold: '#bfe0ff', hot: '#ffc9c0', mixed: '#ffe3a8' };

/** The floor as an SVG: a metre grid, the air, the footprints with their
 *  names and positions and a mark on the front, and a legend. One
 *  pixel per centimetre. */
export function floorSvg(
  heading: string,
  fps: readonly Footprint[],
  airOf: (rack: Rack) => { frontToBack: number; backToFront: number },
): string {
  const S = 0.1;
  const b = floorBounds(fps);
  const W = Math.round(b.w * S);
  const H = Math.round(b.h * S) + 40;
  const X = (mm: number) => Math.round((mm - b.x) * S * 10) / 10;
  const Y = (mm: number) => Math.round((mm - b.y) * S * 10) / 10 + 32;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, Segoe UI, sans-serif" class="cv-floor">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<text x="10" y="20" font-size="13" font-weight="600" fill="#1f2933">${esc(heading || 'Floor')}</text>`,
    `<text x="${W - 10}" y="20" text-anchor="end" font-size="9" fill="#52606d">1 m grid · front edge marked</text>`,
  ];
  // The metre grid.
  const g0x = Math.ceil(b.x / 1000) * 1000;
  const g0y = Math.ceil(b.y / 1000) * 1000;
  for (let mm = g0x; mm <= b.x + b.w; mm += 1000) parts.push(`<line x1="${X(mm)}" y1="${Y(b.y)}" x2="${X(mm)}" y2="${Y(b.y + b.h)}" stroke="#e3e8ee" stroke-width="1"/>`);
  for (let mm = g0y; mm <= b.y + b.h; mm += 1000) parts.push(`<line x1="${X(b.x)}" y1="${Y(mm)}" x2="${X(b.x + b.w)}" y2="${Y(mm)}" stroke="#e3e8ee" stroke-width="1"/>`);
  // The air, under the racks.
  for (const fp of fps) {
    for (const band of airBands(fp, airOf(fp.rack))) {
      parts.push(`<rect x="${X(band.x)}" y="${Y(band.y)}" width="${band.w * S}" height="${band.h * S}" fill="${AIR_FILL[band.kind]}" opacity="0.7"/>`);
    }
  }
  for (const fp of fps) {
    const box = footprintBox(fp);
    const x = X(box.x);
    const y = Y(box.y);
    const w = box.w * S;
    const h = box.h * S;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#f4f6f8" stroke="#3e4c59" stroke-width="1.2"/>`);
    // The front edge, heavier.
    const front =
      fp.facing === 's' ? `M${x},${y + h} L${x + w},${y + h}`
      : fp.facing === 'n' ? `M${x},${y} L${x + w},${y}`
      : fp.facing === 'e' ? `M${x + w},${y} L${x + w},${y + h}`
      : `M${x},${y} L${x},${y + h}`;
    parts.push(`<path d="${front}" stroke="#1f2933" stroke-width="3.5"/>`);
    parts.push(`<text x="${x + w / 2}" y="${y + h / 2 - 2}" text-anchor="middle" font-size="9" font-weight="600" fill="#1f2933">${esc(fp.rack.name)}</text>`);
    const place = [fp.rack.row ? `Row ${fp.rack.row}` : '', fp.rack.position ?? ''].filter(Boolean).join(' · ');
    if (place) parts.push(`<text x="${x + w / 2}" y="${y + h / 2 + 9}" text-anchor="middle" font-size="7.5" fill="#52606d">${esc(place)}</text>`);
  }
  // The legend.
  const lx = 10;
  const ly = H - 8;
  parts.push(
    `<rect x="${lx}" y="${ly - 8}" width="10" height="8" fill="${AIR_FILL.cold}"/><text x="${lx + 14}" y="${ly}" font-size="8" fill="#52606d">cold aisle</text>`,
    `<rect x="${lx + 70}" y="${ly - 8}" width="10" height="8" fill="${AIR_FILL.hot}"/><text x="${lx + 84}" y="${ly}" font-size="8" fill="#52606d">hot aisle</text>`,
    `<rect x="${lx + 134}" y="${ly - 8}" width="10" height="8" fill="${AIR_FILL.mixed}"/><text x="${lx + 148}" y="${ly}" font-size="8" fill="#52606d">mixed</text>`,
  );
  parts.push('</svg>');
  return parts.join('');
}
