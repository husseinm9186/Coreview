import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Chrome does not follow the ground (LT-315).
 *
 * `CLAUDE.md` has said since LT-046 that canvas elements read the ground
 * tokens and chrome elements read the chrome ones, and that pointing one at
 * the other's set is a bug because only one of them flips. It was said and not
 * checked, so it drifted: `.cv-table tbody` took its background from `--page`
 * while its cells inherited the chrome's light text, and pressing *White
 * background* turned every table in the app white-on-white.
 *
 * This reads the stylesheet and fails on the next one, which is cheaper than
 * finding it in a screenshot.
 */
const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8')
  // Comments carry the word `var(--page)` in prose and sit in front of the
  // selector they explain, so they have to go before anything is matched.
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Tokens that change when the canvas ground is toggled. */
const GROUND = ['--desk', '--page', '--page-border', '--grid-minor', '--grid-major', '--ink', '--ink-muted', '--canvas-accent'];

/** Selectors that *are* the canvas, and so are allowed to read them. */
const CANVAS = [
  '.cv-canvas', '.cv-page', '.react-flow', '.cv-node', '.cv-note', '.cv-glyph', '.cv-sheet',
  '.cv-port', '.cv-rack', '.cv-zone', '.cv-label', '.cv-edge', '.cv-link', '.cv-lasso',
  '.cv-resize-handle', '.cv-connector', '.cv-anchor', '.cv-waypoint', '.cv-marker', '.cv-ink',
  '.cv-guide', '.cv-callout', '.cv-minimap', '.cv-welcome', '.cv-comment-pin',
  '.cv-hop', '.cv-packet', '.cv-stack', '.cv-group', '.cv-page-grid', '.cv-dim',
  '.cv-connection-snap',
];

/** Every rule in the file, as a selector and the body that follows it. */
function rules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  // Good enough for this stylesheet: no nesting, one level of braces except
  // inside @media, which this walks into by ignoring the wrapper.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const selector = m[1]!.trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@') || selector.startsWith(':root') || selector.startsWith('.is-')) continue;
    out.push({ selector, body: m[2]! });
  }
  return out;
}

const isCanvas = (selector: string) =>
  CANVAS.some((c) => selector.includes(c)) || selector.includes('@media print');

describe('the ground tokens stay on the canvas (LT-315)', () => {
  it('finds rules to check at all', () => {
    expect(rules().length).toBeGreaterThan(200);
  });

  it('no chrome rule paints itself from a ground token', () => {
    const offenders = rules()
      .filter(({ selector, body }) => !isCanvas(selector) && GROUND.some((t) => body.includes(`var(${t})`)))
      .map(({ selector, body }) => {
        const used = GROUND.filter((t) => body.includes(`var(${t})`));
        return `${selector} uses ${used.join(', ')}`;
      });
    expect(offenders).toEqual([]);
  });

  it('a table row and its text come from the same set, so neither can vanish', () => {
    // The actual failure: tbody from --page (flips white), td inheriting the
    // chrome's --text (stays near-white). White on white.
    const tbody = rules().find((r) => r.selector === '.cv-table tbody');
    expect(tbody, '.cv-table tbody should exist').toBeTruthy();
    expect(tbody!.body).not.toContain('var(--page)');
  });
});
