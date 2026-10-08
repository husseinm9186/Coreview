/**
 * Rack elevations as an SVG file: every rack side by
 * side, from one face, with the U numbers down the rails, where each rack
 * stands, the furniture and reservations it holds,
 * and a stack's cables down its side — the drawing that goes in a
 * change pack or on the cage door.
 *
 * Plain greys on white so it prints; a box seen from behind (full depth,
 * mounted on the other face) is drawn hatched, a reservation dashed, and two
 * boxes that share space are outlined red, the same as the panel shows them.
 */
import { elevation, furnitureRackables, placeOf, usageOf, type Rack, type RackFace, type Rackable } from './rack';
import { cableColour, isUnracked, patchCablesFor, powerCordsFor, spreadStubs, type LinkLike } from './rackCables';
import { stackCables, stackPreset, type Stack } from './stacking';

const UNIT = 18;
const RACK_W = 220;
const RAIL = 26;
const CABLES = 60;
const GAP = 40;
const HEAD = 64;
const WHEEL = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2'];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function rackElevationSvg(
  racks: readonly Rack[],
  devices: readonly Rackable[],
  face: RackFace,
  options: { stacks?: readonly Stack[]; links?: readonly LinkLike[]; statusOf?: (edgeId: string) => string; project?: string; revision?: string; date?: Date } = {},
): string {
  const stacks = options.stacks ?? [];
  const links = options.links ?? [];
  const tallest = Math.max(1, ...racks.map((r) => r.units));
  const step = RACK_W + RAIL + CABLES + GAP;
  const width = Math.max(1, racks.length) * step + GAP;
  const height = HEAD + tallest * UNIT + 80 + 70;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">`,
    '<defs><pattern id="behind" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#9aa5b1" stroke-width="2"/></pattern>',
    '<pattern id="reserved" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#c9a227" stroke-width="1.5"/></pattern></defs>',
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
  ];
  racks.forEach((rack, i) => {
    const x = GAP + i * step;
    const top = HEAD;
    const items = [...devices, ...furnitureRackables(rack)];
    const place = placeOf(rack);
    parts.push(
      `<text x="${x + RAIL + RACK_W / 2}" y="${HEAD - 40}" text-anchor="middle" font-size="15" font-weight="600" fill="#1f2933">${esc(rack.name)}</text>`,
      `<text x="${x + RAIL + RACK_W / 2}" y="${HEAD - 24}" text-anchor="middle" font-size="11" fill="#52606d">${rack.units}U · ${face === 'front' ? 'front' : 'rear'}${place ? ` · ${esc(place)}` : ''}</text>`,
      `<rect x="${x + RAIL - 6}" y="${top}" width="6" height="${rack.units * UNIT}" fill="#3e4c59"/>`,
      `<rect x="${x + RAIL + RACK_W}" y="${top}" width="6" height="${rack.units * UNIT}" fill="#3e4c59"/>`,
      `<rect x="${x + RAIL}" y="${top}" width="${RACK_W}" height="${rack.units * UNIT}" fill="#f5f7fa" stroke="#3e4c59" stroke-width="2"/>`,
    );
    for (let u = rack.units; u >= 1; u--) {
      const y = top + (rack.units - u) * UNIT;
      const label = rack.numbering === 'top' ? rack.units - u + 1 : u;
      parts.push(
        `<text x="${x + RAIL - 9}" y="${y + UNIT / 2 + 4}" text-anchor="end" font-size="${u % 5 === 0 ? 10 : 8}" font-weight="${u % 5 === 0 ? 600 : 400}" fill="#52606d">${label}</text>`,
        `<line x1="${x + RAIL}" y1="${y}" x2="${x + RAIL + RACK_W}" y2="${y}" stroke="${u % 5 === 0 ? '#c3ccd6' : '#e2e7ec'}" stroke-width="1"/>`,
      );
    }
    const view = elevation(rack, items, face);
    const yOf = new Map<string, { y: number; h: number }>();
    // Where a faceplate's ports are, for the cables: two rows of
    // ticks from the right, a tick per port, on anything with a port count.
    const portAt = new Map<string, (n: number | null, kind: 'port' | 'psu' | 'outlet') => { x: number; y: number; top?: number; bottom?: number }>();
    for (const item of view.items) {
      const y = top + (rack.units - item.top) * UNIT;
      const h = (item.top - item.bottom + 1) * UNIT;
      yOf.set(item.device.id, { y, h });
      const reserved = item.device.furniture === 'reserved';
      const furniture = item.device.kind === 'furniture';
      const fill = item.seen === 'face' ? (reserved ? 'url(#reserved)' : furniture ? '#e4e9ee' : '#cbd2d9') : 'url(#behind)';
      const stroke = item.clash ? '#c62828' : reserved ? '#c9a227' : '#3e4c59';
      const label = `${item.device.label}${reserved && item.device.note ? ` — ${item.device.note}` : ''}${item.seen === 'behind' ? ' (rear)' : ''}`;
      parts.push(
        `<rect x="${x + RAIL + 3}" y="${y + 1}" width="${RACK_W - 6}" height="${h - 2}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${item.clash ? 2 : 1}"${reserved ? ' stroke-dasharray="4 3"' : ''}/>`,
        `<text x="${x + RAIL + RACK_W / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-size="11" fill="#1f2933"${item.seen === 'behind' ? ' font-style="italic"' : ''}>${esc(label)}</text>`,
      );
      if (item.device.stack) {
        parts.push(`<circle cx="${x + RAIL + 12}" cy="${y + h / 2}" r="6" fill="#1f2933"/>`, `<text x="${x + RAIL + 12}" y="${y + h / 2 + 3}" text-anchor="middle" font-size="8" fill="#ffffff">${item.device.stack.member}</text>`);
      }
      // The ticks: ports or jacks on the front, outlets on a PDU, supplies on the rear.
      const d = item.device;
      const ports = face === 'front'
        ? (d.kind === 'furniture' ? (d.furniture === 'patch-panel' ? 24 : d.furniture === 'fibre-panel' ? 12 : d.furniture === 'pdu' ? (d.outlets ?? 8) : 0) : (d.portCount ?? 0))
        : (d.kind === 'furniture' ? (d.furniture === 'pdu' ? (d.outlets ?? 8) : 0) : 2);
      if (item.seen === 'face' || face === 'rear') {
        const n = Math.min(ports, 48);
        const rows = face === 'rear' && d.kind !== 'furniture' ? 1 : 2;
        const cols = Math.ceil(n / rows);
        const cell = face === 'rear' && d.kind !== 'furniture' ? 10 : 4;
        const x0 = x + RAIL + RACK_W - 10 - cols * cell;
        const y0 = y + (rows === 1 ? h / 2 - 3 : h / 2 - 4);
        for (let i = 0; i < n; i++) {
          const col = Math.floor(i / rows);
          const row = i % rows;
          parts.push(`<rect x="${x0 + col * cell}" y="${y0 + row * 4}" width="${cell - 1}" height="${rows === 1 ? 6 : 3}" fill="${face === 'rear' && d.kind !== 'furniture' ? 'none' : '#6b7a8c'}" stroke="${face === 'rear' && d.kind !== 'furniture' ? '#6b7a8c' : 'none'}"/>`);
        }
        portAt.set(d.id, (k) => {
          if (!k || k > n) return { x: x + RAIL + RACK_W - 6, y: y + h / 2, top: y, bottom: y + h };
          const i = k - 1;
          return { x: x0 + Math.floor(i / rows) * cell + (cell - 1) / 2, y: y0 + (i % rows) * 4 + (rows === 1 ? 3 : 1.5), top: y, bottom: y + h };
        });
      }
      if (item.device.airflow && item.device.airflow !== 'passive') {
        const intake = (item.device.airflow === 'front-to-back') === (face === 'front');
        parts.push(`<text x="${x + RAIL + RACK_W - 10}" y="${y + h / 2 + 4}" text-anchor="middle" font-size="10" fill="${intake ? '#2563eb' : '#dc2626'}">${item.device.airflow === 'side-to-side' ? '⇆' : intake ? '⇥' : '⇤'}</text>`);
      }
    }
    // The stack cables, on the face the ports are on.
    stacks.forEach((stack, si) => {
      const preset = stackPreset(stack.technology);
      if ((preset?.portsOn ?? 'rear') !== face) return;
      const colour = WHEEL[si % WHEEL.length]!;
      stackCables(stack, preset).forEach((c, n) => {
        const a = yOf.get(stack.members[c.from.member]?.nodeId ?? '');
        const b = yOf.get(stack.members[c.to.member]?.nodeId ?? '');
        if (!a || !b) return;
        const second = (port: string) => /2$|link 2|VCP 1/i.test(port);
        const y1 = a.y + a.h * (second(c.from.port) ? 0.72 : 0.28);
        const y2 = b.y + b.h * (second(c.to.port) ? 0.72 : 0.28);
        const x0 = x + RAIL + RACK_W + 6;
        const bulge = 16 + (n % 4) * 9;
        const dash = /keepalive|dad|dual|backup/i.test(c.kind) ? ' stroke-dasharray="4 3"' : '';
        parts.push(`<path d="M${x0} ${y1} C ${x0 + bulge} ${y1}, ${x0 + bulge} ${y2}, ${x0} ${y2}" fill="none" stroke="${colour}" stroke-width="2"${dash}/>`, `<circle cx="${x0}" cy="${y1}" r="2.5" fill="${colour}"/>`, `<circle cx="${x0}" cy="${y2}" r="2.5" fill="${colour}"/>`);
      });
    });
    // Zero-U PDUs: a strip down the right post, its outlets along it.
    for (const z of view.zeroU) {
      if (face === 'front' && z.rackFace === 'rear') continue;
      if (face === 'rear' && z.rackFace !== 'rear') continue;
      const sx = x + RAIL + RACK_W - 7;
      parts.push(`<rect x="${sx}" y="${top + 2}" width="5" height="${rack.units * UNIT - 4}" fill="#cbd2d9" stroke="#3e4c59" stroke-width="1"/>`);
      const outlets = z.outlets ?? 8;
      portAt.set(z.id, (k) => ({ x: sx + 2.5, y: top + 2 + ((k ? Math.min(k, outlets) - 0.5 : outlets / 2) / outlets) * (rack.units * UNIT - 4) }));
    }
    // The patch cables on the front; The power cords on the rear.
    // A cord to a PDU: down the channel inside the rail, as before.
    const channel = (a: { x: number; y: number }, b: { x: number; y: number }, lane: number) => {
      const cx = x + RAIL + 4 + lane * 3;
      const down = b.y > a.y ? 1 : -1;
      return `M${a.x} ${a.y} L${a.x} ${a.y + 5 * down} L${cx} ${a.y + 5 * down} L${cx} ${b.y - 5 * down} L${b.x} ${b.y - 5 * down} L${b.x} ${b.y}`;
    };
    // A patch cable out of the rack and back — along the gap by its
    // own box to a bundle outside the frame, a lane per cable, and in along
    // the gap by the target's box — the route the canvas draws.
    const bundle = (a: { x: number; y: number; top?: number; bottom?: number }, b: typeof a, lane: number, side: 'left' | 'right') => {
      const down = b.y > a.y;
      const ay = down ? (a.bottom ?? a.y + 5) + 1 : (a.top ?? a.y - 5) - 1;
      const by = down ? (b.top ?? b.y - 5) - 1 : (b.bottom ?? b.y + 5) + 1;
      const cx = side === 'left' ? x - 5 - lane * 2.5 : x + 2 * RAIL + RACK_W + 5 + lane * 2.5;
      if (Math.abs(a.y - b.y) < 4) return `M${a.x} ${a.y} L${b.x} ${b.y}`;
      if (Math.abs(ay - by) < 2) return `M${a.x} ${a.y} L${a.x} ${ay} L${b.x} ${by} L${b.x} ${b.y}`;
      return `M${a.x} ${a.y} L${a.x} ${ay} L${cx} ${ay} L${cx} ${by} L${b.x} ${by} L${b.x} ${b.y}`;
    };
    const lanes = { left: 0, right: 0 };
    if (face === 'front') {
      const stubs: { a: { x: number; y: number }; colour: string; dash: string; text: string }[] = [];
      patchCablesFor(rack.name, items, links, options.statusOf).forEach((c) => {
        const a = portAt.get(c.from.itemId)?.(c.from.port, 'port');
        if (!a) return;
        const colour = cableColour(c, '#6b7a8c');
        const dash = c.status === 'down' || c.status === 'warning' ? ' stroke-dasharray="3 2"' : '';
        if ('elsewhere' in c.to) {
          // A device in no rack is not drawn; one to another rack is
          // a stub, gathered and spread apart below so none overprints.
          if (!isUnracked(c.to)) stubs.push({ a, colour, dash, text: `→ ${esc(c.to.label)}, ${esc(c.to.rack ?? c.to.elsewhere)}` });
          return;
        }
        const b = portAt.get(c.to.itemId)?.(c.to.port, 'port');
        if (!b) return;
        const mid = x + RAIL + RACK_W / 2;
        const side = a.x > mid && b.x > mid ? 'right' : 'left';
        parts.push(`<path d="${bundle(a, b, lanes[side]++ % 8, side)}" fill="none" stroke="${colour}" stroke-width="1.6" stroke-linejoin="round"${dash}><title>${esc(`${c.from.label} ${c.from.portLabel} ↔ ${c.to.label} ${c.to.portLabel}`)}</title></path>`);
      });
      const ys = spreadStubs(stubs.map((s) => s.a.y + 8), 9);
      stubs.forEach((s, i) => {
        const y = ys[i]!;
        parts.push(`<path d="M${s.a.x} ${s.a.y} L${s.a.x} ${y - 3} L${s.a.x + 26} ${y - 3}" fill="none" stroke="${s.colour}" stroke-width="1.6"${s.dash}/>`, `<text x="${s.a.x + 28}" y="${y}" font-size="7" fill="${s.colour}">${s.text}</text>`);
      });
    } else {
      powerCordsFor(rack.name, items).forEach((c, i) => {
        const a = portAt.get(c.itemId)?.(c.supply + 1, 'psu');
        const b = c.problem ? undefined : portAt.get(c.pduId)?.(c.outlet, 'outlet');
        if (!a) return;
        const colour = c.supply === 0 ? '#c62828' : '#3e4c59';
        if (!b) {
          parts.push(`<path d="M${a.x} ${a.y} L${a.x} ${a.y + 5} L${a.x + 20} ${a.y + 5}" fill="none" stroke="${colour}" stroke-width="1.6" stroke-dasharray="3 2"/>`, `<text x="${a.x + 22}" y="${a.y + 8}" font-size="7" fill="${colour}">${esc(c.problem ?? '')}</text>`);
          return;
        }
        parts.push(`<path d="${channel(a, b, 8 + (i % 6))}" fill="none" stroke="${colour}" stroke-width="1.6" stroke-linejoin="round"><title>${esc(`${c.label} supply ${c.supply === 0 ? 'A' : 'B'} → ${c.pduLabel} outlet ${c.outlet}`)}</title></path>`);
      });
    }
    const usage = usageOf(rack, items.filter((d) => (d.rack ?? '').trim().toLowerCase() === rack.name.trim().toLowerCase()));
    const notes = [
      `${usage.used}U used · ${usage.free}U free · ${usage.reserved}U reserved${usage.powerW ? ` · ${usage.powerW} W` : ''}${usage.weightKg ? ` · ${usage.weightKg} kg` : ''}`,
      view.zeroU.length ? `Zero-U: ${view.zeroU.map((d) => d.label).join(', ')}` : '',
      view.unplaced.length ? `Not placed: ${view.unplaced.map((d) => d.label).join(', ')}` : '',
      ...stacks
        .filter((s) => s.members.some((m) => yOf.has(m.nodeId)))
        .map((s, si) => `${s.name}: ${stackPreset(s.technology)?.name ?? s.technology}, ${s.topology} (cables in ${WHEEL[si % WHEEL.length]})`),
    ].filter(Boolean);
    notes.forEach((n, j) => {
      parts.push(`<text x="${x + RAIL}" y="${top + rack.units * UNIT + 18 + j * 14}" font-size="10" fill="#52606d">${esc(n)}</text>`);
    });
  });
  // The title block, bottom right: project, racks, place, the scale, date and revision.
  const tbW = 300;
  const tbH = 62;
  const tbX = width - GAP - tbW;
  const tbY = height - tbH - 8;
  const date = (options.date ?? new Date()).toISOString().slice(0, 10);
  const places = [...new Set(racks.map(placeOf).filter(Boolean))].join('; ');
  parts.push(
    `<rect x="${tbX}" y="${tbY}" width="${tbW}" height="${tbH}" fill="#ffffff" stroke="#3e4c59" stroke-width="1"/>`,
    `<text x="${tbX + 8}" y="${tbY + 16}" font-size="12" font-weight="600" fill="#1f2933">${esc(options.project ?? 'Coreview')}</text>`,
    `<text x="${tbX + 8}" y="${tbY + 30}" font-size="9" fill="#52606d">${esc(racks.map((k) => k.name).join(', '))}${places ? ` · ${esc(places)}` : ''}</text>`,
    `<text x="${tbX + 8}" y="${tbY + 43}" font-size="9" fill="#52606d">${face} elevation · 1 U = 44.45 mm · ${UNIT} px per U</text>`,
    `<text x="${tbX + 8}" y="${tbY + 56}" font-size="9" fill="#52606d">${date}${options.revision ? ` · rev ${esc(options.revision)}` : ''} · Coreview</text>`,
  );
  parts.push('</svg>');
  return parts.join('');
}
