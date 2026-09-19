/**
 * Rack elevations as an SVG file (LT-195, LT-197): every rack side by side,
 * from one face, with the U numbers down the rail — the drawing that goes in a
 * change pack or on the cage door.
 *
 * Plain greys on white so it prints; a box seen from behind (full depth,
 * mounted on the other face) is drawn hatched, and two boxes that share space
 * are outlined red, the same as the panel shows them.
 */
import { elevation, type Rack, type RackFace, type Rackable } from './rack';

const UNIT = 18;
const RACK_W = 220;
const RAIL = 26;
const GAP = 40;
const HEAD = 48;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function rackElevationSvg(racks: readonly Rack[], devices: readonly Rackable[], face: RackFace): string {
  const tallest = Math.max(1, ...racks.map((r) => r.units));
  const width = Math.max(1, racks.length) * (RACK_W + RAIL + GAP) + GAP;
  const height = HEAD + tallest * UNIT + 60;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">`,
    '<defs><pattern id="behind" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#9aa5b1" stroke-width="2"/></pattern></defs>',
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
  ];
  racks.forEach((rack, i) => {
    const x = GAP + i * (RACK_W + RAIL + GAP);
    const top = HEAD;
    parts.push(
      `<text x="${x + RAIL + RACK_W / 2}" y="${HEAD - 26}" text-anchor="middle" font-size="15" font-weight="600" fill="#1f2933">${esc(rack.name)}</text>`,
      `<text x="${x + RAIL + RACK_W / 2}" y="${HEAD - 10}" text-anchor="middle" font-size="11" fill="#52606d">${rack.units}U · ${face === 'front' ? 'front' : 'rear'}</text>`,
      `<rect x="${x + RAIL}" y="${top}" width="${RACK_W}" height="${rack.units * UNIT}" fill="#f5f7fa" stroke="#3e4c59" stroke-width="2"/>`,
    );
    for (let u = rack.units; u >= 1; u--) {
      const y = top + (rack.units - u) * UNIT;
      parts.push(
        `<text x="${x + RAIL - 5}" y="${y + UNIT / 2 + 4}" text-anchor="end" font-size="10" fill="#52606d">${u}</text>`,
        `<line x1="${x + RAIL}" y1="${y}" x2="${x + RAIL + RACK_W}" y2="${y}" stroke="#d9dee4" stroke-width="1"/>`,
      );
    }
    const view = elevation(rack, devices, face);
    for (const item of view.items) {
      const y = top + (rack.units - item.top) * UNIT;
      const h = (item.top - item.bottom + 1) * UNIT;
      const fill = item.seen === 'face' ? '#cbd2d9' : 'url(#behind)';
      const stroke = item.clash ? '#c62828' : '#3e4c59';
      parts.push(
        `<rect x="${x + RAIL + 3}" y="${y + 1}" width="${RACK_W - 6}" height="${h - 2}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${item.clash ? 2 : 1}"/>`,
        `<text x="${x + RAIL + RACK_W / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-size="11" fill="#1f2933"${item.seen === 'behind' ? ' font-style="italic"' : ''}>${esc(item.device.label)}${item.seen === 'behind' ? ' (rear)' : ''}</text>`,
      );
    }
    const notes = [
      view.zeroU.length ? `Zero-U: ${view.zeroU.map((d) => d.label).join(', ')}` : '',
      view.unplaced.length ? `Not placed: ${view.unplaced.map((d) => d.label).join(', ')}` : '',
    ].filter(Boolean);
    notes.forEach((n, j) => {
      parts.push(`<text x="${x + RAIL}" y="${top + rack.units * UNIT + 18 + j * 14}" font-size="10" fill="#52606d">${esc(n)}</text>`);
    });
  });
  parts.push('</svg>');
  return parts.join('');
}
