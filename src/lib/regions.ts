/**
 * F6 between the parts of the window (LT-240): the toolbar, the shape palette,
 * the diagram, the inspector and the bottom panel — the way a browser moves
 * between its address bar and the page. Only regions that are on screen count.
 *
 * The address register (LT-300) is in the list too. It takes the workspace
 * when it is open, and the regions behind it are hidden — which `visible()`
 * already works out, so the cycle becomes toolbar and register and nothing
 * else without a special case.
 */
export const REGIONS = [
  '.cv-topbar', '.cv-register', '.cv-helpscreen', '.cv-palette', '.react-flow', '.cv-inspector', '.cv-panel',
] as const;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]';

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** The index of the next region from `current` in `step` direction among
 *  those shown. Pure, for testing. */
export function nextRegion(shown: readonly boolean[], current: number, step: 1 | -1): number {
  const n = shown.length;
  for (let i = 1; i <= n; i++) {
    const at = (((current + step * i) % n) + n) % n;
    if (shown[at]) return at;
  }
  return current;
}

export function cycleRegion(step: 1 | -1, doc: Document = document): void {
  const els = REGIONS.map((sel) => doc.querySelector(sel));
  const shown = els.map((el) => Boolean(el && visible(el)));
  const active = doc.activeElement;
  const current = els.findIndex((el) => el && active && el.contains(active));
  const target = els[nextRegion(shown, current < 0 ? (step === 1 ? -1 : 0) : current, step)];
  if (!target) return;
  const first = target.matches('.react-flow') ? target : target.querySelector<HTMLElement>(FOCUSABLE);
  const el = (first ?? target) as HTMLElement;
  if (!el.hasAttribute('tabindex') && !el.matches(FOCUSABLE)) el.setAttribute('tabindex', '-1');
  el.focus();
}
