/**
 * Drawers: a full-height panel beside the canvas for a device or a
 * finding, at a width the inspector rail cannot give — neighbours, ports,
 * routes and history for a device; the devices and the evidence for a
 * finding. Pinned, it stays while the selection moves; unpinned, it follows
 * the device and closes when nothing is selected. Escape closes it, the
 * close button has focus when it opens, and everything inside is a control
 * a keyboard reaches. Nothing in `lib/` changed for it: it draws the same
 * sections the inspector draws, wider.
 */
import { useEffect, useMemo, useRef } from 'react';

import { FINDING_LABEL, type Finding } from '../lib/crawlFindings';
import { whySays } from '../lib/evidence';
import { allNodes, nodeById } from '../lib/pages';
import { formatTime } from '../lib/timeFormat';
import { useStore } from '../state/store';
import type { DeviceNodeData } from '../types/domain';
import { DEVICE_LABEL } from './icons';
import { t } from '../i18n';
import { AttachmentsSection, NeighboursSection } from './inspector/DeviceRelations';
import { InventorySection } from './inspector/InventorySection';

/** What the drawer shows. Window state, never the document. */
export type DrawerContent = { kind: 'device'; nodeId: string } | { kind: 'finding'; finding: Finding };

export function DrawerHost() {
  const drawer = useStore((s) => s.drawer);
  const pinned = useStore((s) => s.drawerPinned);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const close = useStore((s) => s.closeDrawer);
  const setPinned = useStore((s) => s.setDrawerPinned);
  const closeButton = useRef<HTMLButtonElement>(null);

  // Unpinned, a device drawer follows the selection and goes with it.
  useEffect(() => {
    if (!drawer || pinned || drawer.kind !== 'device') return;
    if (selectedNodeId === null) close();
    else if (selectedNodeId !== drawer.nodeId) useStore.getState().openDrawer({ kind: 'device', nodeId: selectedNodeId });
  }, [selectedNodeId, drawer, pinned, close]);

  useEffect(() => {
    if (!drawer) return;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, close]);

  if (!drawer) return null;
  return (
    <aside className="cv-drawer" role="dialog" aria-modal="false" aria-label={t('drawer.label')} data-kind={drawer.kind}>
      <div className="cv-drawer-head">
        <button ref={closeButton} type="button" className="cv-btn cv-btn-small" onClick={close} aria-label={t('drawer.close')}>
          ✕
        </button>
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          {t('drawer.pin')}
        </label>
      </div>
      <div className="cv-drawer-body">
        {drawer.kind === 'device' ? <DeviceDrawer nodeId={drawer.nodeId} /> : <FindingDrawer finding={drawer.finding} />}
      </div>
    </aside>
  );
}

function DeviceDrawer({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => nodeById(s.doc, nodeId));
  const events = useStore((s) => s.events);
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const select = useStore((s) => s.select);
  const mine = useMemo(() => events.filter((e) => e.objectId === nodeId).slice(0, 50), [events, nodeId]);
  if (!node || node.type !== 'device') return <p className="cv-help">{t('drawer.gone')}</p>;
  const d = node.data as DeviceNodeData;
  const fact = (label: string, value: string | undefined, why: string | null) =>
    value ? (
      <div className="cv-drawer-fact" title={why ?? undefined}>
        <span className="cv-help">{label}</span> <span>{value}</span>
      </div>
    ) : null;
  return (
    <div className="cv-drawer-device">
      <h2 className="cv-inspector-title">{d.label}</h2>
      <div className="cv-drawer-facts">
        {fact(t('drawer.type'), DEVICE_LABEL[d.deviceType], whySays(d.evidence, 'class'))}
        {fact(t('drawer.model'), d.model, whySays(d.evidence, 'platform'))}
        {fact(t('drawer.hostname'), d.hostname, whySays(d.evidence, 'hostname'))}
        {fact(t('drawer.role'), d.role, d.roleEvidence ?? null)}
        {fact(t('drawer.addresses'), d.addresses?.map((a) => a.address).filter(Boolean).join(', '), whySays(d.evidence, 'addresses'))}
        {fact(t('drawer.serial'), d.serial, whySays(d.evidence, 'serial'))}
      </div>
      <button type="button" className="cv-btn cv-btn-small" onClick={() => select(nodeId, null)}>{t('drawer.selectOnCanvas')}</button>
      {d.inventory && <InventorySection inventory={d.inventory} uptimeWhy={whySays(d.evidence, 'uptime')} />}
      <NeighboursSection nodeId={nodeId} />
      <AttachmentsSection nodeId={nodeId} data={d} />
      <section className="cv-section">
        <h3>{t('drawer.history')}</h3>
        {mine.length === 0 ? (
          <p className="cv-help">{t('drawer.noHistory')}</p>
        ) : (
          <ul className="cv-drawer-history">
            {mine.map((e) => (
              <li key={e.id}>
                <span className="cv-mono">{formatTime(e.timestampMs, timeFormat)}</span> {e.previousStatus ?? '—'} → {e.currentStatus ?? '—'}
                {e.message ? <span className="cv-help"> · {e.message}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FindingDrawer({ finding }: { finding: Finding }) {
  const nodes = useStore((s) => s.doc.pages);
  const select = useStore((s) => s.select);
  const byName = useMemo(() => {
    const out = new Map<string, string>();
    for (const n of allNodes({ pages: nodes } as never)) {
      const d = n.data as DeviceNodeData;
      for (const name of [d.hostname, d.label]) if (name?.trim()) out.set(name.trim().toLowerCase(), n.id);
    }
    return out;
  }, [nodes]);
  return (
    <div className="cv-drawer-finding">
      <h2 className="cv-inspector-title">{FINDING_LABEL[finding.kind]}</h2>
      <p className={`cv-drawer-message is-${finding.severity}`}>{finding.message}</p>
      <section className="cv-section">
        <h3>{t('drawer.devices')}</h3>
        <ul className="cv-drawer-devices">
          {finding.devices.map((name) => {
            const id = byName.get(name.trim().toLowerCase());
            return (
              <li key={name}>
                <span>{name}</span>
                {id ? (
                  <button type="button" className="cv-btn cv-btn-small" onClick={() => select(id, null)}>{t('drawer.selectOnCanvas')}</button>
                ) : (
                  <span className="cv-help"> {t('drawer.notDrawn')}</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
