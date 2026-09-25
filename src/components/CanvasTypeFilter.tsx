import { useMemo } from 'react';

import { filterActive } from '../lib/canvasFilter';
import { activePage } from '../lib/pages';
import { useStore } from '../state/store';
import type { DeviceNodeData, DeviceType } from '../types/domain';
import { DEVICE_LABEL } from './icons';

/**
 * Filter the drawing by what a device is, from the canvas itself (LT-419).
 *
 * "after I discover and add the devices to the diagram I need to filter based
 * on type, like switches, wireless, routers, firewalls, phones,
 * endpoints...etc with selection make the filter at the top next to the PEN,
 * and Eraser."
 *
 * The full filter (LT-232) has done types all along, and LT-415 taught it to
 * hide rather than dim — but it lives in the top bar behind a disclosure,
 * beside eight other criteria. Asked for twice, which says the control was in
 * the wrong place for the question that gets asked most.
 *
 * **It writes the same `canvasFilter` the dropdown does**, so the two are one
 * filter seen from two places rather than two filters to keep in step. Picking
 * a type here also turns hiding on, because that is what it was asked for
 * both times: "I want to see only switches" is not answered by fading the
 * rest.
 *
 * Only the kinds actually on the page are offered, each with its count.
 * Offering an empty category is offering to show nothing.
 */
export function CanvasTypeFilter() {
  const nodes = useStore((s) => activePage(s.doc).nodes);
  const stored = useStore((s) => s.canvasFilter);
  const filter = useMemo(() => stored ?? {}, [stored]);
  const setFilter = useStore((s) => s.setCanvasFilter);

  const counts = useMemo(() => {
    const by = new Map<string, number>();
    for (const n of nodes) {
      if (n.type !== 'device') continue;
      const t = (n.data as DeviceNodeData).deviceType;
      // A section is the backdrop the rest stands on, not a kind of device.
      if (!t || t === 'zone') continue;
      by.set(t, (by.get(t) ?? 0) + 1);
    }
    return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [nodes]);

  if (counts.length === 0) return null;

  const chosen = filter.types ?? [];
  /** Nothing chosen is not "hide everything" — it is no filter at all, and
   *  the other criteria the dropdown may have set are left alone. */
  const showEveryKind = () => {
    const rest = { ...filter };
    delete rest.types;
    delete rest.hide;
    setFilter(filterActive(rest) ? rest : null);
  };

  const toggle = (t: string) => {
    const next = chosen.includes(t) ? chosen.filter((x) => x !== t) : [...chosen, t];
    if (next.length === 0) {
      showEveryKind();
      return;
    }
    setFilter({ ...filter, types: next, hide: true });
  };

  const hidden = chosen.length > 0 ? counts.filter(([t]) => !chosen.includes(t)).reduce((n, [, c]) => n + c, 0) : 0;

  return (
    <details className="cv-dropdown cv-type-filter">
      <summary
        className={`cv-btn cv-btn-small${chosen.length > 0 ? ' is-on' : ''}`}
        aria-label={chosen.length > 0 ? `Filter by type (${hidden} hidden)` : 'Filter by type'}
        title="Show only the kinds of device you pick. Nothing is deleted."
      >
        ⚟ {chosen.length > 0 ? `${hidden} hidden` : 'Types'}
      </summary>
      <div className="cv-dropdown-menu cv-type-filter-menu">
        {counts.map(([t, count]) => (
          <label key={t} className="cv-check">
            <input type="checkbox" checked={chosen.includes(t)} onChange={() => toggle(t)} />
            {DEVICE_LABEL[t as DeviceType] ?? t} <span className="cv-type-count">{count}</span>
          </label>
        ))}
        <button
          type="button"
          className="cv-btn cv-btn-small"
          disabled={chosen.length === 0}
          onClick={showEveryKind}
        >
          Show every kind
        </button>
        <p className="cv-help">Nothing is deleted — this only changes what is drawn.</p>
      </div>
    </details>
  );
}
