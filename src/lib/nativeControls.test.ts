import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * The controls the browser draws itself (LT-328).
 *
 * Some parts of a form are not ours to paint: the scrollbars, a number field's
 * spinners, and the reveal button inside a password field — which WebView2
 * draws as `::-ms-reveal` and which no rule of ours can reach, because we do
 * not draw it.
 *
 * A page that declares no colour scheme is assumed to be light, so the engine
 * drew all of them for a light page. On this app's dark chrome the reveal eye
 * came out dark on dark and was reported as invisible, in every password field
 * at once. `color-scheme: dark` on `:root` is the whole fix and it is one
 * line, which is exactly the kind of line that gets deleted by accident.
 */
const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8')
  // The word appears in the prose explaining it, above the rule itself.
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first rule whose selector matches. */
function ruleBody(selector: string): string | null {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (m[1]!.trim().replace(/\s+/g, ' ') === selector) return m[2]!;
  }
  return null;
}

describe('what the browser draws for us follows the chrome (LT-328)', () => {
  it('declares a colour scheme at all, so nothing is drawn for a light page', () => {
    const root = ruleBody(':root');
    expect(root, ':root should exist').toBeTruthy();
    expect(root).toContain('color-scheme');
  });

  it('and the scheme is dark, because the chrome is dark always (LT-046)', () => {
    expect(ruleBody(':root')).toMatch(/color-scheme:\s*dark/);
  });

  it('paper goes back to light, because a printed page is white', () => {
    // The ground toggle moves the canvas, not the chrome — but print is not
    // the chrome, it is paper, and paper is light whatever the screen is.
    expect(css).toMatch(/color-scheme:\s*light/);
  });

  it('gives the reveal button a colour of ours as well', () => {
    // Belt and braces: the colour scheme is what fixes it, this makes sure a
    // future engine that ignores the scheme still gets a legible glyph.
    expect(css).toContain('::-ms-reveal');
  });

  it('draws its own eye as a control rather than as faint text', () => {
    // `--text-faint` is for text that is deliberately receding. A button is
    // not that, and this one was invisible for exactly that reason.
    const eye = ruleBody('.cv-eye');
    expect(eye, '.cv-eye should exist').toBeTruthy();
    expect(eye).not.toContain('var(--text-faint)');
  });
});
