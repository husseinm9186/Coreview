/**
 * The canvas filter: everything on the page except what matches is
 * dimmed — by type, vendor, role, VLAN, subnet, status, how discovery met it,
 * tag or text. Filled in from what the page actually has, so nobody types a
 * vendor that is not there.
 *
 * **Or hidden.** On a discovered estate the dimmed devices still take
 * the room and are still crossed by every link, so "show me only the switches"
 * is not answered by fading eighty hosts. The tick turns the same match into a
 * disappearance, and the button then says how many are off the page — a
 * diagram quietly missing devices is worse than a crowded one.
 */
import { useMemo } from 'react';

import { filterActive, litNodes, type CanvasFilter } from '../lib/canvasFilter';
import { activePage } from '../lib/pages';
import { useStore } from '../state/store';
import type { DeviceNodeData } from '../types/domain';
import { DEVICE_LABEL } from './icons';
import { t } from '../i18n';

export function CanvasFilterMenu() {
  const nodes = useStore((s) => activePage(s.doc).nodes);
  // Kept stable: `?? {}` makes a fresh object every render, which would make
  // the count below recompute on every one of them.
  const stored = useStore((s) => s.canvasFilter);
  const filter = useMemo(() => stored ?? {}, [stored]);
  const setFilter = useStore((s) => s.setCanvasFilter);
  const devices = useMemo(() => nodes.filter((n) => n.type === 'device').map((n) => n.data as DeviceNodeData), [nodes]);
  const distinct = (pick: (d: DeviceNodeData) => string | undefined) =>
    [...new Set(devices.map(pick).filter((v): v is string => Boolean(v?.trim())))].sort((a, b) => a.localeCompare(b));
  const types = distinct((d) => (d.deviceType === 'zone' ? undefined : d.deviceType));
  const vendors = distinct((d) => d.vendor);
  const roles = distinct((d) => d.role);
  const tags = [...new Set(devices.flatMap((d) => d.tags ?? []))].sort();
  const set = (patch: Partial<CanvasFilter>) => {
    const next = { ...filter, ...patch };
    setFilter(filterActive(next) ? next : null);
  };
  const active = filterActive(filter);
  // What the tick is actually doing, counted from the same match the canvas
  // uses so the two cannot disagree.
  const edges = useStore((s) => activePage(s.doc).edges);
  const nodeStatus = useStore((s) => s.nodeStatus);
  const total = devices.length;
  const hidden = useMemo(() => {
    if (!active || !filter.hide) return 0;
    const lit = litNodes(nodes, edges, filter, null, (id) => nodeStatus(id));
    if (!lit) return 0;
    return nodes.filter((n) => n.type === 'device' && !lit.has(n.id)).length;
  }, [active, filter, nodes, edges, nodeStatus]);

  return (
    <details className="cv-dropdown cv-filter-menu">
      <summary className={`cv-btn${active ? ' is-on' : ''}`} aria-label={active ? 'Filter the canvas (on)' : 'Filter the canvas'}>
        Filter{hidden > 0 ? ` — ${hidden} hidden` : active ? ' ●' : ''}
      </summary>
      <div className="cv-dropdown-menu cv-filter-fields">
        <p className="cv-help">{t('canvasFilterMenu.whatDoesNotMatch')}</p>
        <fieldset>
          <legend>{t('canvasFilterMenu.type')}</legend>
          {types.map((t) => (
            <label key={t} className="cv-check">
              <input
                type="checkbox"
                checked={filter.types?.includes(t) ?? false}
                onChange={(e) => set({ types: e.target.checked ? [...(filter.types ?? []), t] : (filter.types ?? []).filter((x) => x !== t) })}
              />
              {DEVICE_LABEL[t as keyof typeof DEVICE_LABEL] ?? t}
            </label>
          ))}
        </fieldset>
        {([['Vendor', 'vendor', vendors], ['Role', 'role', roles], ['Tag', 'tag', tags]] as const).map(([label, key, options]) => (
          <label key={key} className="cv-field">
            <span>{label}</span>
            <select className="cv-input" value={filter[key] ?? ''} onChange={(e) => set({ [key]: e.target.value || undefined })}>
              <option value="">{t('canvasFilterMenu.any')}</option>
              {options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        ))}
        <label className="cv-field">
          <span>{t('canvasFilterMenu.status')}</span>
          <select className="cv-input" value={filter.status ?? ''} onChange={(e) => set({ status: (e.target.value || undefined) as CanvasFilter['status'] })}>
            <option value="">{t('canvasFilterMenu.any')}</option>
            <option value="healthy">{t('canvasFilterMenu.healthy')}</option>
            <option value="warning">{t('canvasFilterMenu.warning')}</option>
            <option value="down">{t('canvasFilterMenu.down')}</option>
            <option value="unknown">{t('canvasFilterMenu.unknown')}</option>
          </select>
        </label>
        <label className="cv-field">
          <span>{t('canvasFilterMenu.discovered')}</span>
          <select className="cv-input" value={filter.crawl ?? ''} onChange={(e) => set({ crawl: (e.target.value || undefined) as CanvasFilter['crawl'] })}>
            <option value="">{t('canvasFilterMenu.any')}</option>
            <option value="logged-in">{t('canvasFilterMenu.loggedIn')}</option>
            <option value="snmp">{t('canvasFilterMenu.overSnmp')}</option>
            <option value="seen">{t('canvasFilterMenu.seenByANeighbour')}</option>
            <option value="not-discovered">{t('canvasFilterMenu.notDiscovered')}</option>
          </select>
        </label>
        <label className="cv-field">
          <span>{t('canvasFilterMenu.vlan')}</span>
          <input className="cv-input" value={filter.vlan ?? ''} placeholder={t('canvasFilterMenu.10OrAVlan')} onChange={(e) => set({ vlan: e.target.value || undefined })} />
        </label>
        <label className="cv-field">
          <span>{t('canvasFilterMenu.subnet')}</span>
          <input className="cv-input cv-mono" value={filter.subnet ?? ''} placeholder="192.0.2.0/24" onChange={(e) => set({ subnet: e.target.value || undefined })} />
        </label>
        <label className="cv-field">
          <span>{t('canvasFilterMenu.text')}</span>
          <input className="cv-input" value={filter.text ?? ''} placeholder={t('canvasFilterMenu.inNamesDeviceNotes')} onChange={(e) => set({ text: e.target.value || undefined })} />
        </label>
        <label className="cv-check cv-filter-hide">
          <input
            type="checkbox"
            checked={filter.hide ?? false}
            disabled={!active}
            onChange={(e) => set({ hide: e.target.checked || undefined })}
          />
          {t('canvasFilterMenu.hideWhatDoesNot')}
        </label>
        <p className="cv-help">
          {hidden > 0
            ? `${hidden} of ${t('plural.deviceIs', { count: total })} off the page. Nothing is deleted — clear the filter to bring them back.`
            : 'Nothing is deleted either way. Clearing the filter brings everything back.'}
        </p>
        <button type="button" className="cv-btn cv-btn-small" disabled={!active} onClick={() => setFilter(null)}>
          {t('canvasFilterMenu.clearTheFilter')}
        </button>
      </div>
    </details>
  );
}
