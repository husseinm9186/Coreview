/**
 * The Collect tab (LT-514, LT-516, LT-517; D-060): a catalog-driven
 * collection from named devices. Before a run, the plan preview — what
 * each device was recognised as, which capability each probe set, every
 * command with the gate that let it in, its parser and the tables it
 * feeds, and every command not sent with the reason. During and after, the
 * command log with status, duration and rows, a kept reply where the
 * diagnostic was ticked, and the tables the run filled. Nothing here sends
 * a command; Rust plans and sends, and every command is read-only.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { t } from '../i18n';
import { ipc, type CollectionDevice, type CollectionEvent, type CollectionLogEntry, type CollectionRunDetail, type CollectionRunSummary, type ShadowLine, type TopologyBuilt } from '../lib/ipc';
import { useStore } from '../state/store';
import { CollectionRunDiff } from './CollectionRunDiff';
import { saveExport } from '../lib/exports';
import { topologyCsv, topologyJson, topologyMarkdown } from '../lib/topologyExport';
import { SavedCredentialSelect } from './CredentialPicker';

// LT-550: the hosts too — Linux and Proxmox (`hosts`), ESXi, Windows.
const PLATFORMS = ['cisco_ios', 'cisco_nxos', 'cisco_iosxr', 'arista_eos', 'juniper_junos', 'fortios', 'panos', 'aoscx', 'aoss', 'cisco_asa', 'cisco_wlc_aireos', 'hosts', 'esxi', 'windows'];
const ROLES = ['switch', 'router', 'firewall', 'wlc', 'host'];

function describe(e: CollectionEvent, hosts: Map<string, string>): string | null {
  const host = 'deviceId' in e ? (hosts.get(e.deviceId) ?? e.deviceId) : '';
  switch (e.kind) {
    case 'identified':
      return t('collect.identified', { host, os: e.os, probe: e.probe });
    case 'probe':
      return e.flags.length ? t('collect.probed', { host, cmd: e.cmd, flags: e.flags.join(', ') }) : t('collect.probedNothing', { host, cmd: e.cmd });
    case 'planned':
      return t('collect.planned', { host, steps: e.steps, skipped: e.skipped });
    case 'step':
      return t('collect.stepDone', { host, cmd: e.context ? `${e.cmd} [${e.context}]` : e.cmd, status: e.status, rows: e.rows, ms: e.durationMs });
    case 'deviceDone':
      return e.failure ? t('collect.deviceFailed', { host: e.host, failure: e.failure }) : t('collect.deviceDone', { host: e.host, commands: e.commands });
    case 'finished':
      return e.cancelled ? t('collect.cancelled', { devices: e.devices }) : t('collect.finished', { devices: e.devices, failed: e.failed });
    case 'failed':
      return t('collect.failed', { error: e.error });
    default:
      return null;
  }
}

export function CollectionPanel() {
  const meta = useStore((s) => s.meta);
  const [targets, setTargets] = useState('');
  const [port, setPort] = useState(22);
  const [osHint, setOsHint] = useState('');
  const [role, setRole] = useState('');
  const [credentialId, setCredentialId] = useState<string | undefined>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [enable, setEnable] = useState('');
  const [lightOnly, setLightOnly] = useState(false);
  const [keepDiagnostic, setKeepDiagnostic] = useState(false);
  // LT-518, LT-541: the REST side — a device's own API, or the FMC that manages an FTD.
  const [apiCredentialId, setApiCredentialId] = useState<string | undefined>();
  const [fmcHost, setFmcHost] = useState('');
  // LT-549: SNMP, only for a device whose SSH session could not be opened.
  const [snmpCredentialId, setSnmpCredentialId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [live, setLive] = useState<string[]>([]);
  const [hosts] = useState(() => new Map<string, string>());
  const [runs, setRuns] = useState<CollectionRunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CollectionRunDetail | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [raw, setRaw] = useState<{ cmd: string; text: string } | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [importFolder, setImportFolder] = useState('');
  const [shadow, setShadow] = useState(false);
  // LT-527: the topology built from the selected run, and the review toggles.
  const [topo, setTopo] = useState<TopologyBuilt | null>(null);
  const [building, setBuilding] = useState(false);
  const [collapseBundles, setCollapseBundles] = useState(true);
  const [collapseStacks, setCollapseStacks] = useState(true);
  const [placeholders, setPlaceholders] = useState(true);
  const [minConfidence, setMinConfidence] = useState(0);
  const [vlanFilter, setVlanFilter] = useState('');
  const [vrfFilter, setVrfFilter] = useState('');
  const [shadowLines, setShadowLines] = useState<ShadowLine[]>([]);

  const refreshRuns = useCallback(() => {
    if (!meta) return;
    void ipc.listCollectionRuns(meta.id).then(setRuns).catch(() => setRuns([]));
    void ipc.shadowReport(meta.id).then(setShadowLines).catch(() => setShadowLines([]));
  }, [meta]);

  // LT-521: the shadow flag is a project setting, so it is on for every run of the project until turned off.
  useEffect(() => {
    if (!meta) return;
    void ipc.getSettings().then((s) => setShadow(s.collectorShadow === 'true')).catch(() => setShadow(false));
  }, [meta]);

  const toggleShadow = (on: boolean) => {
    setShadow(on);
    void ipc.setSetting('collectorShadow', on ? 'true' : null).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    setTopo(null);
    void ipc.collectionRun(selected).then((d) => {
      setDetail(d);
      setDevice(d.devices[0]?.deviceId ?? null);
      setTable(null);
      setRows([]);
      setRaw(null);
    }).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  }, [selected]);

  useEffect(() => {
    // LT-622: the listener is removed even when it arrives after cleanup.
    let off: (() => void) | undefined;
    let gone = false;
    void ipc.onCollectionEvent((e) => {
      if (e.kind === 'device') hosts.set(e.deviceId, e.host);
      const line = describe(e, hosts);
      if (line) setLive((prev) => [...prev.slice(-199), line]);
      if (e.kind === 'finished' || e.kind === 'failed') {
        setBusy(false);
        refreshRuns();
        if (e.kind === 'finished') setSelected(e.runId);
      }
    }).then((f) => { if (gone) f(); else off = f; });
    return () => { gone = true; off?.(); };
  }, [hosts, refreshRuns]);

  const start = (planOnly: boolean) => {
    if (!meta) { setProblem(t('collect.needProject')); return; }
    if (!credentialId && !username.trim()) { setProblem(t('collect.needLogin')); return; }
    setProblem(null);
    setLive([]);
    setBusy(true);
    void ipc.startCollection(
      { projectId: meta.id, targets, port, osHint: osHint || undefined, roleOverride: role || undefined, planOnly, lightOnly, credentialId: credentialId || undefined, keepDiagnostic, apiCredentialId: apiCredentialId || undefined, fmcHost: fmcHost.trim() || undefined, snmpCredentialId: snmpCredentialId || undefined },
      credentialId ? undefined : { username, password, enablePassword: enable || undefined },
    ).catch((e: unknown) => { setBusy(false); setProblem(e instanceof Error ? e.message : String(e)); });
  };

  const doImport = () => {
    if (!meta) { setProblem(t('collect.needProject')); return; }
    setProblem(null);
    setBusy(true);
    void ipc.importCaptures(meta.id, importFolder.trim()).then((id) => { setBusy(false); refreshRuns(); setSelected(id); }).catch((e: unknown) => { setBusy(false); setProblem(e instanceof Error ? e.message : String(e)); });
  };

  const buildTopology = () => {
    if (!selected) return;
    setBuilding(true);
    setProblem(null);
    void ipc
      .collectionTopology(selected, { collapseBundles, collapseStacks, placeholders, minConfidence, vlan: vlanFilter.trim() || undefined, vrf: vrfFilter.trim() || undefined })
      .then(setTopo)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setBuilding(false));
  };

  /** LT-548: the built topology, written beside the project's other exports. */
  const exportTopology = (ext: 'json' | 'csv' | 'md') => {
    if (!topo || !selected) return;
    const body = ext === 'json' ? topologyJson(topo.graph) : ext === 'csv' ? topologyCsv(topo.graph) : topologyMarkdown(topo.graph, selected);
    const mime = ext === 'json' ? 'application/json' : ext === 'csv' ? 'text/csv' : 'text/markdown';
    void saveExport(`topology-${selected}.${ext}`, body, mime, useStore.getState().settings.exportFolder)
      .then(() => setProblem(null))
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  const reviewTopology = () => {
    if (!topo || !selected) return;
    useStore.getState().setPendingCrawlResult({ devices: topo.devices, notVisited: topo.notVisited, label: t('collect.handedOver', { run: selected, devices: t('plural.device', { count: topo.devices.length }) }) });
    useStore.getState().requestPanelTab('crawl');
  };

  const nameOf = (id: string) => topo?.graph.nodes.find((n) => n.id === id)?.name ?? id;

  const showTable = (name: string) => {
    if (!selected) return;
    setTable(name);
    void ipc.collectionTable(selected, name, device ?? undefined).then(setRows).catch(() => setRows([]));
  };

  const showRaw = (entry: CollectionLogEntry) => {
    if (!selected || !entry.rawRef) return;
    void ipc.collectionRaw(selected, entry.rawRef).then((text) => setRaw({ cmd: entry.cmd, text })).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  const current: CollectionDevice | undefined = useMemo(() => detail?.devices.find((d) => d.deviceId === device), [detail, device]);
  const log = useMemo(() => (detail?.log ?? []).filter((l) => !device || l.deviceId === device), [detail, device]);
  const columns = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) if (!k.startsWith('_')) seen.add(k);
    return [...seen];
  }, [rows]);

  return (
    <div className="cv-pathtrace cv-collect" data-region="collect">
      <p className="cv-help">{t('collect.help')}</p>
      <div className="cv-discover-form">
        <label className="cv-field">
          <span>{t('collect.targets')}</span>
          <textarea className="cv-input cv-mono" rows={3} value={targets} spellCheck={false} placeholder={'192.0.2.10\n192.0.2.11'} onChange={(e) => setTargets(e.target.value)} />
          <span className="cv-field-hint">{t('collect.targetsHint')}</span>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('collect.port')}</span>
          <input className="cv-input cv-mono" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('collect.osHint')}</span>
          <select className="cv-input" value={osHint} onChange={(e) => setOsHint(e.target.value)}>
            <option value="">{t('collect.osHintAny')}</option>
            {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('collect.role')}</span>
          <select className="cv-input" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">{t('collect.roleAuto')}</option>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <SavedCredentialSelect kind="ssh" label={t('collect.credential')} value={credentialId} onChange={setCredentialId} />
        {!credentialId && (
          <>
            <label className="cv-field cv-field-narrow">
              <span>{t('collect.username')}</span>
              <input className="cv-input cv-mono" value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="cv-field cv-field-narrow">
              <span>{t('collect.password')}</span>
              <input className="cv-input cv-mono" type="password" value={password} autoComplete="off" onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="cv-field cv-field-narrow">
              <span>{t('collect.enable')}</span>
              <input className="cv-input cv-mono" type="password" value={enable} autoComplete="off" onChange={(e) => setEnable(e.target.value)} />
            </label>
          </>
        )}
        <SavedCredentialSelect kind="api" label={t('collect.apiCredential')} value={apiCredentialId} onChange={setApiCredentialId} />
        <label className="cv-field cv-field-narrow">
          <span>{t('collect.fmcHost')}</span>
          <input className="cv-input cv-mono" value={fmcHost} spellCheck={false} placeholder="192.0.2.5" onChange={(e) => setFmcHost(e.target.value)} />
        </label>
        <SavedCredentialSelect kind="snmp" label={t('collect.snmpCredential')} value={snmpCredentialId} onChange={setSnmpCredentialId} />
        <label className="cv-check"><input type="checkbox" checked={lightOnly} onChange={(e) => setLightOnly(e.target.checked)} /> {t('collect.lightOnly')}</label>
        <label className="cv-check"><input type="checkbox" checked={keepDiagnostic} onChange={(e) => setKeepDiagnostic(e.target.checked)} /> {t('collect.keepDiagnostic')}</label>
        <label className="cv-check"><input type="checkbox" checked={shadow} onChange={(e) => toggleShadow(e.target.checked)} /> {t('collect.shadow')}</label>
        <button type="button" className="cv-btn" disabled={busy || !targets.trim()} onClick={() => start(true)}>{t('collect.preview')}</button>
        <button type="button" className="cv-btn cv-btn-start" disabled={busy || !targets.trim()} onClick={() => start(false)}>{busy ? t('collect.running') : t('collect.start')}</button>
        {busy && <button type="button" className="cv-btn" onClick={() => void ipc.cancelCollection()}>{t('collect.stop')}</button>}
      </div>
      <div className="cv-discover-form">
        <label className="cv-field">
          <span>{t('collect.importFolder')}</span>
          <input className="cv-input cv-mono" value={importFolder} spellCheck={false} onChange={(e) => setImportFolder(e.target.value)} />
          <span className="cv-field-hint">{t('collect.importHint')}</span>
        </label>
        <button type="button" className="cv-btn" disabled={busy || !importFolder.trim()} onClick={doImport}>{t('collect.import')}</button>
      </div>
      {problem && <p className="cv-problem">{problem}</p>}
      {live.length > 0 && (
        <section data-region="collect-live">
          <h3>{t('collect.live')}</h3>
          <ul className="cv-collect-live">{live.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </section>
      )}
      <section data-region="collect-runs">
        <h3>{t('collect.runs')}</h3>
        {runs.length === 0 ? <p className="cv-help">{t('collect.noRuns')}</p> : (
          <select className="cv-input" value={selected ?? ''} onChange={(e) => setSelected(e.target.value || null)} aria-label={t('collect.runs')}>
            <option value="">—</option>
            {runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.startedMs).toLocaleString()} · {r.source} · {r.status}{r.planOnly ? ' · plan' : ''} · {r.devices}</option>)}
          </select>
        )}
      </section>
      <section data-region="collect-shadow">
        <h3>{t('collect.shadowReport')}</h3>
        <p className="cv-help">{t('collect.shadowHelp')}</p>
        {shadowLines.length === 0 ? <p className="cv-help">{t('collect.shadowNone')}</p> : (
          <table className="cv-tr-table">
            <thead><tr><th>{t('collect.os')}</th><th>{t('collect.step')}</th><th>{t('collect.compared')}</th><th>{t('collect.mismatches')}</th><th>{t('collect.errors')}</th><th>{t('collect.firstDifference')}</th></tr></thead>
            <tbody>
              {shadowLines.map((l) => (
                <tr key={`${l.os}-${l.cmd}`} className={l.mismatches + l.errors > 0 ? 'is-warning' : ''}>
                  <td>{l.os}</td><td className="cv-mono">{l.cmd}</td><td>{l.compared}</td><td>{l.mismatches}</td><td>{l.errors}</td><td className="cv-mono">{l.lastDetail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {detail && (
        <>
          <section data-region="collect-devices">
            <h3>{t('collect.devices')}</h3>
            <table className="cv-tr-table">
              <thead><tr><th>{t('collect.device')}</th><th>{t('collect.os')}</th><th>{t('collect.role')}</th><th>{t('collect.caps')}</th><th>{t('collect.failure')}</th></tr></thead>
              <tbody>
                {detail.devices.map((d) => (
                  <tr key={d.deviceId} className={d.deviceId === device ? 'is-selected' : ''} onClick={() => { setDevice(d.deviceId); setTable(null); setRows([]); }}>
                    <td className="cv-mono">{d.host}</td>
                    <td>{d.os ?? '—'}</td>
                    <td>{d.role ?? '—'}</td>
                    <td>{d.caps.join(', ')}</td>
                    <td>{d.failure ?? t('collect.ok')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {current?.plan && (
            <section data-region="collect-plan">
              <h3>{t('collect.plan')} — {current.host}</h3>
              <p className="cv-help">{t('collect.planSteps', { count: current.plan.steps.length })}, {t('collect.planSkipped', { count: current.plan.skipped.length })}</p>
              <table className="cv-tr-table">
                <thead><tr><th>{t('collect.step')}</th><th>{t('collect.gate')}</th><th>{t('collect.parser')}</th><th>{t('collect.feeds')}</th><th>{t('collect.weight')}</th><th>{t('collect.verified')}</th></tr></thead>
                <tbody>
                  {current.plan.steps.map((s, i) => (
                    <tr key={`${s.id}-${i}`}>
                      <td className="cv-mono">{s.cmd}{s.context ? ` [${s.context[1]}]` : ''}</td>
                      <td className="cv-mono">{s.gate}</td>
                      <td className="cv-mono">{s.parser}</td>
                      <td>{s.feeds.join(', ')}</td>
                      <td>{s.weight}</td>
                      <td title={s.verified === 'unverified' ? t('collect.unverifiedNote') : undefined}>{s.verified}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {current.plan.skipped.length > 0 && (
                <details className="cv-crawl-table">
                  <summary>{t('collect.skipped')} ({current.plan.skipped.length})</summary>
                  <table className="cv-tr-table">
                    <thead><tr><th>{t('collect.step')}</th><th>{t('collect.reason')}</th></tr></thead>
                    <tbody>{current.plan.skipped.map((s, i) => <tr key={`${s.id}-${i}`}><td className="cv-mono">{s.cmd}</td><td>{s.reason}</td></tr>)}</tbody>
                  </table>
                </details>
              )}
            </section>
          )}
          {log.length > 0 && (
            <section data-region="collect-log">
              <h3>{t('collect.log')}</h3>
              <table className="cv-tr-table">
                <thead><tr><th>{t('collect.step')}</th><th>{t('collect.context')}</th><th>{t('collect.status')}</th><th>{t('collect.rows')}</th><th>{t('collect.duration')}</th><th>{t('collect.verified')}</th><th>{t('collect.shadowColumn')}</th><th>{t('collect.raw')}</th></tr></thead>
                <tbody>
                  {log.map((l) => (
                    <tr key={`${l.deviceId}-${l.seq}`} className={l.status === 'ok' ? '' : 'is-warning'}>
                      <td className="cv-mono">{l.cmd}</td>
                      <td>{l.contextName ?? '—'}</td>
                      <td>{l.status}{l.error ? ` — ${l.error}` : ''}</td>
                      <td>{l.rows}</td>
                      <td>{l.durationMs} ms</td>
                      <td>{l.verified ?? ''}</td>
                      <td title={l.shadowDetail ?? undefined} className={l.shadow === 'mismatch' || l.shadow === 'error' ? 'is-warning' : ''}>{l.shadow ?? (l.engine === 'rust' ? 'rust' : '')}</td>
                      <td>{l.rawRef ? <button type="button" className="cv-btn cv-btn-small" onClick={() => showRaw(l)}>{t('collect.showRaw')}</button> : t('collect.noRaw')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {raw && (
            <section data-region="collect-raw">
              <h3>{raw.cmd}</h3>
              <pre className="cv-mono cv-collect-raw">{raw.text}</pre>
            </section>
          )}
          {selected && <CollectionRunDiff runs={runs} selected={selected} />}
          <section data-region="collect-topology">
            <h3>{t('collect.topology')}</h3>
            <p className="cv-help">{t('collect.topologyHelp')}</p>
            <div className="cv-discover-form">
              <label className="cv-check"><input type="checkbox" checked={collapseBundles} onChange={(e) => setCollapseBundles(e.target.checked)} /> {t('collect.collapseBundles')}</label>
              <label className="cv-check"><input type="checkbox" checked={collapseStacks} onChange={(e) => setCollapseStacks(e.target.checked)} /> {t('collect.collapseStacks')}</label>
              <label className="cv-check"><input type="checkbox" checked={placeholders} onChange={(e) => setPlaceholders(e.target.checked)} /> {t('collect.placeholders')}</label>
              <label className="cv-field cv-field-narrow">
                <span>{t('collect.minConfidence')}</span>
                <select className="cv-input" value={String(minConfidence)} onChange={(e) => setMinConfidence(Number(e.target.value))}>
                  <option value="0">{t('collect.confidenceAll')}</option>
                  <option value="0.7">{t('collect.confidenceSeen')}</option>
                  <option value="1">{t('collect.confidenceBoth')}</option>
                </select>
              </label>
              <label className="cv-field cv-field-narrow"><span>{t('collect.vlan')}</span><input className="cv-input cv-mono" value={vlanFilter} onChange={(e) => setVlanFilter(e.target.value)} /></label>
              <label className="cv-field cv-field-narrow"><span>{t('collect.vrf')}</span><input className="cv-input cv-mono" value={vrfFilter} onChange={(e) => setVrfFilter(e.target.value)} /></label>
              <button type="button" className="cv-btn" disabled={building} onClick={buildTopology}>{building ? t('collect.building') : t('collect.build')}</button>
              {topo && <button type="button" className="cv-btn cv-btn-start" onClick={reviewTopology}>{t('collect.review')}</button>}
              {topo && selected && (
                <span data-region="collect-topology-export">
                  <button type="button" className="cv-btn cv-btn-small" onClick={() => exportTopology('json')}>{t('cpath.exportJson')}</button>
                  <button type="button" className="cv-btn cv-btn-small" onClick={() => exportTopology('csv')}>{t('cpath.exportCsv')}</button>
                  <button type="button" className="cv-btn cv-btn-small" onClick={() => exportTopology('md')}>{t('cpath.exportMarkdown')}</button>
                </span>
              )}
            </div>
            {topo && (
              <>
                <p className="cv-help" data-region="collect-topology-summary">
                  {t('collect.topologySummary', {
                    nodes: topo.graph.nodes.length,
                    links: topo.graph.links.length,
                    both: topo.graph.links.filter((l) => l.both_directions).length,
                    inferred: topo.graph.links.filter((l) => l.kind === 'inferred_mac').length,
                    l3: topo.graph.l3.length,
                    overlays: topo.graph.overlays.length,
                    endpoints: topo.graph.endpoints.length,
                  })}
                </p>
                {topo.graph.findings.length > 0 && (
                  <div data-region="collect-topology-findings">
                    <h4>{t('collect.findings')}</h4>
                    <ul>{topo.graph.findings.map((f, i) => <li key={i} className="is-warning">{f.note}</li>)}</ul>
                  </div>
                )}
                <h4>{t('collect.links')}</h4>
                <table className="cv-tr-table" data-region="collect-topology-links">
                  <thead><tr><th>{t('collect.linkFrom')}</th><th>{t('collect.linkTo')}</th><th>{t('collect.kind')}</th><th>{t('collect.confidence')}</th><th>{t('collect.evidence')}</th></tr></thead>
                  <tbody>
                    {topo.graph.links.map((l, i) => (
                      <tr key={i} className={`cv-confidence-${String(l.confidence).replace('.', '')}${l.kind === 'inferred_mac' ? ' is-inferred' : ''}`}>
                        <td>{nameOf(l.a.node)} <span className="cv-mono">{l.a.port ?? ''}</span></td>
                        <td>{nameOf(l.b.node)} <span className="cv-mono">{l.b.port ?? ''}</span>{l.bundle ? ` (${l.bundle.members.length})` : ''}</td>
                        <td>{l.kind}{l.both_directions ? ' ⇄' : ''}</td>
                        <td>{l.confidence.toFixed(1)}</td>
                        <td><details><summary>{l.evidence.length}</summary><ul>{l.evidence.map((e, j) => <li key={j} className="cv-mono">{e.note} — {e.command}</li>)}</ul></details></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {topo.graph.l3.length > 0 && (
                  <details className="cv-crawl-table">
                    <summary>{t('collect.l3')} ({topo.graph.l3.length})</summary>
                    <table className="cv-tr-table">
                      <tbody>{topo.graph.l3.map((a, i) => <tr key={i}><td>{nameOf(a.a)} {a.a_if ?? ''}</td><td>{nameOf(a.b)} {a.b_if ?? ''}</td><td className="cv-mono">{a.subnet}</td><td>{a.confirmed_by.join(', ') || '—'}</td><td>{a.confidence.toFixed(1)}</td></tr>)}</tbody>
                    </table>
                  </details>
                )}
                {topo.graph.overlays.length > 0 && (
                  <details className="cv-crawl-table">
                    <summary>{t('collect.overlays')} ({topo.graph.overlays.length})</summary>
                    <p className="cv-help">{t('collect.overlaysNote')}</p>
                    <table className="cv-tr-table">
                      <tbody>{topo.graph.overlays.map((o, i) => <tr key={i}><td>{nameOf(o.a)}</td><td>{o.b ? nameOf(o.b) : (o.remote_ip ?? '')}</td><td>{o.kind}</td><td className="cv-mono">{o.name ?? ''}</td></tr>)}</tbody>
                    </table>
                  </details>
                )}
              </>
            )}
          </section>
          <section data-region="collect-tables">
            <h3>{t('collect.tables')}</h3>
            <div className="cv-collect-tables">
              {detail.tables.filter(([, n]) => n > 0).map(([name, n]) => (
                <button key={name} type="button" className={`cv-btn cv-btn-small${table === name ? ' is-active' : ''}`} onClick={() => showTable(name)}>{name} · {t('collect.tableRows', { count: n })}</button>
              ))}
            </div>
            {table && rows.length > 0 && (
              <div className="cv-crawl-table">
                <table className="cv-tr-table" data-region="collect-table">
                  <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c} className="cv-mono">{String(r[c] ?? '')}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
