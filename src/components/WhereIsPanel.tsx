/**
 * "Where is this?" (LT-338) — one search over everything a crawl found.
 *
 * The routing panel asks where a packet would go; this asks where a *thing*
 * is. It reads a saved crawl run and looks through what every device learned
 * on every port, so a MAC, an address, a name or a maker's name comes back as
 * a switch, a port and a VLAN — including for the many things that were never
 * drawn on any diagram.
 *
 * Nothing is sent to the network: this is a query over what was collected.
 */
import { useEffect, useMemo, useState } from 'react';

import { ipc } from '../lib/ipc';
import type { CrawlResult } from '../lib/ipc';
import { t } from '../i18n';
import { useStore } from '../state/store';
import { whereIs } from '../lib/whereIs';

export function WhereIsPanel() {
  const meta = useStore((s) => s.meta);
  const [runs, setRuns] = useState<{ id: string; takenAt: number; seed: string; devices: number }[]>([]);
  const [runId, setRunId] = useState('');
  const [result, setResult] = useState<CrawlResult | null>(null);
  const [query, setQuery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!meta) return;
    void ipc
      .listCrawlRuns(meta.id)
      .then((all) => {
        setRuns(all);
        setRunId((was) => was || (all[0]?.id ?? ''));
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  }, [meta]);

  useEffect(() => {
    if (!runId) return;
    void ipc
      .crawlRunResult(runId)
      .then(setResult)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  }, [runId]);

  // Its own memo: a fresh [] each render would re-run every search below.
  const devices = useMemo(() => result?.devices ?? [], [result]);
  const hits = useMemo(() => whereIs(query, devices), [query, devices]);
  const learned = useMemo(
    () => devices.reduce((n, d) => n + d.attached.length, 0),
    [devices],
  );

  return (
    <div className="cv-whereis">
      <div className="cv-discover-form">
        <label className="cv-field cv-field-narrow">
          <span>{t('whereis.run')}</span>
          <select className="cv-input" value={runId} onChange={(e) => setRunId(e.target.value)}>
            {runs.length === 0 && <option value="">{t('whereis.noRuns')}</option>}
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.takenAt).toLocaleString()} — {t('whereis.runDevices', { count: r.devices })}
              </option>
            ))}
          </select>
        </label>
        <label className="cv-field cv-field-wide">
          <span>{t('whereis.find')}</span>
          <input
            className="cv-input cv-mono"
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('whereis.placeholder')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      {problem && <p className="cv-problem">{problem}</p>}

      <p className="cv-muted">
        {runs.length === 0
          ? t('whereis.needCrawl')
          : t('whereis.source', { devices: devices.length, learned })}
      </p>

      {query.trim() !== '' && hits.length === 0 && (
        <p className="cv-muted">{t('whereis.nothing', { query: query.trim() })}</p>
      )}

      {hits.length > 0 && (
        <table className="cv-table">
          <thead>
            <tr>
              <th>{t('whereis.colWhat')}</th>
              <th>{t('whereis.colAddress')}</th>
              <th>{t('whereis.colMac')}</th>
              <th>{t('whereis.colSeenBy')}</th>
              <th>{t('whereis.colPort')}</th>
              <th>{t('whereis.colVlan')}</th>
              <th>{t('whereis.colMaker')}</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h, i) => (
              <tr key={`${h.seenBy}-${h.mac ?? h.address ?? i}-${i}`}>
                <td>
                  {h.hostname ?? (h.isDevice ? h.seenBy : '—')}
                  {h.isDevice && <span className="cv-pill">{t('whereis.isDevice')}</span>}
                </td>
                <td className="cv-mono">{h.address ?? '—'}</td>
                <td className="cv-mono">{h.mac ?? '—'}</td>
                <td>{h.isDevice ? '—' : h.seenBy}</td>
                <td className="cv-mono">
                  {h.port || '—'}
                  {/* A port with many addresses behind it leads to another
                      switch: saying which switch would be a guess. */}
                  {h.sharedPort && (
                    <span className="cv-pill" title={t('whereis.sharedTitle', { count: h.portPopulation })}>
                      {t('whereis.shared')}
                    </span>
                  )}
                </td>
                <td className="cv-mono">{h.vlan ?? '—'}</td>
                <td>{h.vendor ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
