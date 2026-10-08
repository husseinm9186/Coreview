/**
 * Measures every built-in device glyph and writes
 * `src/lib/glyphExtents.json`: the box the artwork actually occupies on its
 * 24×24 grid, stroke included, so a link can meet the drawing rather than the
 * square it sits in. Run with `npx vite-node scripts/glyph-extents.ts`
 * whenever a glyph in `src/components/icons.tsx` changes;
 * `src/lib/glyphExtents.test.ts` fails when the table and the icons drift.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { ICONS } from '../src/components/icons';
import { glyphMarkup } from '../src/lib/glyphSvg';
import type { DeviceType } from '../src/types/domain';

const require = createRequire(path.resolve('e2e/package.json'));
const { chromium } = require('playwright') as typeof import('playwright');

const types = Object.keys(ICONS) as DeviceType[];
const markup = Object.fromEntries(types.map((t) => [t, glyphMarkup(t, '#000000')]));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<!doctype html><body>${types.map((t) => `<div data-type="${t}">${markup[t]}</div>`).join('')}</body>`);
const measured = await page.evaluate(() => {
  const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const div of Array.from(document.querySelectorAll('div[data-type]'))) {
    const svg = div.querySelector('svg')!;
    svg.setAttribute('width', '240');
    svg.setAttribute('height', '240');
    // getBBox ignores the stroke; the glyphs are drawn at 1.6 on the 24 grid,
    // so the drawn edge is 0.8 beyond the geometry.
    const b = (svg as SVGGraphicsElement).getBBox();
    const r = (n: number) => Math.round(n * 100) / 100;
    // Clamped to the grid: a stroke can run a hair past it, and the node's
    // box is the grid.
    const x = Math.max(0, b.x - 0.8);
    const y = Math.max(0, b.y - 0.8);
    out[div.getAttribute('data-type')!] = { x: r(x), y: r(y), w: r(Math.min(24, b.x + b.width + 0.8) - x), h: r(Math.min(24, b.y + b.height + 0.8) - y) };
  }
  return out;
});
await browser.close();

const file = path.resolve('src/lib/glyphExtents.json');
writeFileSync(file, `${JSON.stringify(measured, null, 2)}\n`);
console.log(`${types.length} glyphs measured → ${path.relative(process.cwd(), file)}`);
