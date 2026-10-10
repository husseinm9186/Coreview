/**
 * The chrome draws its symbols from one set. A Unicode pencil, tick,
 * triangle or padlock in a component is a symbol whose weight and baseline
 * depend on whatever font the machine falls back to, which is how the same
 * button came to look different on every desktop. This fails on the next
 * one, the way typeScale.test.ts fails on the next literal font size.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { CHROME_ICON_NAMES } from './chromeIcons';

const root = fileURLToPath(new URL('.', import.meta.url));
const SYMBOLS = /[←-⇿⌀-⏿■-◿☀-➿⬀-⯿\u{1f300}-\u{1faff}]/u;
// Punctuation a sentence may carry, and the glyphs that stand for data in
// a table cell — a direction, a sort, an airflow — rather than for a control.
const ALLOWED = new Set(['•', '·', '—', '–', '…', '×', '°', '→', '↔', '↑', '↓', '←', '↗', '⇄', '⇆', '⇥', '⇤', '○', '▲', '▼']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

describe('the chrome icon set', () => {
  it('names every glyph once', () => {
    expect(new Set(CHROME_ICON_NAMES).size).toBe(CHROME_ICON_NAMES.length);
    expect(CHROME_ICON_NAMES.length).toBeGreaterThan(40);
  });

  it('is the only source of symbols in the components', () => {
    const offenders: string[] = [];
    for (const path of files(root)) {
      if (path.endsWith('chromeIcons.tsx')) continue;
      // JSX text and string literals, with comments stripped.
      const source = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const [i, line] of source.split('\n').entries()) {
        const m = SYMBOLS.exec(line);
        if (m && !ALLOWED.has(m[0])) offenders.push(`${path.slice(root.length)}:${i + 1} ${m[0]}`);
      }
    }
    expect(offenders, 'use <ChromeIcon name="…"> from chromeIcons.tsx').toEqual([]);
  });
});
