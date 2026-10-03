/**
 * Rack elevations as an SVG file (LT-195, LT-197, LT-689): every rack side by
 * side, from one face, with the U numbers down the rails, where each rack
 * stands (LT-685), the furniture and reservations it holds (LT-682, LT-686),
 * and a stack's cables down its side (LT-683) — the drawing that goes in a
 * change pack or on the cage door.
 *
 * Plain greys on white so it prints; a box seen from behind (full depth,
 * mounted on the other face) is drawn hatched, a reservation dashed, and two
 * boxes that share space are outlined red, the same as the panel shows them.
 */
import { elevation, furnitureRackables, placeOf, usageOf, type Rack, type RackFace, type Rackable } from './rack';
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
  options: { stacks?: readonly Stack[] } = {},
): string {
  const stacks = options.stacks ?? [];
  const tallest = Math.max(1, ...racks.map((r) => r.units));
  const step = RACK_W + RAIL + CABLES + GAP;
  const width = Math.max(1, racks.length) * step + GAP;
  const height = HEAD + tallest * UNIT + 80;
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
      parts.push(
        `<text x="${x + RAIL - 9}" y="${y + UNIT / 2 + 4}" text-anchor="end" font-size="${u % 5 === 0 ? 10 : 8}" font-weight="${u % 5 === 0 ? 600 : 400}" fill="#52606d">${u}</text>`,
        `<line x1="${x + RAIL}" y1="${y}" x2="${x + RAIL + RACK_W}" y2="${y}" stroke="${u % 5 === 0 ? '#c3ccd6' : '#e2e7ec'}" stroke-width="1"/>`,
      );
    }
    const view = elevation(rack, items, face);
    const yOf = new Map<string, { y: number; h: number }>();
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
      if (item.device.airflow && item.device.airflow !== 'passive') {
        const intake = (item.device.airflow === 'front-to-back') === (face === 'front');
        parts.push(`<text x="${x + RAIL + RACK_W - 10}" y="${y + h / 2 + 4}" text-anchor="middle" font-size="10" fill="${intake ? '#2563eb' : '#dc2626'}">${item.device.airflow === 'side-to-side' ? '⇆' : intake ? '⇥' : '⇤'}</text>`);
      }
    }
    // LT-683: the stack cables, on the face the ports are on.
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
  parts.push('</svg>');
  return parts.join('');
}
