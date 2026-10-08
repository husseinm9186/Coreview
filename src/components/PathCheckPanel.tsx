/**
 * Path check: is one device reachable from another, on a protocol and
 * port — tested for real, and shown along the path the diagram draws between
 * them with each hop's live status, so a failure points somewhere.
 */
import { useMemo, useState } from 'react';

import { ipc } from '../lib/ipc';
import { newProbe } from '../lib/probes';
import { drawnPath, judgePath } from '../lib/pathCheck';
import { activePage } from '../lib/pages';
import { targetOf } from '../lib/probeTemplates';
import { useStore } from '../state/store';
import type { DeviceNodeData } from '../types/domain';
import { SavedCredentialSelect } from './CredentialPicker';
import { t } from '../i18n';

const THIS_MACHINE = '';

export function PathCheckPanel() {
  const page = useStore((s) => activePage(s.doc));
  const meta = useStore((s) => s.meta);
  const nodeStatus = useStore((s) => s.nodeStatus);
  const linkStatus = useStore((s) => s.linkStatus);
  useStore((s) => s.runtime);
  const devices = useMemo(
    () =>
      page.nodes
        .filter((n) => n.type === 'device' && targetOf(n.data as DeviceNodeData))
        .map((n) => ({ id: n.id, label: (n.data as DeviceNodeData).label, address: targetOf(n.data as DeviceNodeData) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [page.nodes],
  );
  const [from, setFrom] = useState(THIS_MACHINE);
  // The destination, protocol and port are the shared question's.
  // Here the destination is a drawn device, named by its address.
  const question = useStore((s) => s.pathQuestion);
  const setQuestion = useStore((s) => s.setPathQuestion);
  const to = devices.find((d) => d.address === question.to.trim())?.id ?? '';
  const setTo = (id: string) => setQuestion({ to: devices.find((d) => d.id === id)?.address ?? '' });
  const protocol: 'icmp' | 'tcp' | 'udp' = question.protocol === 'tcp' || question.protocol === 'udp' ? question.protocol : 'icmp';
  const setProtocol = (v: 'icmp' | 'tcp' | 'udp') => setQuestion({ protocol: v });
  const port = Number(question.port) || 443;
  const setPort = (n: number) => setQuestion({ port: String(n) });
  const [credentialId, setCredentialId] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const source = devices.find((d) => d.id === from);
  const target = devices.find((d) => d.id === to);
  const path = source && target ? drawnPath(page.nodes, page.edges, source.id, target.id) : null;
  const verdict = path ? judgePath(path, nodeStatus, linkStatus) : null;
  const labelOf = (id: string) => (page.nodes.find((n) => n.id === id)?.data as DeviceNodeData | undefined)?.label ?? id;

  const run = async () => {
    if (!target || !meta) return;
    setRunning(true);
    setResult(null);
    try {
      if (source) {
        if (!credentialId) throw new Error(`Choose a saved SSH credential to log into ${source.label} with.`);
        const r = await ipc.pingFromDevice(source.address, credentialId, target.address);
        setResult({
          ok: r.received > 0,
          text: `${source.label} pinged ${target.label} (${target.address}): ${r.received} of ${r.sent} replies${r.avgMs !== null ? `, ${r.avgMs} ms average` : ''}.`,
        });
      } else {
        const probe = { ...newProbe('node', target.id, meta.id, target.address, 'Path check'), kind: protocol, tcpPort: protocol === 'icmp' ? null : port };
        const r = await ipc.testProbeNow(probe);
        setResult({ ok: r.outcome === 'success', text: `From this machine to ${target.label} (${target.address}${protocol === 'icmp' ? '' : ` ${protocol.toUpperCase()} ${port}`}): ${r.summary}` });
      }
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="cv-path-check">
      <div className="cv-discover-form">
        <label className="cv-field cv-field-narrow">
          <span>{t('pathCheckPanel.from')}</span>
          <select className="cv-input" value={from} onChange={(e) => { setFrom(e.target.value); setResult(null); }}>
            <option value={THIS_MACHINE}>{t('pathCheckPanel.thisMachine')}</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.label} ({d.address})</option>)}
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>To</span>
          <select className="cv-input" value={to} onChange={(e) => { setTo(e.target.value); setResult(null); }}>
            <option value="">{t('pathCheckPanel.chooseADevice')}</option>
            {devices.filter((d) => d.id !== from).map((d) => <option key={d.id} value={d.id}>{d.label} ({d.address})</option>)}
          </select>
        </label>
        {source ? (
          <label className="cv-field cv-field-narrow">
            <span>{t('pathCheckPanel.logInWith')}</span>
            <SavedCredentialSelect kind="ssh" triesAll label="Saved SSH credential for the source device" value={credentialId} onChange={setCredentialId} />
          </label>
        ) : (
          <>
            <label className="cv-field cv-field-narrow">
              <span>{t('pathCheckPanel.protocol')}</span>
              <select className="cv-input" value={protocol} onChange={(e) => setProtocol(e.target.value as typeof protocol)}>
                <option value="icmp">{t('pathCheckPanel.icmpPing')}</option>
                <option value="tcp">{t('pathCheckPanel.tcpPort')}</option>
                <option value="udp">{t('pathCheckPanel.udpPort')}</option>
              </select>
            </label>
            {protocol !== 'icmp' && (
              <label className="cv-field cv-field-narrow">
                <span>{t('pathCheckPanel.port')}</span>
                <input className="cv-input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value) || 1)} />
              </label>
            )}
          </>
        )}
        <button type="button" className="cv-btn cv-btn-small cv-btn-start" disabled={!target || running} onClick={() => void run()}>
          {running ? 'Checking…' : 'Check'}
        </button>
      </div>
      {source && <p className="cv-help">{t('pathCheckPanel.fromADeviceThe')}</p>}

      {source && target && (
        <div className="cv-path-drawn" aria-label={t('pathCheckPanel.theDrawnPath')}>
          {!path ? (
            <p className="cv-help">Nothing on the diagram links {source.label} to {target.label}.</p>
          ) : (
            <>
              <ol className="cv-path-hops">
                {path.nodeIds.map((id, i) => (
                  <li key={id}>
                    <span className={`cv-path-hop is-${nodeStatus(id)}`}>{labelOf(id)}</span>
                    {path.edgeIds[i] && <span className={`cv-path-link is-${linkStatus(path.edgeIds[i]!)}`} aria-label={`link ${linkStatus(path.edgeIds[i]!)}`}>→</span>}
                  </li>
                ))}
              </ol>
              <p className="cv-help">
                {verdict?.firstDown
                  ? `Down on the drawing at ${verdict.firstDown.kind === 'device' ? labelOf(verdict.firstDown.id) : 'the link after ' + labelOf(path.nodeIds[path.edgeIds.indexOf(verdict.firstDown.id)]!)}.`
                  : `${t('plural.link', { count: path.edgeIds.length })} on the drawing, none down${verdict?.unchecked ? `; ${verdict.unchecked} device${verdict.unchecked === 1 ? ' is' : 's are'} not being checked` : ''}.`}
              </p>
            </>
          )}
        </div>
      )}
      {result && <p className={`cv-path-result ${result.ok ? 'is-ok' : 'is-bad'}`} role="status">{result.ok ? 'Reachable. ' : 'Not reachable. '}{result.text}</p>}
    </div>
  );
}
