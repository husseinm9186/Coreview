/**
 * Trace Path (LT-346): which routing decision each device makes, and where a
 * packet actually ends up.
 *
 * The Path check tab beside this one asks "can A reach B" and finds out by
 * sending something. This asks a different question and sends nothing: given
 * the routing tables already collected, *which way would it go, and why*.
 *
 * The routing data comes from a saved crawl run — the same runs the Compare
 * screen reads — so tracing does not touch the network and works on a
 * `.coreview` file opened on a train. What the engine will not do is guess:
 * a device whose table was never collected, a named VRF, or anything VXLAN
 * stops with "insufficient", named and explained.
 */
import { useEffect, useMemo, useState } from 'react';

import { t } from '../i18n';
import {
  applicationPageName,
  applicationReport,
  buildApplicationPage,
  type Application,
} from '../lib/appPath';
import { saveExport, slug } from '../lib/exports';
import { ipc, type CrawlResult } from '../lib/ipc';
import { activePage } from '../lib/pages';
import { devicesOnPath, tracePath, type PathDevice, type TraceResult } from '../lib/pathTrace';
import { useStore } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

/** A crawl's devices, as the engine wants them. */
function asPathDevices(result: CrawlResult | null): PathDevice[] {
  return (result?.devices ?? []).map((d) => ({
    hostname: d.hostname,
    addresses: [
      ...(d.addresses ?? []).map((a) => ({ ip: a.ip, interface: a.interface })),
      // The address it was actually reached on may not be in the list.
      ...(d.address ? [{ ip: d.address, interface: null }] : []),
    ],
    // `undefined` and `[]` mean different things here: never collected, or
    // collected and empty. The engine says so differently, so the distinction
    // has to survive.
    routes: d.routes
      ? d.routes.map((r) => ({
          family: r.family,
          prefix: r.prefix,
          protocol: r.protocol,
          nextHops: r.nextHops ?? [],
          interface: r.interface,
          distance: r.distance,
          metric: r.metric,
        }))
      : undefined,
    // LT-348: per-VRF tables, so a VRF is answered from its own routes.
    vrfRoutes: d.vrfRoutes
      ? Object.fromEntries(
          Object.entries(d.vrfRoutes).map(([name, rows]) => [
            name,
            rows.map((r) => ({
              family: r.family, prefix: r.prefix, protocol: r.protocol,
              nextHops: r.nextHops ?? [], interface: r.interface,
              distance: r.distance, metric: r.metric,
            })),
          ]),
        )
      : undefined,
    // LT-348: the things that change where traffic goes without routing it —
    // a translation, a virtual address, an L2 extension across a fabric.
    vtep: d.vtep,
    nat: d.nat,
    vips: d.vips,
    neighbours: (d.neighbors ?? []).map((n) => ({
      localInterface: n.localInterface,
      name: n.shortName || n.deviceId,
    })),
  }));
}

export function PathTracePanel() {
  const page = useStore((s) => activePage(s.doc));
  const meta = useStore((s) => s.meta);
  const setHighlight = useStore((s) => s.setCanvasHighlight);

  const [runs, setRuns] = useState<{ id: string; takenAt: number; devices: number }[]>([]);
  const [runId, setRunId] = useState('');
  const [result, setResult] = useState<CrawlResult | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [vrf, setVrf] = useState('');
  // LT-348: what the flow is, for the generated page and the report.
  const [appName, setAppName] = useState('');
  const [protocol, setProtocol] = useState('tcp');
  const [port, setPort] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [down, setDown] = useState<Set<string>>(new Set());
  // Everything any trace has gone through since the last fresh one. It only
  // ever grows, for two reasons: a list rebuilt from the current path loses
  // the very checkbox that was just ticked, so it could never be unticked;
  // and once an alternate path appears, that alternate is the next thing
  // somebody wants to take out.
  const [candidates, setCandidates] = useState<string[]>([]);
  const [traced, setTraced] = useState<TraceResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The runs this project has. Newest first is what `listCrawlRuns` gives.
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

  const devices = useMemo(() => asPathDevices(result), [result]);
  const withRoutes = devices.filter((d) => d.routes !== undefined).length;

  /** Hostname on the diagram, so a path can be lit up on it. */
  const nodeIdsFor = (names: string[]) => {
    const want = new Set(names.map((n) => n.trim().toLowerCase()));
    return new Set(
      page.nodes
        .filter((n) => {
          const d = n.data as DeviceNodeData;
          const label = (d.hostname || d.label || '').trim().toLowerCase();
          return want.has(label) || want.has(label.split('.')[0] ?? '');
        })
        .map((n) => n.id),
    );
  };

  const trace = (without: string[] = []) => {
    setProblem(null);
    const out = tracePath({
      devices,
      from,
      to,
      vrf,
      port: port.trim() ? Number(port) : undefined,
      without: { devices: without },
    });
    setTraced(out);
    const names = devicesOnPath(out);
    setCandidates((was) => [...new Set([...was, ...names])]);
    setHighlight(names.length > 0 ? nodeIdsFor(names) : null);
  };

  const clear = () => {
    setTraced(null);
    setDown(new Set());
    setCandidates([]);
    setHighlight(null);
  };

  // A path left lit on the diagram after the panel has gone is a diagram
  // nobody can read.
  useEffect(() => () => setHighlight(null), [setHighlight]);

  const hops = traced?.paths ?? [];

  /** What is being traced, as the page and the report describe it. */
  const application = (): Application => ({
    name: appName.trim() || undefined,
    source: from.trim(),
    destination: to.trim(),
    protocol: protocol.trim() || undefined,
    port: port.trim() ? Number(port) : null,
    vrf: vrf.trim() || undefined,
  });

  /**
   * LT-348: the generated diagram, on a page of its own.
   *
   * The page the trace was calculated from is not read here and not written:
   * `buildApplicationPage` makes new nodes and edges from the trace, and
   * `addGeneratedPage` adds a page beside the others through the Pages
   * machinery that already exists. Generating a second application makes a
   * second page.
   */
  const createPage = () => {
    if (!traced) return;
    const app = application();
    const built = buildApplicationPage(traced, app);
    if (built.nodes.length === 0) {
      setProblem(t('trace.nothingToDraw'));
      return;
    }
    useStore.getState().addGeneratedPage(applicationPageName(app), {
      nodes: built.nodes,
      edges: built.edges,
    });
    // The new page is now in front; a highlight belonging to the old one is
    // not about anything there.
    setHighlight(null);
    useStore.getState().requestFit();
    setNote(t('trace.pageMade', { name: applicationPageName(app) }));
  };

  /** The application report, beside the project's other exports. */
  const exportReport = () => {
    if (!traced || !meta) return;
    const app = application();
    const body = applicationReport(traced, app, buildApplicationPage(traced, app));
    void saveExport(
      `${slug(applicationPageName(app))}.md`,
      body,
      'text/markdown',
      useStore.getState().settings.exportFolder,
    )
      .then((path) => setNote(path ? t('trace.exported', { path }) : null))
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="cv-pathtrace">
      <div className="cv-discover-form">
        <label className="cv-field cv-field-narrow">
          <span>{t('trace.run')}</span>
          <select className="cv-input" value={runId} onChange={(e) => { setRunId(e.target.value); setTraced(null); }}>
            {runs.length === 0 && <option value="">{t('trace.noRuns')}</option>}
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.takenAt).toLocaleString()} — {r.devices}
              </option>
            ))}
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('trace.from')}</span>
          <input className="cv-input cv-mono" value={from} spellCheck={false} list="cv-trace-devices"
            placeholder="CORE-SW1" onChange={(e) => setFrom(e.target.value)} />
          <datalist id="cv-trace-devices">
            {devices.map((d) => <option key={d.hostname} value={d.hostname} />)}
          </datalist>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('trace.to')}</span>
          <input className="cv-input cv-mono" value={to} spellCheck={false} placeholder="10.40.50.9"
            onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('trace.app')}</span>
          <input className="cv-input" value={appName} placeholder="Customer Portal"
            onChange={(e) => setAppName(e.target.value)} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('trace.protocol')}</span>
          <select className="cv-input" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="icmp">ICMP</option>
            <option value="">Any</option>
          </select>
        </label>
        <label className="cv-field cv-field-narrow cv-trace-port">
          <span>{t('trace.port')}</span>
          <input className="cv-input cv-mono" value={port} inputMode="numeric" placeholder="443"
            onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('trace.vrf')}</span>
          <input className="cv-input cv-mono" value={vrf} spellCheck={false} placeholder={t('trace.vrfDefault')}
            onChange={(e) => setVrf(e.target.value)} />
        </label>
        <button type="button" className="cv-btn cv-btn-start" disabled={!from.trim() || !to.trim()}
          onClick={() => { setDown(new Set()); setCandidates([]); trace(); }}>
          {t('trace.go')}
        </button>
        {traced && (
          <>
            <button type="button" className="cv-btn" onClick={createPage}>{t('trace.makePage')}</button>
            <button type="button" className="cv-btn cv-btn-small" onClick={exportReport}>{t('trace.export')}</button>
            <button type="button" className="cv-btn cv-btn-small" onClick={clear}>{t('trace.clear')}</button>
          </>
        )}
      </div>

      <p className="cv-help">
        {runs.length === 0
          ? t('trace.needCrawl')
          : t('trace.source', { devices: devices.length, withRoutes })}
      </p>
      {problem && <p className="cv-problem">{problem}</p>}
      {!problem && note && <p className="cv-help cv-trace-made">{note}</p>}

      {traced && traced.kind === 'insufficient' && (
        <p className="cv-problem cv-trace-insufficient">
          <strong>{t('trace.insufficient')}</strong> {traced.reason}
        </p>
      )}
      {traced && traced.kind === 'unreachable' && (
        <p className="cv-problem">
          <strong>{t('trace.unreachable', { at: traced.at })}</strong> {traced.reason}
        </p>
      )}
      {traced && traced.kind === 'loop' && (
        <p className="cv-problem">{t('trace.loop', { at: traced.at })}</p>
      )}

      {hops.map((path, i) => (
        <div className="cv-trace-path" key={i} data-region="trace-path">
          {hops.length > 1 && <strong className="cv-trace-ecmp">{t('trace.ecmpLeg', { n: i + 1, of: hops.length })}</strong>}
          <table className="cv-table">
            <thead>
              <tr>
                <th>{t('trace.colHop')}</th>
                <th>{t('trace.colDevice')}</th>
                <th>{t('trace.colPrefix')}</th>
                <th>{t('trace.colProtocol')}</th>
                <th>{t('trace.colNextHop')}</th>
                <th>{t('trace.colOut')}</th>
                <th>{t('trace.colMetric')}</th>
              </tr>
            </thead>
            <tbody>
              {path.map((hop, n) => (
                <tr key={`${hop.device}-${n}`}>
                  <td>{n + 1}</td>
                  <td>{hop.device}</td>
                  <td className="cv-mono">{hop.prefix}</td>
                  <td>{hop.protocol}</td>
                  <td className="cv-mono">{hop.nextHop ?? '—'}</td>
                  <td className="cv-mono">{hop.outInterface ?? '—'}</td>
                  <td className="cv-mono">
                    {hop.distance ?? '—'}/{hop.metric ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* "Why this path?" — the route selection, said in sentences. */}
          <details className="cv-trace-why" open={i === 0}>
            <summary>{t('trace.why')}</summary>
            <ol className="cv-trace-reasons">
              {path.map((hop, n) => (
                <li key={`${hop.device}-why-${n}`}>
                  <strong>{hop.device}</strong> {hop.why}
                  {hop.via.length > 0 && (
                    <div className="cv-help">
                      {t('trace.resolved', {
                        hop: hop.nextHop ?? '',
                        chain: hop.via.map((v) => `${v.prefix} (${v.protocol})`).join(' → '),
                      })}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </details>
        </div>
      ))}

      {traced && candidates.length > 0 && (
        <details className="cv-trace-simulate" data-region="simulate">
          <summary>{t('trace.simulate')}</summary>
          <p className="cv-help">{t('trace.simulateHint')}</p>
          <div className="cv-trace-targets">
            {candidates.map((name) => (
              <label key={name} className="cv-check cv-check-inline">
                <input type="checkbox" checked={down.has(name)}
                  onChange={(e) => {
                    const next = new Set(down);
                    if (e.target.checked) next.add(name);
                    else next.delete(name);
                    setDown(next);
                    trace([...next]);
                  }} />
                {name}
              </label>
            ))}
          </div>
          {down.size > 0 && <p className="cv-help cv-trace-simulating">{t('trace.simulating', { names: [...down].join(', ') })}</p>}
        </details>
      )}
    </div>
  );
}
