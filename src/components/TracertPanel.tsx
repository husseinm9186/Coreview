/**
 * Tracert (LT-505): a measured path, hop by hop, from this machine or from a
 * device — and a page drawn from it, the way Path-Trace draws a calculated
 * one.
 *
 * Path-Trace answers "where would it go" from routing tables already
 * collected and sends nothing. This answers "where did it go": a traceroute
 * run now, from this machine (LT-090) or by the device itself over SSH with a
 * saved login (LT-477). Each answering hop is named by the crawled device
 * that holds its address, where one does; what changed since the last run
 * to the same target is marked (LT-093). Nothing here is inferred: a hop
 * that did not answer is drawn as one that did not answer.
 */
import { useEffect, useMemo, useState } from 'react';

import { t } from '../i18n';
import { applicationPageName, buildApplicationPage, type Application } from '../lib/appPath';
import { ipc, type CrawlResult, type TracerouteHopDto } from '../lib/ipc';
import type { Hop, TraceResult } from '../lib/pathTrace';
import { changedHops } from '../lib/tracerouteDiff';
import { useStore } from '../state/store';
import { SavedCredentialSelect } from './CredentialPicker';
import { TraceHopRow } from './TraceroutePanel';

/** The last run per source and target, this session only (LT-093). */
const lastRun = new Map<string, TracerouteHopDto[]>();

/** A device's own traceroute in the shape this machine's is reported in. */
export function hopsFromDevice(hops: { ttl: number; address: string | null; rttsMs: number[] }[]): TracerouteHopDto[] {
  return hops.map((h) => ({
    hop: h.ttl,
    probes: h.address ? h.rttsMs.map((rttMs) => ({ host: h.address, rttMs })) : [{ host: null, rttMs: null }],
  }));
}

/**
 * The measured hops as a path the page builder draws: one step per hop,
 * named by the crawled device that answered where one is known, silent hops
 * kept as silent. Delivered when the last hop answered from the target;
 * otherwise the trace stopped, and the page says where.
 */
export function measuredPath(
  hops: readonly TracerouteHopDto[],
  target: string,
  nameOf: (address: string) => string | null,
): TraceResult {
  const path: Hop[] = hops.map((h, i) => {
    const answered = h.probes.map((p) => p.host).find((host): host is string => !!host) ?? null;
    const rtts = h.probes.filter((p) => p.rttMs !== null).map((p) => p.rttMs as number);
    const next = hops.slice(i + 1).flatMap((n) => n.probes.map((p) => p.host)).find((host): host is string => !!host) ?? null;
    const name = answered ? nameOf(answered) : null;
    return {
      device: answered ? (name ?? answered) : `* (hop ${h.hop})`,
      prefix: answered ?? '*',
      protocol: 'measured',
      nextHop: next,
      outInterface: null,
      distance: null,
      metric: null,
      why: answered
        ? `Hop ${h.hop} answered from ${answered}${name ? ` (${name})` : ''}${rtts.length ? ` in ${rtts.map((r) => `${r} ms`).join(', ')}` : ''}.`
        : `Hop ${h.hop} did not answer.`,
      via: [],
    };
  });
  const last = [...hops].reverse().flatMap((h) => h.probes.map((p) => p.host)).find((host): host is string => !!host) ?? null;
  if (last && last.trim() === target.trim()) return { kind: 'delivered', paths: [path] };
  const at = path.length ? path[path.length - 1]!.device : 'the source';
  return { kind: 'unreachable', paths: [path], at, reason: `The trace stopped at ${at} without reaching ${target}.` };
}

export function TracertPanel() {
  const meta = useStore((s) => s.meta);
  const setHighlight = useStore((s) => s.setCanvasHighlight);
  const [target, setTarget] = useState('');
  const [source, setSource] = useState('machine');
  const [credentialId, setCredentialId] = useState<string | undefined>();
  const [result, setResult] = useState<CrawlResult | null>(null);
  const [hops, setHops] = useState<TracerouteHopDto[] | null>(null);
  const [complete, setComplete] = useState(true);
  const [changed, setChanged] = useState<Set<number>>(new Set());
  const [hadPrevious, setHadPrevious] = useState(false);
  const [ran, setRan] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // LT-577: seconds since the trace began, and whether a device is tracing.
  const [elapsed, setElapsed] = useState(0);
  const [fromDevice, setFromDevice] = useState(false);

  useEffect(() => {
    if (!busy) return;
    const began = Date.now();
    setElapsed(0);
    const tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - began) / 1000)), 1000);
    return () => window.clearInterval(tick);
  }, [busy]);

  // LT-577: a device's hops as it prints them.
  useEffect(() => {
    if (!busy || !fromDevice) return;
    // LT-622: `listen` resolves after a dynamic import; a cleanup that runs
    // first must still remove the listener when it arrives.
    let off: (() => void) | undefined;
    let gone = false;
    void ipc.onTracertProgress((e) => {
      setHops(hopsFromDevice(e.hops));
      setComplete(true);
    }).then((f) => { if (gone) f(); else off = f; });
    return () => { gone = true; off?.(); };
  }, [busy, fromDevice]);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // The newest crawl run names the hops and offers the devices to run from.
  useEffect(() => {
    if (!meta) return;
    void ipc
      .listCrawlRuns(meta.id)
      .then((runs) => (runs[0] ? ipc.crawlRunResult(runs[0].id) : null))
      .then((r) => setResult(r))
      .catch(() => setResult(null));
  }, [meta]);

  const devices = useMemo(() => (result?.devices ?? []).filter((d) => d.address || d.addresses?.length), [result]);
  const nameOf = (address: string): string | null =>
    devices.find((d) => d.address === address || (d.addresses ?? []).some((a) => a.ip === address))?.hostname ?? null;
  const addressOf = (hostname: string): string | null => {
    const d = devices.find((x) => x.hostname === hostname);
    return d?.address ?? d?.addresses?.[0]?.ip ?? null;
  };
  const addressesOf = (hostname: string) => {
    const d = devices.find((x) => x.hostname === hostname);
    if (!d) return [];
    const reached = d.probeTarget || d.address;
    return [
      ...(reached ? [{ ip: reached, interface: null, isManagement: true }] : []),
      ...(d.addresses ?? []).map((a) => ({ ip: a.ip, interface: a.interface, isManagement: a.isManagement || a.ip === reached })),
    ];
  };

  const run = () => {
    const to = target.trim();
    if (!to) return;
    setProblem(null);
    setNote(null);
    setFromDevice(source !== 'machine');
    if (source !== 'machine') setHops(null);
    setBusy(true);
    const key = `${source}|${to}`;
    const finish = (got: TracerouteHopDto[], done: boolean, what: string) => {
      const previous = lastRun.get(key) ?? null;
      setHadPrevious(previous !== null);
      setChanged(changedHops(previous, got));
      lastRun.set(key, got);
      setHops(got);
      setComplete(done);
      setRan(what);
    };
    const work =
      source === 'machine'
        ? ipc.traceroute(to).then((r) => finish(r.hops, r.complete, t('tracert.ranHere')))
        : (() => {
            const address = addressOf(source);
            if (!credentialId) return Promise.reject(new Error(t('trace.needCredential', { device: source })));
            if (!address) return Promise.reject(new Error(t('trace.noSourceAddress', { device: source })));
            return ipc.tracerouteFromDevice(address, credentialId, to).then((r) => finish(hopsFromDevice(r.hops), r.complete, t('trace.measured', { platform: r.platform, command: r.command })));
          })();
    void work
      .catch((e: unknown) => {
        setProblem(e instanceof Error ? e.message : String(e));
        // LT-623: hops a device had printed before it failed stay, marked cut
        // short; the previous run's summary does not describe them.
        if (source !== 'machine') {
          setComplete(false);
          setRan(null);
          setHadPrevious(false);
          setChanged(new Set());
        }
      })
      .finally(() => setBusy(false));
  };

  const application = (): Application => ({
    name: `Tracert ${target.trim()}`,
    source: source === 'machine' ? t('tracert.thisMachine') : source,
    destination: target.trim(),
    protocol: 'icmp',
  });

  const createPage = () => {
    if (!hops) return;
    const app = application();
    const built = buildApplicationPage(measuredPath(hops, app.destination, nameOf), app, addressesOf);
    if (built.nodes.length === 0) {
      setProblem(t('trace.nothingToDraw'));
      return;
    }
    useStore.getState().addGeneratedPage(applicationPageName(app), { nodes: built.nodes, edges: built.edges });
    setHighlight(null);
    useStore.getState().requestFit();
    setNote(t('trace.pageMade', { name: applicationPageName(app) }));
  };

  return (
    <div className="cv-pathtrace cv-tracert" data-region="tracert">
      <p className="cv-help">{t('tracert.help')}</p>
      <div className="cv-discover-form">
        <label className="cv-field cv-field-narrow">
          <span>{t('tracert.from')}</span>
          <select className="cv-input cv-mono" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="machine">{t('tracert.thisMachine')}</option>
            {devices.map((d) => <option key={d.hostname} value={d.hostname}>{d.hostname}</option>)}
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('tracert.to')}</span>
          <input className="cv-input cv-mono" value={target} spellCheck={false} placeholder="10.40.50.9"
            onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run(); }} />
        </label>
        {source !== 'machine' && (
          <SavedCredentialSelect kind="ssh" label={t('trace.credential', { device: source })} value={credentialId} onChange={setCredentialId} />
        )}
        <button type="button" className="cv-btn cv-btn-start" disabled={busy || !target.trim()} onClick={run}>
          {busy ? t('tracert.runningFor', { seconds: elapsed }) : t('tracert.run')}
        </button>
        {hops && (
          <button type="button" className="cv-btn" onClick={createPage}>{t('trace.makePage')}</button>
        )}
      </div>
      {problem && <p className="cv-problem">{problem}</p>}
      {!problem && note && <p className="cv-help cv-trace-made">{note}</p>}
      {busy && fromDevice && <p className="cv-help" data-region="tracert-live">{t('tracert.deviceSlow')}</p>}
      {hops && (
        <>
          {!busy && <p className="cv-help">
            {ran}
            {' '}
            {!hadPrevious
              ? t('tracert.first')
              : changed.size > 0
                ? t('tracert.changed', { count: changed.size })
                : t('tracert.same')}
          </p>}
          {!complete && <p className="cv-field-hint is-warning">{t('tracert.cutShort')}</p>}
          {hops.length === 0 && <p className="cv-help">{t('traceroutePanel.noHopsCameBack')}</p>}
          {hops.length > 0 && (
            <table className="cv-tr-table" data-region="tracert-hops">
              <thead>
                <tr>
                  <th>{t('traceroutePanel.hop')}</th>
                  <th>{t('traceroutePanel.router')}</th>
                  <th>{t('traceroutePanel.rtt')}</th>
                  <th>{t('tracert.device')}</th>
                </tr>
              </thead>
              <tbody>
                {hops.map((hop) => (
                  <TraceHopRow key={hop.hop} hop={hop} changed={changed.has(hop.hop)}
                    device={hop.probes.map((p) => p.host).find((h): h is string => !!h) ? (nameOf(hop.probes.map((p) => p.host).find((h): h is string => !!h)!) ?? '—') : '—'} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
