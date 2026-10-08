/**
 * Compare: two validation sessions, or two crawls,
 * side by side — what got worse, what got better, what appeared and went — and
 * the comparison saved as Markdown or CSV.
 */
import { useEffect, useMemo, useState } from 'react';

import { saveExport, slug } from '../lib/exports';
import { ipc, type CrawlTimeline } from '../lib/ipc';
import { allNodes } from '../lib/pages';
import { diffCrawls, diffCsv, diffMarkdown, diffSessions, type DiffRow } from '../lib/runDiff';
import { byRun, changeWords, fieldWords, sinceLastLine, timelineCsv, timelineMarkdown } from '../lib/timeline';
import { sourceWords } from '../lib/evidence';
import { t } from '../i18n';
import { EmptyState } from './EmptyState';
import { formatTime } from '../lib/timeFormat';
import { useStore } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

type Kind = 'sessions' | 'crawls' | 'timeline';

export function ComparePanel() {
  const meta = useStore((s) => s.meta);
  // The pages and the probes, not the whole document.
  const pages = useStore((s) => s.doc.pages);
  const probes = useStore((s) => s.doc.probes);
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const exportFolder = useStore((s) => s.settings.exportFolder);
  const [kind, setKind] = useState<Kind>('sessions');
  const [options, setOptions] = useState<{ id: string; label: string }[]>([]);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [rows, setRows] = useState<DiffRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Every kept crawl, as a timeline of what changed.
  const [device, setDevice] = useState('');
  const [timeline, setTimeline] = useState<CrawlTimeline | null>(null);

  useEffect(() => {
    if (!meta) return;
    setRows(null);
    setTimeline(null);
    setFirst('');
    setSecond('');
    if (kind === 'timeline') {
      setOptions([]);
      return;
    }
    const load =
      kind === 'sessions'
        ? ipc.listSessions(meta.id).then((list) =>
            list.map((s) => ({ id: s.id, label: `${formatTime(s.startedAt, timeFormat)} — ${s.samples} results, ${s.transitions} changes` })),
          )
        : ipc.listCrawlRuns(meta.id).then((list) =>
            list.map((r) => ({ id: r.id, label: `${formatTime(r.takenAt, timeFormat)} — ${r.devices} devices from ${r.seed || 'a seed'}` })),
          );
    void load.then(setOptions).catch(() => setOptions([]));
  }, [kind, meta, timeFormat]);

  const probeName = useMemo(() => {
    const labels = new Map(allNodes({ pages }).map((n) => [n.id, (n.data as DeviceNodeData).label]));
    const names = new Map(probes.map((p) => [p.id, `${labels.get(p.objectId) ?? 'A link'} — ${p.name}`]));
    return (id: string) => names.get(id) ?? 'A check since removed';
  }, [pages, probes]);

  const compare = async () => {
    setProblem(null);
    try {
      if (kind === 'sessions') {
        const [a, b] = await Promise.all([ipc.sessionSummary(first), ipc.sessionSummary(second)]);
        setRows(diffSessions(a, b, probeName));
      } else {
        const [a, b] = await Promise.all([ipc.crawlRunResult(first), ipc.crawlRunResult(second)]);
        setRows(diffCrawls(a.devices, b.devices));
      }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  const loadTimeline = async () => {
    if (!meta) return;
    setProblem(null);
    try {
      setTimeline(await ipc.crawlTimeline(meta.id, device));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };
  const when = (ms: number) => formatTime(ms, timeFormat);
  const saveTimeline = async (format: 'md' | 'csv') => {
    if (!timeline || !meta) return;
    const body = format === 'md' ? timelineMarkdown(t('timeline.title'), timeline.entries, when) : timelineCsv(timeline.entries, when);
    const path = await saveExport(`${slug(meta.name)}-timeline.${format}`, body, format === 'md' ? 'text/markdown' : 'text/csv', exportFolder);
    if (path) useStore.getState().setStatusMessage(`Saved the timeline to ${path}.`);
  };

  const labelOf = (id: string) => options.find((o) => o.id === id)?.label ?? id;
  const title = kind === 'sessions' ? 'Validation sessions compared' : 'Crawls compared';
  const save = async (format: 'md' | 'csv') => {
    if (!rows || !meta) return;
    const body = format === 'md' ? diffMarkdown(title, labelOf(first), labelOf(second), rows) : diffCsv(rows);
    const path = await saveExport(`${slug(meta.name)}-${kind}-compared.${format}`, body, format === 'md' ? 'text/markdown' : 'text/csv', exportFolder);
    if (path) useStore.getState().setStatusMessage(`Saved the comparison to ${path}.`);
  };

  return (
    <div className="cv-compare">
      <div className="cv-discover-form">
        <div className="cv-seg" role="group" aria-label="What to compare">
          <button type="button" className={kind === 'sessions' ? 'is-on' : ''} aria-pressed={kind === 'sessions'} onClick={() => setKind('sessions')}>Validation sessions</button>
          <button type="button" className={kind === 'crawls' ? 'is-on' : ''} aria-pressed={kind === 'crawls'} onClick={() => setKind('crawls')}>Crawls</button>
          <button type="button" className={kind === 'timeline' ? 'is-on' : ''} aria-pressed={kind === 'timeline'} onClick={() => setKind('timeline')}>Timeline</button>
        </div>
        {kind === 'timeline' ? (
          <>
            <label className="cv-field">
              <span>{t('timeline.device')}</span>
              <input className="cv-input" value={device} onChange={(e) => setDevice(e.target.value)} />
            </label>
            <button type="button" className="cv-btn cv-btn-small cv-btn-start" onClick={() => void loadTimeline()}>
              {t('timeline.load')}
            </button>
          </>
        ) : (
        <>
        <label className="cv-field">
          <span>First</span>
          <select className="cv-input" value={first} onChange={(e) => setFirst(e.target.value)}>
            <option value="">Choose one</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label className="cv-field">
          <span>Second</span>
          <select className="cv-input" value={second} onChange={(e) => setSecond(e.target.value)}>
            <option value="">Choose one</option>
            {options.filter((o) => o.id !== first).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <button type="button" className="cv-btn cv-btn-small cv-btn-start" disabled={!first || !second} onClick={() => void compare()}>
          Compare
        </button>
        </>
        )}
      </div>
      {kind === 'timeline' && timeline && (
        <div className="cv-timeline">
          <div className="cv-discover-actions">
            <span className="cv-help cv-timeline-since">{sinceLastLine(timeline.sinceLast, timeline.runs)}</span>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => void saveTimeline('md')}>Save as Markdown</button>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => void saveTimeline('csv')}>Save as CSV</button>
          </div>
          {byRun(timeline.entries).map((g) => (
            <section key={g.runId} className="cv-timeline-run">
              <h4 className="cv-backup-head">{when(g.takenAt)}</h4>
              <div className="cv-table-scroll">
                <table className="cv-table cv-compare-table">
                  <thead><tr><th>Device</th><th>What</th><th>Change</th><th>Source</th></tr></thead>
                  <tbody>
                    {g.entries.map((e, i) => (
                      <tr key={i} data-field={e.field}>
                        <td>{e.device}</td>
                        <td>{fieldWords(e.field)}</td>
                        <td className="cv-mono">{changeWords(e)}</td>
                        <td className="cv-help">{e.source ? sourceWords(e.source) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
      {kind !== 'timeline' && options.length < 2 && (
        <p className="cv-help">
          {kind === 'sessions' ? 'Two validation sessions are needed; each Start and Stop makes one.' : 'Two crawls are needed; every crawl run from Discover devices is kept.'}
        </p>
      )}
      {problem && <p className="cv-discover-problem">{problem}</p>}
      {rows && (
        <>
          <div className="cv-discover-actions">
            {rows.length === 0
              ? <EmptyState what={t('empty.compare.what')} why={t('empty.compare.why')} />
              : <span className="cv-help">{`${t('plural.difference', { count: rows.length })}, worst first.`}</span>}
            <button type="button" className="cv-btn cv-btn-small" onClick={() => void save('md')}>Save as Markdown</button>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => void save('csv')}>Save as CSV</button>
          </div>
          {rows.length > 0 && (
            <div className="cv-table-scroll">
              <table className="cv-table cv-compare-table">
                <thead><tr><th>What</th><th>Change</th><th>First</th><th>Second</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={`is-${r.tone}`}>
                      <td>{r.subject}</td>
                      <td><span className="cv-compare-change">{r.tone === 'worse' ? '▼ ' : r.tone === 'better' ? '▲ ' : ''}{r.change}</span></td>
                      <td className="cv-mono">{r.before}</td>
                      <td className="cv-mono">{r.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
