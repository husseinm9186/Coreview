/**
 * What a device is connected to, and the files kept about it (LT-234).
 *
 * **Neighbours** are the links drawn to it on any page, each with the port at
 * this end and the far end and the link's live status, so a device's cabling
 * can be read without tracing lines. **Attachments** are paths to files on this
 * machine — a rack photo, a support contract, a saved configuration — opened
 * from here (documents only) or shown in their folder.
 */
import { useMemo, useState } from 'react';

import { uid } from '../../lib/id';
import { ipc } from '../../lib/ipc';
import { useStore } from '../../state/store';
import type { DeviceNodeData, LinkData } from '../../types/domain';
import { t } from '../../i18n';

export function NeighboursSection({ nodeId }: { nodeId: string }) {
  // LT-452: the pages and which is active, not the whole document.
  const pages = useStore((s) => s.doc.pages);
  const activePageId = useStore((s) => s.doc.activePageId);
  const linkStatus = useStore((s) => s.linkStatus);
  const select = useStore((s) => s.select);
  useStore((s) => s.runtime);
  const rows = useMemo(() => {
    const out: { edgeId: string; pageId: string; other: string; here: string; there: string; layer3: boolean }[] = [];
    for (const page of pages) {
      const label = new Map(page.nodes.map((n) => [n.id, (n.data as DeviceNodeData).label ?? 'Note']));
      for (const e of page.edges) {
        const d = (e.data ?? {}) as LinkData;
        if (d.kind === 'leader') continue;
        if (e.source === nodeId) out.push({ edgeId: e.id, pageId: page.id, other: label.get(e.target) ?? '?', here: d.sourcePortLabel ?? '', there: d.targetPortLabel ?? '', layer3: Boolean(d.layer3) });
        else if (e.target === nodeId) out.push({ edgeId: e.id, pageId: page.id, other: label.get(e.source) ?? '?', here: d.targetPortLabel ?? '', there: d.sourcePortLabel ?? '', layer3: Boolean(d.layer3) });
      }
    }
    // In port order, links with no port named last.
    return out.sort((a, b) => Number(!a.here) - Number(!b.here) || a.here.localeCompare(b.here, undefined, { numeric: true }) || a.other.localeCompare(b.other));
  }, [pages, nodeId]);

  return (
    <section className="cv-section" aria-label={t('deviceRelations.neighbours')}>
      <h3>{t('deviceRelations.neighbours')} <span className="cv-palette-count">{rows.length}</span></h3>
      {rows.length === 0 ? (
        <p className="cv-help">{t('deviceRelations.nothingIsLinkedTo')}</p>
      ) : (
        <table className="cv-table cv-inventory-table">
          <thead><tr><th>{t('deviceRelations.portHere')}</th><th>{t('deviceRelations.device')}</th><th>{t('deviceRelations.portThere')}</th><th>{t('deviceRelations.link')}</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const status = linkStatus(r.edgeId);
              return (
                <tr key={r.edgeId}>
                  <td className="cv-mono">{r.here || '—'}</td>
                  <td>
                    <button type="button" className="cv-link-button" onClick={() => {
                      if (r.pageId !== activePageId) useStore.getState().setActivePage(r.pageId);
                      select(null, r.edgeId);
                    }}>
                      {r.other}
                    </button>
                    {r.layer3 && <span className="cv-help"> (L3)</span>}
                  </td>
                  <td className="cv-mono">{r.there || '—'}</td>
                  <td><span className={`cv-path-hop is-${status}`}>{status}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function AttachmentsSection({ nodeId, data }: { nodeId: string; data: DeviceNodeData }) {
  const update = useStore((s) => s.updateNodeData);
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const list = data.attachments ?? [];
  const add = (p: string) => {
    const clean = p.trim();
    if (!clean) return;
    const name = label.trim() || clean.split(/[\\/]/).pop() || clean;
    update(nodeId, { attachments: [...list, { id: uid(), label: name, path: clean }] });
    setPath('');
    setLabel('');
  };
  const open = (p: string, reveal: boolean) => {
    setProblem(null);
    ipc.openAttachment(p, reveal).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  return (
    <section className="cv-section" aria-label={t('deviceRelations.attachments')}>
      <h3>{t('deviceRelations.attachments')} <span className="cv-palette-count">{list.length}</span></h3>
      {list.map((a) => (
        <div key={a.id} className="cv-attachment">
          <span className="cv-attachment-label" title={a.path}>{a.label}</span>
          <button type="button" className="cv-btn cv-btn-small" onClick={() => open(a.path, false)}>{t('deviceRelations.open')}</button>
          <button type="button" className="cv-btn cv-btn-small" onClick={() => open(a.path, true)}>{t('deviceRelations.showInFolder')}</button>
          <button type="button" className="cv-layer-remove" aria-label={`Remove ${a.label}`}
            onClick={() => update(nodeId, { attachments: list.filter((x) => x.id !== a.id) })}>×</button>
        </div>
      ))}
      {problem && <p className="cv-discover-problem">{problem}</p>}
      <div className="cv-row cv-row-tight">
        <input className="cv-input" aria-label={t('deviceRelations.attachmentName')} placeholder="Name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input className="cv-input cv-mono" aria-label={t('deviceRelations.attachmentPath')} placeholder={t('deviceRelations.fullPathToA')} value={path}
          onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(path)} />
        <button type="button" className="cv-btn cv-btn-small" onClick={() => add(path)} disabled={!path.trim()}>{t('deviceRelations.add')}</button>
        <button type="button" className="cv-btn cv-btn-small" onClick={() => void ipc.chooseAttachment().then((p) => p && add(p))}>{t('deviceRelations.choose')}</button>
      </div>
      <p className="cv-help">Only the path is kept with the project; the file stays where it is. Documents and pictures open here; anything else, show its folder.</p>
    </section>
  );
}
