import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * The type scale is tokens, not numbers (LT-442).
 *
 * The stylesheet set `font-size` two hundred and twenty-four times, at
 * fifteen different values, with no scale declared — 12 px eighty times,
 * 11 px seventy-five, and a handful of 10.5, 11.5, 15 and 17 that nobody
 * chose on purpose. Now `:root` declares the scale and every rule reads it.
 * This fails on the next literal, the way `groundTokens.test.ts` fails on the
 * next chrome rule that reads a ground token.
 */
const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
const SCALE = /--text-(?:2xs|xs|sm|md|lg|xl|2xl|3xl|4xl|display)\b/g;
const declared = [...root.matchAll(SCALE)].map((m) => m[0]);

describe('the type scale (LT-442)', () => {
  it('declares the scale once, in :root', () => {
    expect(declared).toEqual(['--text-2xs', '--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl', '--text-2xl', '--text-3xl', '--text-4xl', '--text-display']);
    for (const step of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5']) expect(root).toContain(step);
  });

  it('every font-size outside :root reads a token or a relative unit', () => {
    const outside = css.replace(/:root\s*\{[^}]*\}/, '');
    const literal = [...outside.matchAll(/font-size:\s*([^;}]+)/g)]
      .map((m) => m[1]!.trim())
      .filter((v) => !/^var\(--text-(?:2xs|xs|sm|md|lg|xl|2xl|3xl|4xl|display)\)$/.test(v) && !/(em|rem|%)$/.test(v) && v !== 'inherit');
    expect(literal, 'use a --text-* token from :root').toEqual([]);
  });

  it('reads only tokens the root declares', () => {
    const used = new Set([...css.matchAll(/font-size:\s*var\((--text-[a-z0-9]+)\)/g)].map((m) => m[1]!));
    for (const u of used) expect(declared, u).toContain(u);
  });
});
