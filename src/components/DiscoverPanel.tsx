import { useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '../state/store';
import { ipc, isDesktop, type CredentialSummary, type SweepEvent, type SweepHit } from '../lib/ipc';
import { makeDeviceNode } from './Canvas';
import { SubnetList } from './SubnetList';
import type { DeviceNodeData } from '../types/domain';
import { uid } from '../lib/id';
import { newProbe } from '../lib/probes';
import { activePage, allNodes } from '../lib/pages';
import { findDrawnNode } from '../lib/topology';
import { gatewayGuess, knownOnDiagram, sweepPatch } from '../lib/sweepKnown';

/** `macFromGateway`: the MAC was read from the gateway's ARP table (LT-124),
 *  not from this machine's. */
type Hit = SweepHit & { picked: boolean; macFromGateway?: string };

/** Where a name came from, in words, for the column's tooltip. A `.local`
 *  name from mDNS and a PTR record from the network's own DNS are not the
 *  same claim, and an operator chasing a wrong name needs to know which. */
function nameSourceLabel(source: SweepHit['nameSource']): string {
  if (source === 'dns') return 'From a reverse DNS (PTR) record';
  if (source === 'llmnr') return 'The host answered over LLMNR';
  if (source === 'netBios') return 'The host answered over NetBIOS';
  if (source === 'mdns') return 'The host answered over mDNS';
  if (source === 'certificate') return 'Read from the certificate on its web interface';
  return 'Named, but the source was not recorded';
}

/**
 * Find what is actually on a subnet, then choose what to draw.
 *
 * Results stream in as hosts answer rather than arriving as one list at the
 * end: a /24 takes the better part of a minute, and a blank panel for that long
 * reads as a hang. Nothing reaches the canvas until the user picks it — a sweep
 * of a busy subnet finds printers and laptops nobody wants on a diagram.
 */
export function DiscoverPanel() {
  const store = useStore();
  const [subnets, setSubnets] = useState<string[]>(['192.168.1.0/24']);
  const [timeoutMs, setTimeoutMs] = useState(1000);
  const [concurrency, setConcurrency] = useState(64);
  // On by default: a sweep that reports an address and nothing else is the
  // thing LT-121 was raised about. Off is for a network where a port scan
  // would be noticed, which is a real situation and the operator's call.
  const [identify, setIdentify] = useState(true);
  const [scanPorts, setScanPorts] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  // LT-124: the optional gateway ARP read. Off until a saved SNMP credential
  // is picked and the button pressed; the sweep itself takes no credentials.
  const [snmpCreds, setSnmpCreds] = useState<CredentialSummary[]>([]);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [gatewayCred, setGatewayCred] = useState('');
  const [gatewayTyped, setGatewayTyped] = useState<string | null>(null);
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const [gatewayNote, setGatewayNote] = useState<string | null>(null);
  // Results arrive on an event, so the handler needs the latest setter without
  // being torn down and rebuilt on every hit.
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    let un: (() => void) | undefined;
    void ipc
      .onSweepEvent((e: SweepEvent) => {
        if (e.kind === 'started') {
          setProgress({ done: 0, total: e.total });
        } else if (e.kind === 'alive') {
          // The backend can repeat nothing, but a restarted sweep can, and a
          // duplicate row is worse than a missed one.
          if (seen.current.has(e.ip)) return;
          seen.current.add(e.ip);
          setHits((prev) => [
            ...prev,
            {
              ip: e.ip,
              rttMs: e.rttMs,
              hostname: e.hostname ?? null,
              nameSource: e.nameSource ?? null,
              mac: e.mac ?? null,
              vendor: e.vendor ?? null,
              ports: e.ports ?? [],
              serial: e.serial ?? null,
              product: e.product ?? null,
              webServer: e.webServer ?? null,
              webTitle: e.webTitle ?? null,
              picked: true,
            },
          ]);
        } else if (e.kind === 'progress') {
          setProgress({ done: e.done, total: e.total });
        } else if (e.kind === 'finished') {
          setRunning(false);
          setSummary(
            e.cancelled
              ? `Stopped after ${e.scanned} addresses — ${e.alive} answered`
              : `${e.alive} of ${e.scanned} addresses answered`,
          );
        }
      })
      .then((f) => {
        un = f;
      });
    return () => un?.();
  }, []);

  const start = async () => {
    setHits([]);
    setSummary(null);
    seen.current = new Set();
    setRunning(true);
    try {
      await ipc.startSweep(subnets, { timeoutMs, concurrency, identify, scanPorts });
    } catch (err) {
      setRunning(false);
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = () => void ipc.cancelSweep();

  /** LT-248: a scan somebody already ran, read into the same rows. */
  const openNmap = async (file: File) => {
    setProblem(null);
    try {
      const r = await ipc.readNmapXml(await file.text());
      seen.current = new Set(r.hosts.map((h) => h.ip));
      setHits(r.hosts.map((h) => ({ ...h, picked: true })));
      setSummary(`${r.hosts.length} host${r.hosts.length === 1 ? '' : 's'} up in ${file.name}${r.scanned ? ` (of ${r.scanned} scanned)` : ''}`);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const picked = useMemo(() => hits.filter((h) => h.picked), [hits]);

  useEffect(() => {
    void ipc.vaultStatus().then((v) => setVaultOpen(v.unlocked)).catch(() => setVaultOpen(false));
    void ipc
      .listCredentials()
      .then((all) => setSnmpCreds(all.filter((c) => c.kind === 'snmp')))
      .catch(() => setSnmpCreds([]));
  }, []);

  const gateway = gatewayTyped ?? gatewayGuess(subnets[0] ?? '');

  /** Reads the gateway's ARP table and gives MACs to hosts this machine's
   *  own table could not — anything behind a router. A MAC the sweep already
   *  had is never replaced. */
  const readGatewayArp = () => {
    setGatewayBusy(true);
    setGatewayNote(null);
    setProblem(null);
    void ipc
      .readGatewayArp(gateway, gatewayCred)
      .then((entries) => {
        const byIp = new Map(entries.map((e) => [e.ip, e]));
        const filled = hits.filter((h) => !h.mac && byIp.has(h.ip)).length;
        setHits((prev) =>
          prev.map((h) => {
            const e = byIp.get(h.ip);
            if (!e || h.mac) return h;
            return { ...h, mac: e.mac, vendor: h.vendor ?? e.vendor, macFromGateway: gateway };
          }),
        );
        setGatewayNote(
          `Read ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} from ${gateway}'s ARP table; ` +
            `filled ${filled} MAC ${filled === 1 ? 'address' : 'addresses'} this machine could not see.`,
        );
      })
      .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)))
      .finally(() => setGatewayBusy(false));
  };

  // LT-125: what the diagram — and so any crawl that drew it — already knows
  // about each host. Every page, because a crawl may have drawn a site on a
  // page other than the one being looked at.
  const known = useMemo(() => {
    const nodes = allNodes(store.doc);
    return new Map(hits.map((h) => [h.ip, knownOnDiagram(nodes, h)] as const));
  }, [hits, store.doc]);

  /** Drops the ticked addresses onto the canvas as generic devices, laid out
   *  in a grid clear of whatever is already there. */
  const addPicked = () => {
    if (!picked.length) return;
    const existing = activePage(store.doc).nodes;
    const bottom = existing.reduce((m, n) => Math.max(m, n.position.y + 120), 0);
    // Placed below whatever is already drawn, so a sweep never lands on top
    // of an existing diagram.
    const origin = { x: 80, y: bottom + 80 };

    // LT-141: the sweep used to add every ticked row without looking at the
    // page, so sweeping twice — or sweeping after a crawl — drew the whole
    // network again in a fresh block beside itself. It now asks the same
    // question the crawl asks: is this already here?
    let updated = 0;
    let placed = 0;
    picked.forEach((h, i) => {
      const already = findDrawnNode(existing, { mac: h.mac, address: h.ip, name: h.hostname });
      if (already) {
        // Keep the node, and with it wherever it was dragged to. The label is
        // left alone because a name someone corrected by hand should survive
        // a re-scan. LT-155: and what a crawl recorded survives too — the
        // sweep adds the ports it proved and fills gaps, but no longer writes
        // "Ping sweep" over "SSH login" or its own weaker name over the one
        // the device gave.
        const current = existing.find((n) => n.id === already)?.data as Partial<DeviceNodeData> | undefined;
        store.updateNodeData(already, sweepPatch(current ?? {}, h) as DeviceNodeData);
        updated += 1;
        return;
      }
      const node = makeDeviceNode('generic', origin.x + (placed % 6) * 220, origin.y + Math.floor(placed / 6) * 130);
      placed += 1;
      void i;
      const data = node.data as DeviceNodeData;
      // The name where reverse DNS knew one (LT-109), the address where it did
      // not. Twenty devices all labelled `10.10.10.24` is exactly the naming
      // work the sweep was supposed to have saved. The address is kept either
      // way, because that is what the probe checks.
      data.label = h.hostname ?? h.ip;
      if (h.hostname) data.hostname = h.hostname;
      // The manufacturer is already a field on a device, and the sweep now
      // knows it (LT-121) — so a discovered box arrives saying who made it
      // instead of waiting to be told.
      if (h.vendor) data.vendor = h.vendor;
      // LT-126: the MAC is what lets a later crawl recognise this host as the
      // thing a switch reports on a port, instead of drawing it a second time
      // and leaving this box floating. Without it the two halves of discovery
      // have nothing in common to match on.
      if (h.mac) data.mac = h.mac;
      // LT-124: the serial its certificate carries — the one field an RMA is
      // raised against, now known without a login.
      if (h.serial) data.serial = h.serial;
      // LT-146: everything the sweep proved, on the device rather than only
      // in the results table — the ports it answers on, and who said so.
      if (h.ports.length) data.openPorts = h.ports.map((p) => `${p.port}/${p.service}`).join(', ');
      data.discoveredVia = 'Ping sweep';
      data.addresses = [{ id: uid(), label: 'Discovered', address: h.ip, isPrimary: true }];
      store.addNode(node);
      // The sweep just proved this address answers ICMP. Drawing it as an
      // object nothing ever checks would throw that away and leave the
      // operator adding twenty probes by hand.
      if (store.meta) store.upsertProbe(newProbe('node', node.id, store.meta.id, h.ip, 'Discovered'));
    });
    // Says what actually happened. "Added 20" when twelve were already drawn
    // is how the duplication went unnoticed for as long as it did.
    const parts = [];
    if (placed) parts.push(`Added ${placed} ${placed === 1 ? 'device' : 'devices'}`);
    if (updated) parts.push(`updated ${updated} already on the diagram`);
    store.setStatusMessage(parts.length ? parts.join(', ') : 'Everything picked was already drawn');
    setHits((prev) => prev.map((h) => ({ ...h, picked: false })));
  };

  const toggle = (ip: string) =>
    setHits((prev) => prev.map((h) => (h.ip === ip ? { ...h, picked: !h.picked } : h)));
  const setAll = (picked: boolean) => setHits((prev) => prev.map((h) => ({ ...h, picked })));

  if (!isDesktop) {
    return (
      <p className="cv-help cv-discover-empty">
        Discovery needs the desktop app — a browser cannot send ICMP. Run Coreview itself to sweep
        a subnet.
      </p>
    );
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="cv-discover">
      <SubnetList label="Subnets" subnets={subnets} onChange={setSubnets}
        disabled={running} showCounts />

      <div className="cv-discover-form">
        <label className="cv-field cv-field-narrow">
          <span>Timeout</span>
          <select
            className="cv-input"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
            disabled={running}
          >
            <option value={500}>0.5 s</option>
            <option value={1000}>1 s</option>
            <option value={2000}>2 s</option>
            <option value={4000}>4 s</option>
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>At once</span>
          <select
            className="cv-input"
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            disabled={running}
          >
            <option value={16}>16</option>
            <option value={64}>64</option>
            <option value={128}>128</option>
            <option value={256}>256</option>
          </select>
        </label>
        <label className="cv-check" title="Ask each host that answers for its name over NetBIOS and mDNS, and read its MAC from this machine's ARP table">
          <input
            type="checkbox"
            checked={identify}
            onChange={(e) => setIdentify(e.target.checked)}
            disabled={running}
          />
          <span>Identify</span>
        </label>
        <label className="cv-check" title="Try the common TCP ports on each host that answers. The noisiest thing a sweep does.">
          <input
            type="checkbox"
            checked={scanPorts}
            onChange={(e) => setScanPorts(e.target.checked)}
            disabled={running || !identify}
          />
          <span>Ports</span>
        </label>
        {running ? (
          <button type="button" className="cv-btn cv-btn-stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" className="cv-btn cv-btn-start" onClick={() => void start()}
            disabled={!subnets.length}>
            Sweep
          </button>
        )}
        {!running && (
          <label className="cv-btn" title="A scan saved with nmap -oX, from this machine or any other">
            Open Nmap XML…
            <input type="file" accept=".xml,text/xml,application/xml" hidden aria-label="Open an Nmap XML report"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void openNmap(file);
              }} />
          </label>
        )}

        {hits.length > 0 && (
          <span className="cv-discover-actions">
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setAll(true)}>
              Select all
            </button>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setAll(false)}>
              Select none
            </button>
            <button
              type="button"
              className="cv-btn cv-btn-small cv-btn-start"
              onClick={addPicked}
              disabled={!picked.length}
            >
              Add {picked.length} to diagram
            </button>
          </span>
        )}
      </div>

      <p className="cv-discover-status">
        {problem ? (
          <span className="cv-discover-problem">{problem}</span>
        ) : running && progress ? (
          <>
            Scanning {progress.done} of {progress.total} · {pct}% · {hits.length} found
          </>
        ) : summary ? (
          summary
        ) : subnets.length ? (
          'Only addresses that answer ICMP appear — a device with ping disabled stays invisible.'
        ) : (
          'Enter a subnet in CIDR notation.'
        )}
      </p>

      {running && (
        <div className="cv-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="cv-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}

      {hits.length > 0 && !running && (
        <div className="cv-gateway-arp">
          <h4 className="cv-backup-head">MAC addresses behind a router</h4>
          {!vaultOpen || snmpCreds.length === 0 ? (
            <p className="cv-help">
              This machine only knows MAC addresses on its own segment. To fill them in for routed
              hosts, save an SNMP credential in the vault and unlock it; the gateway's ARP table
              can then be read here.
            </p>
          ) : (
            <div className="cv-discover-form">
              <label className="cv-field cv-field-narrow">
                <span>SNMP credential</span>
                <select className="cv-input" value={gatewayCred} disabled={gatewayBusy}
                  onChange={(e) => setGatewayCred(e.target.value)}>
                  <option value="">Choose one</option>
                  {snmpCreds.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </label>
              <label className="cv-field cv-field-narrow">
                <span>Gateway</span>
                <input className="cv-input cv-mono" value={gateway} disabled={gatewayBusy}
                  onChange={(e) => setGatewayTyped(e.target.value)} />
              </label>
              <button type="button" className="cv-btn cv-btn-small" onClick={readGatewayArp}
                disabled={gatewayBusy || !gatewayCred || !gateway}>
                {gatewayBusy ? 'Reading…' : "Read gateway's ARP table"}
              </button>
            </div>
          )}
          {gatewayNote && <p className="cv-help">{gatewayNote}</p>}
        </div>
      )}

      {hits.length > 0 && (
        <>
          <table className="cv-table cv-discover-table">
            <thead>
              <tr>
                <th />
                <th>Address</th>
                <th>Name</th>
                <th>MAC address</th>
                <th>Manufacturer</th>
                <th>Model</th>
                <th>Switch port</th>
                <th>Open ports</th>
                <th>Round trip</th>
              </tr>
            </thead>
            <tbody>
              {hits.map((h) => {
                const k = known.get(h.ip);
                const via = k?.discoveredVia ? `, found by ${k.discoveredVia}` : '';
                return (
                <tr key={h.ip}>
                  <td>
                    <input
                      type="checkbox"
                      checked={h.picked}
                      onChange={() => toggle(h.ip)}
                      aria-label={`Include ${h.hostname ?? h.ip}`}
                    />
                  </td>
                  <td className="cv-mono">{h.ip}</td>
                  {/* Reverse DNS, where the address has a PTR record (LT-109).
                      An em dash rather than the address again: repeating it
                      would read as a name and is what the backend deliberately
                      refuses to send. */}
                  {/* LT-125: where the network gave no name, the diagram may
                      have one a crawl learned — shown, and said to be from
                      the diagram, never passed off as the sweep's own. */}
                  <td className="cv-mono" title={
                    h.hostname
                      ? `${nameSourceLabel(h.nameSource)}${k ? ` — on the diagram as ${k.label}${via}` : ''}`
                      : k
                        ? `Named from the diagram — ${k.label}${via}`
                        : 'Nothing on the network could name this address'
                  }>
                    {h.hostname ?? (k ? k.label : <span className="cv-muted">—</span>)}
                    {h.hostname && k && k.label !== h.hostname && (
                      <span className="cv-known-as"> · on diagram as {k.label}</span>
                    )}
                  </td>
                  {/* Only ever present for a host on this segment: ARP does
                      not cross a router, so a routed sweep shows a dash
                      rather than the gateway's address. */}
                  <td className="cv-mono" title={
                    h.macFromGateway
                      ? `From ${h.macFromGateway}'s ARP table`
                      : h.mac
                        ? undefined
                        : 'Not on this segment, so there is no ARP entry'
                  }>
                    {h.mac ?? <span className="cv-muted">—</span>}
                  </td>
                  <td title={h.mac && !h.vendor ? 'That prefix is not in the IEEE registry' : undefined}>
                    {h.vendor ?? <span className="cv-muted">—</span>}
                  </td>
                  {/* LT-125: what a crawl learned, read off the diagram. */}
                  {/* The crawl's model first; else the product the host's own
                      certificate names (LT-124), said to be from there. */}
                  <td title={
                    k?.model
                      ? (k.serial ? `Serial ${k.serial}${k.osVersion ? ` · ${k.osVersion}` : ''}` : undefined)
                      : h.product || h.serial
                        ? `From the certificate on its web interface${h.serial ? ` — serial ${h.serial}` : ''}`
                        : undefined
                  }>
                    {k?.model ?? h.product ?? <span className="cv-muted">—</span>}
                  </td>
                  <td className="cv-mono">{k?.switchPort ?? <span className="cv-muted">—</span>}</td>
                  <td className="cv-mono cv-discover-ports">
                    {h.ports.length === 0 ? (
                      <span className="cv-muted">—</span>
                    ) : (
                      h.ports.map((p) => (
                        <span key={p.port} className="cv-port-chip" title={
                          // LT-124: on a web port, what the page said about
                          // its software — reported, never used as a name.
                          `${p.port} — usually ${p.service}` +
                          ((p.port === 80 || p.port === 8080) && (h.webServer || h.webTitle)
                            ? ` · ${[h.webServer && `Server: ${h.webServer}`, h.webTitle && `Page: ${h.webTitle}`]
                                .filter(Boolean)
                                .join(' · ')}`
                            : '')
                        }>
                          {p.port}
                        </span>
                      ))
                    )}
                  </td>
                  <td className="cv-mono">{h.rttMs === null ? '—' : `${h.rttMs.toFixed(h.rttMs < 1 ? 2 : 1)} ms`}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
