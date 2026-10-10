/**
 * Which side of the window the dock sits on, per tab.
 *
 * Most of what the dock holds is a wide table — the monitored objects, the
 * paths, the backups — and wants the width of the window along the bottom.
 * Two things do not: discovering devices and the terminal are tall, narrow
 * work, and belong down the right beside the diagram, where their steps and
 * their session read top to bottom. So the side follows the tab, with a
 * default per tab and an override the operator can set and that is
 * remembered for this machine.
 *
 * It never replaces the inspector: the right dock is a column of its own,
 * and a crawl's live table still selects into the inspector beside it.
 */
import type { DockTab } from '../state/store';

export type DockSide = 'bottom' | 'right';

/** The side a tab opens on before anyone moves it. Discovering devices and
 *  the terminal start down the right; everything else along the bottom. */
export const DEFAULT_DOCK_SIDE: Partial<Record<DockTab, DockSide>> = {
  crawl: 'right',
  discover: 'right',
  ssh: 'right',
};

export function dockSideFor(tab: DockTab, overrides: Partial<Record<DockTab, DockSide>>): DockSide {
  return overrides[tab] ?? DEFAULT_DOCK_SIDE[tab] ?? 'bottom';
}

/**
 * The width class for the right dock. The terminal wants half the window —
 * a wrapped command line is unreadable — while discovering devices is a
 * column of form steps that reads at a narrower width.
 */
export function dockWidthClass(tab: DockTab): 'is-dock-wide' | 'is-dock-narrow' {
  return tab === 'ssh' ? 'is-dock-wide' : 'is-dock-narrow';
}

/** Reads the remembered overrides. Window state, like the panels' own. */
export function readDockPlacements(): Partial<Record<DockTab, DockSide>> {
  try {
    const raw = JSON.parse(localStorage.getItem('coreview.view.dockPlacements') ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    const out: Partial<Record<DockTab, DockSide>> = {};
    for (const [k, v] of Object.entries(raw)) if (v === 'bottom' || v === 'right') out[k as DockTab] = v;
    return out;
  } catch {
    return {};
  }
}
