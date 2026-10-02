/**
 * Path-Trace (LT-346, named LT-500): which routing decision each device makes, and where a
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
import { asTraceResult, collectionRunOf, devicesIn } from '../lib/collectedPath';
import { saveExport, slug } from '../lib/exports';
import { ipc, type CrawledDevice, type CrawlResult, type MeasuredLeg, type MeasuredTrace, type PathOutcome, type PathRequest } from '../lib/ipc';
import { activePage } from '../lib/pages';
import { devicesOnPath, tracePath, type PathDevice, type TraceResult } from '../lib/pathTrace';
import { useStore } from '../state/store';
import type { DeviceNodeData } from '../types/domain';
import { CollectedPathDetail } from './CollectedPathDetail';
import { SavedCredentialSelect } from './CredentialPicker';

/**
 * A crawled device's overlay, as the path engine wants it (LT-347).
 *
 * `undefined` when the device is not a tunnel endpoint or the run did not ask
 * — which is different from a VTEP with no segments, and the engine treats it
 * as such.
 */
function vtepFrom(overlay: CrawledDevice['overlay']): PathDevice['vtep'] {
  if (!overlay?.vtep || overlay.segments.length === 0) return undefined;
  // A type-5 route names a prefix behind a VTEP; a type-2 names one host. The
  // prefix is what lets the engine decide an address is in this segment.
  const prefixFor = (vni: number) =>
    overlay.learned.find((r) => r.routeType === 5 && r.vni === vni && r.address)?.address ?? null;
  return {
    address: overlay.vtep,
    segments: overlay.segments.map((s) => ({ vni: s.vni, vlan: s.vlan, prefix: prefixFor(s.vni) })),
  };
}

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
          // LT-347: where the next hop is resolved, and whether the route
          // crosses the overlay. Both are the device's own words.
          nextHopVrf: r.nextHopVrf,
          segmentId: r.segmentId,
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
              nextHopVrf: r.nextHopVrf, segmentId: r.segmentId,
            })),
          ]),
        )
      : undefined,
    // LT-348: the things that change where traffic goes without routing it —
    // a translation, a virtual address, an L2 extension across a fabric.
    //
    // LT-347: a crawl fills `overlay` in the shape the fabric printed; the
    // engine wants a VTEP address and the segments behind it. The prefix on
    // each segment comes from the EVPN type-5 routes learned for that VNI —
    // which is what says *which addresses* are behind a remote VTEP rather
    // than only that the VNI is shared.
    vtep: d.vtep ?? vtepFrom(d.overlay),
    nat: d.nat,
    vips: d.vips,
    // LT-479: so a hop can say a policy was not evaluated.
    policyRoutes: d.policyRoutes,
    // LT-480: OTV, and the MAC behind each address this device learned, so
    // a destination on an extended VLAN can be sent to the edge owning it.
    otv: d.otv ?? undefined,
    macs: Object.fromEntries((d.attached ?? []).filter((a) => a.address).map((a) => [a.address as string, a.mac.toLowerCase().replace(/[^0-9a-f]/g, '')])),
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

  // LT-357: `seed` was fetched and dropped. With two runs a minute apart the
  // date alone cannot say which part of the network each one covered.
  const [runs, setRuns] = useState<{ id: string; takenAt: number; seed: string; devices: number }[]>([]);
  const [runId, setRunId] = useState('');
  const [result, setResult] = useState<CrawlResult | null>(null);
  const [from, setFrom] = useState('');
  // LT-679: the question is the store's, shared with Tracert, Path check and Where is.
  const question = useStore((s) => s.pathQuestion);
  const setQuestion = useStore((s) => s.setPathQuestion);
  const to = question.to;
  const setTo = (v: string) => setQuestion({ to: v });
  const vrf = question.vrf;
  const setVrf = (v: string) => setQuestion({ vrf: v });
  // LT-348: what the flow is, for the generated page and the report.
  const appName = question.app;
  const setAppName = (v: string) => setQuestion({ app: v });
  const protocol = question.protocol;
  const setProtocol = (v: string) => setQuestion({ protocol: v });
  const port = question.port;
  const setPort = (v: string) => setQuestion({ port: v });
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
  // LT-477: the measured path, from the source device's own traceroute;
  // LT-478: the legs devices said they hash this flow onto, per hop.
  const [credentialId, setCredentialId] = useState<string | undefined>();
  const [measured, setMeasured] = useState<MeasuredTrace | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [legs, setLegs] = useState<Record<string, MeasuredLeg | string>>({});
  // LT-536: a run built from a collection is traced by the Rust builder,
  // which also takes an endpoint's address as the source.
  const [outcome, setOutcome] = useState<PathOutcome | null>(null);
  const [fromAddress, setFromAddress] = useState('');
  const collectionRun = collectionRunOf(runs.find((r) => r.id === runId)?.seed);

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

  /** What the Rust builder is asked (LT-536). */
  const pathRequest = (without: string[] = [], traceroute?: (string | null)[]): PathRequest => ({
    from: (fromAddress.trim() || from).trim(),
    to: to.trim(),
    vrf: vrf.trim() || null,
    protocol: protocol || null,
    port: port.trim() ? Number(port) : null,
    downDevices: without,
    traceroute: traceroute ?? null,
  });

  const traceCollected = (runOfCollection: string, without: string[]) => {
    setProblem(null);
    void ipc
      .collectionPath(runOfCollection, pathRequest(without))
      .then((out) => {
        setOutcome(out);
        setTraced(asTraceResult(out.forward));
        const names = devicesIn(out);
        setCandidates((was) => [...new Set([...was, ...names])]);
        setHighlight(names.length > 0 ? nodeIdsFor(names) : null);
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  const trace = (without: string[] = []) => {
    if (collectionRun) {
      traceCollected(collectionRun, without);
      return;
    }
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
    setOutcome(null);
    setDown(new Set());
    setCandidates([]);
    setHighlight(null);
    setMeasured(null);
    setLegs({});
  };

  /** LT-492: every address the crawl holds for a device, the one it was
   *  reached on marked as management, for the generated page. */
  const addressesOf = (hostname: string) => {
    const want = hostname.trim().toLowerCase();
    const d = (result?.devices ?? []).find((x) => x.hostname.trim().toLowerCase() === want);
    if (!d) return [];
    const reached = d.probeTarget || d.address;
    return [
      ...(reached ? [{ ip: reached, interface: null, isManagement: true }] : []),
      ...(d.addresses ?? []).map((a) => ({ ip: a.ip, interface: a.interface, isManagement: a.isManagement || a.ip === reached })),
    ];
  };

  /** The address the crawl reached a device on, by its hostname. */
  const addressOf = (hostname: string): string | null => {
    const want = hostname.trim().toLowerCase();
    const d = (result?.devices ?? []).find((x) => x.hostname.trim().toLowerCase() === want);
    return d?.address ?? d?.addresses?.[0]?.ip ?? null;
  };
  /** The crawled device holding an address, if any. */
  const deviceHolding = (address: string): string | null =>
    devices.find((d) => d.addresses.some((a) => a.ip.trim() === address.trim()))?.hostname ?? null;
  const protocolNumber = protocol === 'tcp' ? 6 : protocol === 'udp' ? 17 : protocol === 'icmp' ? 1 : null;

  const measure = () => {
    const source = addressOf(from);
    if (!credentialId) {
      setProblem(t('trace.needCredential', { device: from }));
      return;
    }
    if (!source) {
      setProblem(t('trace.noSourceAddress', { device: from }));
      return;
    }
    setProblem(null);
    setMeasuring(true);
    void ipc
      .tracerouteFromDevice(source, credentialId, to.trim())
      .then((m) => {
        setMeasured(m);
        // LT-534: the same traceroute held against the modeled path.
        if (collectionRun) {
          return ipc.collectionPath(collectionRun, pathRequest([...down], m.hops.map((h) => h.address ?? null))).then(setOutcome);
        }
        return undefined;
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setMeasuring(false));
  };

  const askLeg = (key: string, device: string) => {
    const address = addressOf(device);
    const source = addressOf(from);
    if (!credentialId || !address || !source) {
      setProblem(!credentialId ? t('trace.needCredential', { device }) : t('trace.noSourceAddress', { device: !address ? device : from }));
      return;
    }
    setProblem(null);
    void ipc
      .ecmpLegFromDevice(address, credentialId, source, to.trim(), protocolNumber, null, port.trim() ? Number(port) : null)
      .then((leg) => setLegs((was) => ({ ...was, [key]: leg })))
      .catch((e: unknown) => setLegs((was) => ({ ...was, [key]: e instanceof Error ? e.message : String(e) })));
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
    const built = buildApplicationPage(traced, app, addressesOf);
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
    const body = applicationReport(traced, app, buildApplicationPage(traced, app, addressesOf));
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
          <select className="cv-input" value={runId} onChange={(e) => { setRunId(e.target.value); setTraced(null); setOutcome(null); }}>
            {runs.length === 0 && <option value="">{t('trace.noRuns')}</option>}
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {t('trace.runOption', {
                  when: new Date(r.takenAt).toLocaleString(),
                  count: r.devices,
                  seed: r.seed,
                })}
              </option>
            ))}
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('trace.from')}</span>
          {/* LT-504: chosen from the run, not typed — the engine needs a
              crawled device, and a suggestion list filtered by what was
              typed hid every other name once one was in the box. */}
          <select className="cv-input cv-mono" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">{devices.length ? t('trace.chooseSource') : t('trace.noRuns')}</option>
            {devices.map((d) => <option key={d.hostname} value={d.hostname}>{d.hostname}</option>)}
          </select>
        </label>
        {collectionRun && (
          <label className="cv-field cv-field-narrow">
            <span>{t('cpath.fromAddress')}</span>
            <input className="cv-input cv-mono" value={fromAddress} spellCheck={false} placeholder="192.0.2.50"
              onChange={(e) => setFromAddress(e.target.value)} />
          </label>
        )}
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
        <button type="button" className="cv-btn cv-btn-start" disabled={(!from.trim() && !(collectionRun && fromAddress.trim())) || !to.trim()}
          onClick={() => { setDown(new Set()); setCandidates([]); trace(); }}>
          {t('trace.go')}
        </button>
        {/* LT-679: the same question, answered by measuring, or by the crawl's last sighting. */}
        <button type="button" className="cv-btn cv-btn-small" disabled={!to.trim()} title={t('trace.measureHint')}
          onClick={() => useStore.getState().requestPanelTab('tracert')}>
          {t('trace.measureLink')}
        </button>
        <button type="button" className="cv-btn cv-btn-small" disabled={!to.trim()} title={t('trace.whereIsHint')}
          onClick={() => useStore.getState().requestWhereIs(to.trim())}>
          {t('whereis.find')}
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
          : collectionRun
            ? t('cpath.fromCollection', { run: collectionRun, devices: devices.length })
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
                <th>{t('trace.colTable')}</th>
              </tr>
            </thead>
            <tbody>
              {path.map((hop, n) => (
                <tr key={`${hop.device}-${n}`}>
                  <td>{n + 1}</td>
                  <td>{hop.device}</td>
                  <td className="cv-mono">{hop.prefix}</td>
                  <td>{hop.protocol}</td>
                  <td className="cv-mono">
                    {hop.nextHop ?? '—'}
                    {hop.ecmp && (
                      <div className="cv-trace-leg">
                        <span className="cv-help">{t('trace.ecmpOf', { count: hop.ecmp })}</span>{' '}
                        <button type="button" className="cv-btn cv-btn-small" onClick={() => askLeg(`${i}-${n}`, hop.device)}>
                          {t('trace.askDevice', { device: hop.device })}
                        </button>
                        {legs[`${i}-${n}`] !== undefined && (
                          <div className="cv-help cv-trace-leg-answer">
                            {typeof legs[`${i}-${n}`] === 'string'
                              ? String(legs[`${i}-${n}`])
                              : t('trace.deviceChose', {
                                  device: hop.device,
                                  nextHop: (legs[`${i}-${n}`] as MeasuredLeg).nextHop,
                                  via: (legs[`${i}-${n}`] as MeasuredLeg).interface ? ` via ${(legs[`${i}-${n}`] as MeasuredLeg).interface}` : '',
                                  which: (legs[`${i}-${n}`] as MeasuredLeg).nextHop === hop.nextHop ? t('trace.thisLeg') : t('trace.otherLeg'),
                                })}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="cv-mono">{hop.outInterface ?? '—'}</td>
                  <td className="cv-mono">
                    {hop.distance ?? '—'}/{hop.metric ?? '—'}
                  </td>
                  {/* LT-679: which table answered — the forwarding table is what the device forwards by. */}
                  <td>{hop.table ? <span className={`cv-trace-table is-${hop.table}`} data-table={hop.table}>{t(`trace.table.${hop.table}`)}</span> : '—'}</td>
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
                  {hop.notes?.map((note, k) => <div key={k} className="cv-help cv-trace-note">{note}</div>)}
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
            {/* LT-479: what no calculated path evaluates, said every time. */}
            <p className="cv-help cv-trace-caveat">{collectionRun ? t('cpath.caveat') : t('trace.caveat')}</p>
          </details>
        </div>
      ))}

      {outcome && collectionRun && (
        <CollectedPathDetail outcome={outcome} runId={collectionRun} request={pathRequest([...down])} credentialId={credentialId} />
      )}

      {/* LT-477: the measured path, beside the calculated one. */}
      {traced && (
        <div className="cv-trace-measure" data-region="measure">
          <SavedCredentialSelect kind="ssh" label={t('trace.credential', { device: from })} value={credentialId} onChange={setCredentialId} />
          <button type="button" className="cv-btn cv-btn-small" disabled={measuring || !from.trim() || !to.trim()} onClick={measure}>
            {measuring ? t('trace.measuring') : t('trace.measure', { device: from })}
          </button>
          {measured && (() => {
            const onPath = new Set(devicesOnPath(traced).map((n) => n.trim().toLowerCase()));
            const rows = measured.hops.map((h) => {
              const device = h.address ? deviceHolding(h.address) : null;
              const verdict = !h.address ? 'silent' : !device ? 'unknown' : onPath.has(device.trim().toLowerCase()) ? 'on' : 'off';
              return { ...h, device, verdict };
            });
            const answering = rows.filter((r) => r.address).length;
            const agreeing = rows.filter((r) => r.verdict === 'on').length;
            const off = rows.filter((r) => r.verdict === 'off');
            return (
              <div data-region="measured">
                <p className="cv-help">{t('trace.measured', { platform: measured.platform, command: measured.command })}</p>
                <table className="cv-table">
                  <thead>
                    <tr>
                      <th>{t('trace.colTtl')}</th>
                      <th>{t('trace.colAddress')}</th>
                      <th>{t('trace.colDevice')}</th>
                      <th>{t('trace.colRtt')}</th>
                      <th>{t('trace.colCalculated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.ttl} data-verdict={r.verdict}>
                        <td>{r.ttl}</td>
                        <td className="cv-mono">{r.address ?? '*'}</td>
                        <td>{r.device ?? '—'}</td>
                        <td className="cv-mono">{r.rttsMs.map((v) => `${v} ms`).join(' ') || '—'}</td>
                        <td>
                          {r.verdict === 'on' && t('trace.onPath')}
                          {r.verdict === 'off' && <strong>{t('trace.offPath')}</strong>}
                          {r.verdict === 'unknown' && t('trace.unknownHop')}
                          {r.verdict === 'silent' && t('trace.silentHop')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className={`cv-help${off.length ? ' cv-problem' : ''}`}>
                  {t('trace.measuredSummary', { onPath: agreeing, answering })}
                  {off.length > 0 && ` ${t('trace.disagree', { hops: off.map((r) => `${r.ttl} (${r.device})`).join(', ') })}`}
                </p>
              </div>
            );
          })()}
        </div>
      )}

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
