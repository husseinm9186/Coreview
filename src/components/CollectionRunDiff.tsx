/**
 * The selected collection run against an earlier one — what
 * appeared, what went and what changed, in devices, links, CDP/LLDP
 * neighbours, routing neighbours, routes and overlays. Devices are matched
 * by serial and MAC in Rust (`coreview-topology/src/diff.rs`), so a switch
 * reached on another address, or renamed, is the same switch.
 */
import { useState } from 'react';

import { t } from '../i18n';
import { saveExport } from '../lib/exports';
import { ipc, type CollectionDiff, type CollectionRunSummary, type RunChange } from '../lib/ipc';
import { diffCsv, diffMarkdown, type DiffRow } from '../lib/runDiff';
import { useStore } from '../state/store';

const KINDS: RunChange['kind'][] = ['device', 'link', 'neighbor', 'routing_neighbor', 'route', 'overlay'];

/** The comparison in the rows the page's other diffs already write out. */
export function asDiffRows(d: CollectionDiff): DiffRow[] {
  return d.changes.map((c) => ({
    subject: c.subject,
    change: t(`collect.diff.${c.change}`, { kind: t(`collect.diff.kind.${c.kind}`) }),
    before: c.before,
    after: c.after,
    tone: c.change === 'lost' ? 'worse' : 'neutral',
  }));
}

export function CollectionRunDiff({ runs, selected }: { runs: CollectionRunSummary[]; selected: string }) {
  const earlier = runs.filter((r) => r.id !== selected && !r.planOnly);
  const [before, setBefore] = useState('');
  const [diff, setDiff] = useState<CollectionDiff | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const label = (id: string) => {
    const r = runs.find((x) => x.id === id);
    return r ? `${id} (${new Date(r.startedMs).toLocaleString()})` : id;
  };
  const compare = () => {
    setProblem(null);
    void ipc.collectionDiff(before, selected).then(setDiff).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  const save = (ext: 'md' | 'csv') => {
    if (!diff) return;
    const rows = asDiffRows(diff);
    const body = ext === 'md' ? diffMarkdown(t('collect.diff.title'), label(before), label(selected), rows) : diffCsv(rows);
    void saveExport(`collection-diff-${before}-${selected}.${ext}`, body, ext === 'md' ? 'text/markdown' : 'text/csv', useStore.getState().settings.exportFolder)
      .then((path) => setNote(path ? t('trace.exported', { path }) : null))
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  return (
    <section data-region="collect-diff">
      <h3>{t('collect.diff.heading')}</h3>
      <div className="cv-discover-form">
        <label className="cv-field cv-field-narrow">
          <span>{t('collect.diff.against')}</span>
          <select className="cv-input" value={before} onChange={(e) => { setBefore(e.target.value); setDiff(null); }}>
            <option value="">{earlier.length ? t('collect.diff.choose') : t('collect.diff.none')}</option>
            {earlier.map((r) => <option key={r.id} value={r.id}>{label(r.id)}</option>)}
          </select>
        </label>
        <button type="button" className="cv-btn" disabled={!before} onClick={compare}>{t('collect.diff.compare')}</button>
        {diff && (
          <>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => save('md')}>{t('cpath.exportMarkdown')}</button>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => save('csv')}>{t('cpath.exportCsv')}</button>
          </>
        )}
      </div>
      {problem && <p className="cv-problem">{problem}</p>}
      {!problem && note && <p className="cv-help">{note}</p>}
      {diff && (
        <>
          <p className="cv-help" data-region="collect-diff-counts">
            {diff.changes.length === 0
              ? t('collect.diff.same')
              : diff.counts.filter((c) => c.new + c.lost + c.changed > 0).map((c) => t('collect.diff.count', { kind: t(`collect.diff.kind.${c.kind}`), new: c.new, lost: c.lost, changed: c.changed })).join(' · ')}
          </p>
          {diff.changes.length > 0 && (
            <table className="cv-table" data-region="collect-diff-table">
              <thead>
                <tr>
                  <th>{t('collect.diff.what')}</th>
                  <th>{t('collect.diff.change')}</th>
                  <th>{t('collect.diff.before')}</th>
                  <th>{t('collect.diff.after')}</th>
                </tr>
              </thead>
              <tbody>
                {KINDS.flatMap((k) => diff.changes.filter((c) => c.kind === k)).map((c, i) => (
                  <tr key={i} data-change={c.change} className={c.change === 'lost' ? 'is-warning' : undefined}>
                    <td>{c.subject}</td>
                    <td>{t(`collect.diff.${c.change}`, { kind: t(`collect.diff.kind.${c.kind}`) })}</td>
                    <td className="cv-mono">{c.before || '—'}</td>
                    <td className="cv-mono">{c.after || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
