/**
 * A rack elevation as DXF: the drawing for anyone's CAD. ASCII DXF
 * in the R12 dialect every reader takes — LINE, LWPOLYLINE-free (R12 has
 * POLYLINE; LINEs are enough for rectangles and readers never argue about
 * them), TEXT — in millimetres, with the rack's origin at its bottom-left
 * front corner, on named layers so the receiver can switch them off:
 * RACK (posts and frame), U (the unit lines and their numbers), ITEMS (each
 * box as a rectangle), LABELS (what each box is), CABLES (the patch cables),
 * TITLE (the title block).
 *
 * A rack unit is 44.45 mm and a 19-inch opening 482.6 mm; the frame is the
 * rack's width and the drawing is the face, so depth is a number in the
 * title block, not a dimension here.
 */
import { elevation, furnitureRackables, placeOf, type Rack, type RackFace, type Rackable } from './rack';
import { patchCablesFor, type LinkLike } from './rackCables';

export const U_MM = 44.45;
export const OPENING_MM = 482.6;

function pair(code: number, value: string | number): string {
  return `${code}\n${value}`;
}

function line(layer: string, x1: number, y1: number, x2: number, y2: number): string {
  return [pair(0, 'LINE'), pair(8, layer), pair(10, r(x1)), pair(20, r(y1)), pair(30, 0), pair(11, r(x2)), pair(21, r(y2)), pair(31, 0)].join('\n');
}

function rect(layer: string, x: number, y: number, w: number, h: number): string {
  return [line(layer, x, y, x + w, y), line(layer, x + w, y, x + w, y + h), line(layer, x + w, y + h, x, y + h), line(layer, x, y + h, x, y)].join('\n');
}

function text(layer: string, x: number, y: number, height: number, value: string, centred = false): string {
  const parts = [pair(0, 'TEXT'), pair(8, layer), pair(10, r(x)), pair(20, r(y)), pair(30, 0), pair(40, r(height)), pair(1, value.replace(/[\r\n]+/g, ' '))];
  if (centred) parts.push(pair(72, 1), pair(11, r(x)), pair(21, r(y)), pair(31, 0));
  return parts.join('\n');
}

const r = (n: number) => Math.round(n * 100) / 100;

export interface DxfOptions {
  project?: string;
  revision?: string;
  date?: Date;
  links?: readonly LinkLike[];
}

/** One rack, or several side by side 300 mm apart, as a DXF file. */
export function rackElevationDxf(racks: readonly Rack[], devices: readonly Rackable[], face: RackFace, options: DxfOptions = {}): string {
  const layers = ['RACK', 'U', 'ITEMS', 'LABELS', 'CABLES', 'TITLE'];
  const ents: string[] = [];
  let x0 = 0;
  const GAP = 300;
  racks.forEach((rack) => {
    const width = rack.widthMm ?? 600;
    const height = rack.units * U_MM;
    const inset = (width - OPENING_MM) / 2;
    const items = [...devices, ...furnitureRackables(rack)];
    const view = elevation(rack, items, face);
    // The frame and the posts.
    ents.push(rect('RACK', x0, 0, width, height + 100));
    ents.push(rect('RACK', x0 + inset - 20, 50, 20, height));
    ents.push(rect('RACK', x0 + inset + OPENING_MM, 50, 20, height));
    ents.push(text('TITLE', x0 + width / 2, height + 110, 20, `${rack.name} · ${rack.units}U · ${face}`, true));
    // The units, numbered from the bottom unless the rack counts from the top.
    for (let u = 1; u <= rack.units; u++) {
      const y = 50 + (u - 1) * U_MM;
      ents.push(line('U', x0 + inset, y, x0 + inset + OPENING_MM, y));
      const label = rack.numbering === 'top' ? rack.units - u + 1 : u;
      ents.push(text('U', x0 + inset - 45, y + U_MM / 2 - 4, 8, String(label)));
    }
    ents.push(line('U', x0 + inset, 50 + height, x0 + inset + OPENING_MM, 50 + height));
    // The boxes.
    const portAt = new Map<string, (n: number | null) => { x: number; y: number }>();
    for (const item of view.items) {
      const y = 50 + (item.bottom - 1) * U_MM;
      const h = (item.top - item.bottom + 1) * U_MM;
      const x = x0 + inset + 2;
      ents.push(rect('ITEMS', x, y + 1, OPENING_MM - 4, h - 2));
      if (item.seen === 'behind') ents.push(line('ITEMS', x, y + 1, x + OPENING_MM - 4, y + h - 1), line('ITEMS', x, y + h - 1, x + OPENING_MM - 4, y + 1));
      const what = item.device.kind === 'furniture' ? item.device.furniture : item.device.deviceType;
      ents.push(text('LABELS', x + 8, y + h / 2 - 4, Math.min(10, h * 0.45), `${item.device.label}${what ? ` [${what}]` : ''}${item.seen === 'behind' ? ' (rear)' : ''}`));
      const ports = item.device.portCount ?? 0;
      if (ports > 0 && item.seen === 'face') {
        const n = Math.min(ports, 48);
        const rows = 2;
        const cols = Math.ceil(n / rows);
        const cell = Math.min(12, (OPENING_MM * 0.5) / cols);
        const px0 = x + OPENING_MM - 20 - cols * cell;
        for (let i = 0; i < n; i++) {
          const col = Math.floor(i / rows);
          const row = i % rows;
          ents.push(rect('ITEMS', px0 + col * cell, y + h / 2 - 9 + row * 9, cell - 2, 7));
        }
        portAt.set(item.device.id, (k) => (!k || k > n ? { x: x + OPENING_MM - 4, y: y + h / 2 } : { x: px0 + Math.floor((k - 1) / rows) * cell + (cell - 2) / 2, y: y + h / 2 - 9 + ((k - 1) % rows) * 9 + 3.5 }));
      } else {
        portAt.set(item.device.id, () => ({ x: x + OPENING_MM - 4, y: y + h / 2 }));
      }
    }
    // The cables, down the left of the opening.
    if (face === 'front' && options.links?.length) {
      patchCablesFor(rack.name, items, options.links).forEach((c, i) => {
        const a = portAt.get(c.from.itemId)?.(c.from.port);
        if (!a) return;
        if ('elsewhere' in c.to) {
          ents.push(line('CABLES', a.x, a.y, a.x, a.y - 8), line('CABLES', a.x, a.y - 8, x0 + width + 40, a.y - 8), text('CABLES', x0 + width + 44, a.y - 11, 7, `${c.to.label}, ${c.to.elsewhere}`));
          return;
        }
        const b = portAt.get(c.to.itemId)?.(c.to.port);
        if (!b) return;
        const cx = x0 + inset + 8 + (i % 8) * 6;
        ents.push(line('CABLES', a.x, a.y, a.x, a.y - 8), line('CABLES', a.x, a.y - 8, cx, a.y - 8), line('CABLES', cx, a.y - 8, cx, b.y - 8), line('CABLES', cx, b.y - 8, b.x, b.y - 8), line('CABLES', b.x, b.y - 8, b.x, b.y));
      });
    }
    x0 += width + GAP;
  });
  // The title block, bottom right of the sheet.
  const totalW = x0 - GAP;
  const date = (options.date ?? new Date()).toISOString().slice(0, 10);
  const tb = { x: totalW - 360, y: -140, w: 360, h: 120 };
  ents.push(rect('TITLE', tb.x, tb.y, tb.w, tb.h));
  ents.push(text('TITLE', tb.x + 10, tb.y + tb.h - 24, 12, options.project ?? 'Coreview'));
  ents.push(text('TITLE', tb.x + 10, tb.y + tb.h - 48, 9, racks.map((k) => k.name).join(', ')));
  const places = [...new Set(racks.map(placeOf).filter(Boolean))].join('; ');
  ents.push(text('TITLE', tb.x + 10, tb.y + tb.h - 68, 8, places || ''));
  ents.push(text('TITLE', tb.x + 10, tb.y + tb.h - 88, 8, `${face} elevation · 1 U = ${U_MM} mm · opening ${OPENING_MM} mm`));
  ents.push(text('TITLE', tb.x + 10, tb.y + tb.h - 108, 8, `${date}${options.revision ? ` · rev ${options.revision}` : ''} · Coreview`));

  const head = [
    pair(0, 'SECTION'), pair(2, 'HEADER'), pair(9, '$ACADVER'), pair(1, 'AC1009'), pair(9, '$INSUNITS'), pair(70, 4), pair(0, 'ENDSEC'),
    pair(0, 'SECTION'), pair(2, 'TABLES'), pair(0, 'TABLE'), pair(2, 'LAYER'), pair(70, layers.length),
    ...layers.map((l, i) => [pair(0, 'LAYER'), pair(2, l), pair(70, 0), pair(62, (i % 7) + 1), pair(6, 'CONTINUOUS')].join('\n')),
    pair(0, 'ENDTAB'), pair(0, 'ENDSEC'),
    pair(0, 'SECTION'), pair(2, 'ENTITIES'),
  ];
  return [...head, ...ents, pair(0, 'ENDSEC'), pair(0, 'EOF')].join('\n') + '\n';
}
