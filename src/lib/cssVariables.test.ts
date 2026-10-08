import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Every colour the chrome asks for is a colour the chrome has.
 *
 * A `var(--nothing)` does not fail a build, log a warning or show up in a
 * screenshot review. It resolves to nothing: the declaration is dropped, the
 * element keeps whatever it inherited, and a label meant to be dim comes out
 * the same colour as the text above it. Three had drifted in before anything
 * looked — `--good` on the lab reply and the diff's added lines, `--muted` on
 * two section headings and an unset path, `--surface-2` behind a dashboard
 * bar — and one of them had already been noticed by whoever wrote
 * `var(--muted, var(--text-faint))`, which papers over the symptom and leaves
 * the other two.
 *
 * This is the same trick `groundTokens.test.ts` uses: read the stylesheet and
 * fail on the next one.
 */
const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8')
  // Comments discuss token names in prose.
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `var(--x)` in the file, and whether it was given a fallback. */
function used(): { name: string; hasFallback: boolean }[] {
  const out: { name: string; hasFallback: boolean }[] = [];
  const re = /var\(\s*(--[a-zA-Z0-9-]+)\s*(,?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push({ name: m[1]!, hasFallback: m[2] === ',' });
  return out;
}

/** Every `--x:` declared anywhere in the file. */
function declared(): Set<string> {
  return new Set(Array.from(css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g), (m) => m[1]!));
}

describe('the stylesheet defines every variable it reads', () => {
  it('finds variables to check at all', () => {
    expect(used().length).toBeGreaterThan(300);
    expect(declared().size).toBeGreaterThan(40);
  });

  it('no rule reads a variable that is never declared', () => {
    const known = declared();
    const missing = [...new Set(used().map((u) => u.name))].filter((n) => !known.has(n));
    expect(missing, `used but never declared: ${missing.join(', ')}`).toEqual([]);
  });

  it('no declared variable needs a fallback to work', () => {
    // A fallback on a token the file defines is either dead weight or a sign
    // somebody hid a missing token instead of adding it.
    const known = declared();
    const propped = used().filter((u) => u.hasFallback && known.has(u.name));
    expect(propped.map((u) => u.name)).toEqual([]);
  });
});
