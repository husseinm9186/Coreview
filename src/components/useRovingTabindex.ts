/**
 * One tab stop for a table, and the arrow keys inside it.
 *
 * A live table of two hundred rows with a button in each is two hundred tab
 * stops between the toolbar and the next control. The pattern the ARIA
 * grid uses instead: the table is one stop, the arrow keys move a roving
 * `tabindex` between rows, Home and End jump, and Enter or Space presses
 * the row's first button. Nothing here reads the store; it works on the
 * rows the table already has.
 */
import { useEffect, type RefObject } from 'react';

const ROWS = 'tbody tr, [role="row"]';

export function useRovingTabindex(container: RefObject<HTMLElement | null>, deps: readonly unknown[] = []): void {
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const rows = () => Array.from(el.querySelectorAll<HTMLElement>(ROWS));
    const arm = () => {
      const all = rows();
      if (all.length === 0) return;
      const current = all.find((r) => r.tabIndex === 0) ?? all[0]!;
      for (const r of all) r.tabIndex = r === current ? 0 : -1;
    };
    const onKey = (e: KeyboardEvent) => {
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(ROWS);
      if (!row || !el.contains(row)) return;
      const all = rows();
      const at = all.indexOf(row);
      if (at < 0) return;
      let next: HTMLElement | undefined;
      if (e.key === 'ArrowDown') next = all[Math.min(at + 1, all.length - 1)];
      else if (e.key === 'ArrowUp') next = all[Math.max(at - 1, 0)];
      else if (e.key === 'Home') next = all[0];
      else if (e.key === 'End') next = all[all.length - 1];
      else if (e.key === 'Enter' || e.key === ' ') {
        const button = row.querySelector<HTMLElement>('button, a, input[type="checkbox"]');
        if (button && e.target === row) {
          e.preventDefault();
          button.click();
        }
        return;
      } else return;
      e.preventDefault();
      if (next && next !== row) {
        row.tabIndex = -1;
        next.tabIndex = 0;
        next.focus();
      }
    };
    arm();
    el.addEventListener('keydown', onKey);
    const observer = new MutationObserver(arm);
    observer.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('keydown', onKey);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, ...deps]);
}
