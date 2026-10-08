/**
 * What the Rust path builder adds to Path-Trace when the run came
 * from a collection — each hop's decision, the switches between routers,
 * firewall verdicts and NAT, the way back and where it differs, the
 * traceroute held against the model, and the devices asked live.
 *
 * The hop table above this, the highlight, the application page and the
 * report are Path-Trace's own, fed through `asTraceResult`.
 */
import { useState } from 'react';

import { t } from '../i18n';
import { endingText, toCsv, toMarkdown } from '../lib/collectedPath';
import { saveExport, slug } from '../lib/exports';
import { ipc, type LiveReport, type PathHop, type PathOutcome, type PathRequest, type PathTrace } from '../lib/ipc';
import { useStore } from '../state/store';

function Switches({ hop }: { hop: PathHop }) {
  if (hop.l2.length === 0) return <>—</>;
  return (
    <span className="cv-mono">
      {hop.l2.map((s, i) => (
        <span key={i} className={s.blocked ? 'cv-problem' : undefined}>
          {i > 0 && ' › '}
          {s.device}
          {s.inPort ? ` ${s.inPort}` : ''}
          {s.outPort ? ` → ${s.outPort}` : ''}
          {s.blocked ? ` (${t('cpath.blocked')})` : ''}
        </span>
      ))}
    </span>
  );
}

function PathTables({ trace, region }: { trace: PathTrace; region: string }) {
  return (
    <>
      {trace.paths.map((p, i) => (
        <div key={i} className="cv-trace-path" data-region={region}>
          {trace.paths.length > 1 && <strong className="cv-trace-ecmp">{t('trace.ecmpLeg', { n: i + 1, of: trace.paths.length })}</strong>}
          <table className="cv-table">
            <thead>
              <tr>
                <th>{t('trace.colHop')}</th>
                <th>{t('trace.colDevice')}</th>
                <th>{t('cpath.colIn')}</th>
                <th>{t('cpath.colDecision')}</th>
                <th>{t('cpath.colFirewall')}</th>
                <th>NAT</th>
                <th>{t('cpath.colSwitches')}</th>
              </tr>
            </thead>
            <tbody>
              {p.hops.map((h, n) => (
                <tr key={`${h.device}-${n}`} data-decision={h.decision}>
                  <td>{n + 1}</td>
                  <td>{h.device}{h.vrf !== 'default' && <span className="cv-help"> ({h.vrf})</span>}</td>
                  <td className="cv-mono">{h.inInterface ?? '—'}</td>
                  <td>{t(`cpath.decision.${h.decision}`)}</td>
                  <td data-verdict={h.firewall?.verdict}>
                    {h.firewall ? (
                      <span title={h.firewall.reason}>
                        {t(`cpath.verdict.${h.firewall.verdict}`)}
                        {h.firewall.policy ? ` · ${h.firewall.policy}` : ''}
                        {h.firewall.zoneIn || h.firewall.zoneOut ? <div className="cv-help">{h.firewall.zoneIn ?? '—'} → {h.firewall.zoneOut ?? '—'}</div> : null}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="cv-mono">{h.nat.length ? h.nat.map((x) => `${x.was} → ${x.now}`).join('; ') : '—'}</td>
                  <td><Switches hop={h} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.hops.some((h) => h.overlay) && p.hops.filter((h) => h.overlay).map((h, k) => (
            <p key={k} className="cv-help">{t('cpath.overlay', { device: h.device, tunnel: h.overlay!.tunnel, remote: h.overlay!.remote, underlay: h.overlay!.underlay.join(' › ') || '—' })}</p>
          ))}
          <p className={`cv-help cv-trace-ending${p.ending.kind === 'delivered' ? '' : ' cv-problem'}`} data-ending={p.ending.kind}>{endingText(p.ending)}</p>
        </div>
      ))}
    </>
  );
}

export function CollectedPathDetail({ outcome, runId, request, credentialId }: { outcome: PathOutcome; runId: string; request: PathRequest; credentialId?: string }) {
  const [live, setLive] = useState<LiveReport | null>(null);
  const [asking, setAsking] = useState(false);
  const [livePort, setLivePort] = useState('22');
  const [livePath, setLivePath] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const f = outcome.forward;

  const save = (ext: string, body: string, mime: string) => {
    const name = `path-${slug(f.from)}-to-${slug(f.to)}.${ext}`;
    void saveExport(name, body, mime, useStore.getState().settings.exportFolder)
      .then((path) => setNote(path ? t('trace.exported', { path }) : null))
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  const askLive = () => {
    if (!credentialId) {
      setProblem(t('cpath.liveNeedsLogin'));
      return;
    }
    setProblem(null);
    setAsking(true);
    void ipc
      .collectionLive({ runId, request, credentialId, port: Number(livePort) || 22, path: livePath })
      .then(setLive)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setAsking(false));
  };

  return (
    <div className="cv-collected-path" data-region="collected-path">
      {f.source && (
        <p className="cv-help" data-region="path-source">
          {f.source.how}
          {f.source.endpoint && ` ${t('cpath.sourcePlace', { switch: f.source.endpoint.switch, port: f.source.endpoint.port })}`}
        </p>
      )}
      <PathTables trace={f} region="collected-hops" />
      {f.warnings.length > 0 && (
        <ul className="cv-trace-warnings" data-region="path-warnings">
          {f.warnings.map((w, i) => <li key={i} className="cv-problem">{w}</li>)}
        </ul>
      )}

      {outcome.reverse && (
        <details className="cv-trace-why" data-region="reverse" open={outcome.asymmetry ? !outcome.asymmetry.symmetric : false}>
          <summary>
            {t('cpath.reverse')}
            {outcome.asymmetry && ` — ${outcome.asymmetry.symmetric ? t('cpath.symmetric') : t('cpath.asymmetric')}`}
          </summary>
          {outcome.asymmetry?.notes.map((n, i) => <p key={i} className="cv-problem" data-region="asymmetry-note">{n}</p>)}
          <PathTables trace={outcome.reverse} region="reverse-hops" />
        </details>
      )}

      {outcome.verify && (
        <div data-region="verify">
          <p className={`cv-help${outcome.verify.matchPercent < 100 ? ' cv-problem' : ''}`}>
            <strong>{t('cpath.matchPercent', { pct: outcome.verify.matchPercent })}</strong>
          </p>
          <table className="cv-table">
            <thead>
              <tr>
                <th>{t('trace.colTtl')}</th>
                <th>{t('trace.colAddress')}</th>
                <th>{t('trace.colDevice')}</th>
                <th>{t('cpath.modeled')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {outcome.verify.rows.map((r) => (
                <tr key={r.n} data-agrees={r.agrees ? 'yes' : 'no'}>
                  <td>{r.n}</td>
                  <td className="cv-mono">{r.traceroute ?? '*'}</td>
                  <td>{r.tracerouteDevice ?? '—'}</td>
                  <td>{r.modeled ?? '—'}</td>
                  <td>{r.agrees ? t('cpath.agrees') : t('cpath.differs')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="cv-trace-measure" data-region="live">
        <p className="cv-help">{t('cpath.liveHelp')}</p>
        {f.paths.length > 1 && (
          <label className="cv-field cv-field-narrow">
            <span>{t('cpath.livePath')}</span>
            <select className="cv-input" value={livePath} onChange={(e) => setLivePath(Number(e.target.value))}>
              {f.paths.map((_, i) => <option key={i} value={i}>{t('trace.ecmpLeg', { n: i + 1, of: f.paths.length })}</option>)}
            </select>
          </label>
        )}
        <label className="cv-field cv-field-narrow cv-trace-port">
          <span>{t('collect.port')}</span>
          <input className="cv-input cv-mono" value={livePort} inputMode="numeric" onChange={(e) => setLivePort(e.target.value.replace(/[^0-9]/g, ''))} />
        </label>
        <button type="button" className="cv-btn cv-btn-small" disabled={asking} onClick={askLive}>
          {asking ? t('cpath.asking') : t('cpath.askLive')}
        </button>
        {live && (
          <table className="cv-table" data-region="live-answers">
            <thead>
              <tr>
                <th>{t('trace.colDevice')}</th>
                <th>{t('cpath.liveVerdict')}</th>
                <th>{t('cpath.liveAnswers')}</th>
              </tr>
            </thead>
            <tbody>
              {live.hops.map((h) => (
                <tr key={h.device} data-agrees={h.check.agrees === null ? 'unknown' : h.check.agrees ? 'yes' : 'no'}>
                  <td>{h.device}</td>
                  <td>
                    <strong>{h.check.agrees === null ? t('cpath.liveUnknown') : h.check.agrees ? t('cpath.agrees') : t('cpath.differs')}</strong>
                    <div className="cv-help">{h.check.detail}</div>
                  </td>
                  <td>
                    {(h.run?.answers ?? []).map((a, i) => (
                      <details key={i} className="cv-trace-why">
                        <summary className="cv-mono">{a.command} · {a.status}{a.verified === 'unverified' ? ` · ${t('cpath.unverified')}` : ''}</summary>
                        {a.reason && <p className="cv-help">{a.reason}</p>}
                        {a.raw && <pre className="cv-mono cv-collect-raw">{a.raw}</pre>}
                      </details>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="cv-row" data-region="path-export">
        <button type="button" className="cv-btn cv-btn-small" onClick={() => save('json', `${JSON.stringify(outcome, null, 2)}\n`, 'application/json')}>{t('cpath.exportJson')}</button>
        <button type="button" className="cv-btn cv-btn-small" onClick={() => save('csv', toCsv(outcome), 'text/csv')}>{t('cpath.exportCsv')}</button>
        <button type="button" className="cv-btn cv-btn-small" onClick={() => save('md', toMarkdown(outcome), 'text/markdown')}>{t('cpath.exportMarkdown')}</button>
      </div>
      {problem && <p className="cv-problem">{problem}</p>}
      {!problem && note && <p className="cv-help">{note}</p>}
    </div>
  );
}
