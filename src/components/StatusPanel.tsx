import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useStableList } from '../lib/useStableList';
import { useReactFlow } from '@xyflow/react';
import { findNodes } from '../lib/findNodes';
import { t } from '../i18n';

import { useStore } from '../state/store';
import { JobsBar } from './JobsBar';
import { EmptyState } from './EmptyState';
import { useRovingTabindex } from './useRovingTabindex';
import { eventsToCsv } from '../lib/csv';
import { saveExport, slug } from '../lib/exports';
import { DiscoverPanel } from './DiscoverPanel';
import { CollectionPanel } from './CollectionPanel';
import { CrawlPanel } from './CrawlPanel';
import { BackupPanel } from './BackupPanel';
import { PathCheckPanel } from './PathCheckPanel';
import { PathTracePanel } from './PathTracePanel';
import { TracertPanel } from './TracertPanel';
import { WhereIsPanel } from './WhereIsPanel';
import { SshPanel } from './SshPanel';
import { STATUS_COLOR } from './edges/LiveEdge';
import { linkStatus } from '../health/evaluate';
import { formatTime } from '../lib/timeFormat';
import type { DeviceNodeData, HealthStatus, LinkData, ProbeRuntime } from '../types/domain';
import { STATUS_GLYPH, STATUS_LABEL } from '../types/domain';
import { activePage, allEdges, allNodes } from '../lib/pages';

type Row = {
  id: string;
  kind: 'node' | 'link';
  name: string;
  type: string;
  target: string;
  status: HealthStatus;
  detail: string;
  /** How long ago the check behind `status` actually ran. */
  checked: string | null;
  rtt: number | null;
  tags: string[];
};

/**
 * What to say while a device has stopped answering but has not yet missed
 * enough checks to be called down.
 *
 * Repeating the last successful reply here reads as a current result, which
 * for the fifteen seconds the default thresholds take is the table asserting
 * something it has not confirmed.
 */
/**
 * How long ago the last check actually ran.
 *
 * A green row looks identical whether it was confirmed a second ago or has
 * not been re-checked since the session was paused. Saying so is the
 * difference between a status and a claim.
 */
function checkedAgo(live: ProbeRuntime | undefined, now: number): string | null {
  const last = Math.max(live?.lastSuccessMs ?? 0, live?.lastFailureMs ?? 0);
  if (!last) return null;
  const seconds = Math.max(0, Math.round((now - last) / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** The monitored objects' rows. Memoised (LT-189): a drag re-renders the
 *  panel, and two thousand rows need not follow when none of them changed. */
const ObjectRows = memo(function ObjectRows({
  rows,
  select,
}: {
  rows: Row[];
  select: (nodeId: string | null, edgeId: string | null) => void;
}) {
  return (
    <>
      {rows.map((r) => (
        <tr key={r.id} onClick={() => (r.kind === 'node' ? select(r.id, null) : select(null, r.id))}>
          <td>
            <span className="cv-status-chip" style={{ background: STATUS_COLOR[r.status] }}>
              {STATUS_GLYPH[r.status]} {STATUS_LABEL[r.status]}
            </span>
          </td>
          <td>{r.kind}</td>
          <td>{r.name}</td>
          <td className="cv-mono">{r.type}</td>
          <td className="cv-mono">{r.target || '—'}</td>
          <td className="cv-mono">{r.rtt != null ? `${r.rtt.toFixed(0)} ms` : '—'}</td>
          <td className="cv-mono cv-stale">{r.checked ?? '—'}</td>
          <td className="cv-mono cv-ellipsis">{r.detail || '—'}</td>
        </tr>
      ))}
    </>
  );
});

function missedNote(live: ProbeRuntime | undefined): string | null {
  if (!live || live.consecutiveFailures < 1) return null;
  // Only while the count still means something. Past the threshold the device
  // is down and has been reported as such; carrying on counting produces
  // "10 of 3 missed", which reads as a bug because it is one.
  if (live.consecutiveFailures >= live.failureThreshold) return null;
  return `No answer — ${live.consecutiveFailures} of ${live.failureThreshold} missed`;
}

export function StatusPanel() {
  const open = useStore((s) => s.panelOpen);
  // LT-230: a tab asked for from the command palette.
  const panelRequest = useStore((s) => s.panelRequest);
  const setOpen = useStore((s) => s.setPanelOpen);
  // LT-452: the pages and the probes, not the whole document.
  const pages = useStore((s) => s.doc.pages);
  const probes = useStore((s) => s.doc.probes);
  const runtime = useStore((s) => s.runtime);
  const events = useStore((s) => s.events);
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const session = useStore((s) => s.session);
  const statusMessage = useStore((s) => s.statusMessage);
  const nodeStatusOf = useStore((s) => s.nodeStatus);
  const select = useStore((s) => s.select);

  // LT-319: Compare, Racks and the two imports left for a screen of their own.
  // What is here is what reports on the diagram while it is being worked on.
  const [tab, setTab] = useState<'objects' | 'events' | 'discover' | 'crawl' | 'collect' | 'backup' | 'path' | 'trace' | 'tracert' | 'whereis' | 'ssh'>('objects');
  useEffect(() => {
    if (!panelRequest) return;
    // LT-300: the register moved to a screen of its own. Anything that still
    // asks for its old tabs opens that instead of selecting a tab that is no
    // longer here.
    if (panelRequest === 'ipam' || panelRequest === 'lab') {
      useStore.getState().setRegisterOpen(true);
    } else if (panelRequest === 'compare' || panelRequest === 'racks' || panelRequest === 'csv' || panelRequest === 'visio') {
      // LT-319: these four are a screen now. Anything still asking for the tab
      // gets the screen, opened on the view it asked for.
      useStore.getState().setToolsOpen(true, panelRequest);
    } else {
      setTab(panelRequest as typeof tab);
    }
    useStore.getState().requestPanelTab(null);
  }, [panelRequest]);
  // Devices handed over from a crawl, so a discovery can go straight to a
  // backup without being drawn first.
  const [handedOver, setHandedOver] = useState<{ address: string; name: string }[]>([]);
  // LT-320: how many shells are open, on the tab itself.
  const sshCount = useStore((s) => s.sshSessions.length);
  const [query, setQuery] = useState('');
  const rf = useReactFlow();
  // The active page only (LT-094): jumpToFirst below centres the viewport on
  // it, which only works for a node React Flow actually has rendered.
  const docNodes = useStore((s) => activePage(s.doc).nodes);
  const setHighlight = useStore((s) => s.setCanvasHighlight);
  // The same words that filter the table light up the canvas, so the list and
  // the drawing answer the question together.
  useEffect(() => {
    if (!query.trim()) {
      setHighlight(null);
      return;
    }
    const hits = findNodes(docNodes, query, 200);
    setHighlight(new Set(hits.map((h) => h.id)));
    return () => setHighlight(null);
  }, [query, docNodes, setHighlight]);

  /** Enter goes to the first match: centred, selected, zoom left alone. */
  const jumpToFirst = () => {
    const first = findNodes(docNodes, query, 1)[0];
    if (!first) return;
    const node = docNodes.find((n) => n.id === first.id);
    if (!node) return;
    rf.setCenter(
      node.position.x + (node.width ?? node.measured?.width ?? 120) / 2,
      node.position.y + (node.height ?? node.measured?.height ?? 60) / 2,
      { duration: 300, zoom: Math.max(rf.getZoom(), 0.9) },
    );
    useStore.getState().select(first.id, null);
  };
  const [problemsOnly, setProblemsOnly] = useState(false);

  // Ages have to move on their own, or "3s ago" sits there saying 3s
  // forever. Only while a session is running: with nothing being checked
  // there is nothing to age, and a timer that re-renders the table once a
  // second for no reason is worse than no timer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (session.state !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session.state]);

  // LT-189: the table shows names, types and statuses, none of which a drag
  // changes. Held steady while only positions move, the rows below are not
  // rebuilt — and two thousand table rows not re-rendered — on every frame.
  const nodes = useStableList(
    allNodes({ pages }),
    (a, b) => a.id === b.id && a.type === b.type && a.data === b.data,
  );
  const edges = useStableList(allEdges({ pages }), (a, b) => a === b);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    // Every page (LT-094): monitoring is project-wide regardless of which
    // page a device or link is drawn on.
    const labelOf = new Map(nodes.map((n) => [n.id, (n.data as DeviceNodeData | undefined)?.label]));
    for (const n of nodes) {
      if (n.type !== 'device') continue;
      const d = n.data as DeviceNodeData;
      const own = probes.filter((p) => p.objectId === n.id);
      const primary = own.find((p) => p.isPrimary && p.enabled) ?? own.find((p) => p.enabled);
      const live = primary ? runtime.get(primary.id) : undefined;
      out.push({
        id: n.id,
        kind: 'node',
        name: d.label,
        type: d.deviceType,
        target: primary?.target ?? '',
        status: nodeStatusOf(n.id),
        detail: missedNote(live) ?? live?.lastSummary ?? '',
        checked: checkedAgo(live, now),
        rtt: live?.lastRttMs ?? null,
        tags: d.tags ?? [],
      });
    }
    for (const e of edges) {
      const d = e.data as LinkData;
      const nameOf = (id: string) => labelOf.get(id) ?? id;
      const linkProbes = probes.filter((p) => p.objectId === e.id);
      const live = linkProbes[0] ? runtime.get(linkProbes[0].id) : undefined;
      out.push({
        id: e.id,
        kind: 'link',
        name: `${nameOf(e.source)} ↔ ${nameOf(e.target)}`,
        type: d.healthRule?.type ?? 'manual',
        target: linkProbes[0]?.target ?? '',
        status: linkStatus({
          link: { enabled: d.enabled, maintenance: d.maintenance, healthRule: d.healthRule },
          sourceStatus: nodeStatusOf(e.source),
          targetStatus: nodeStatusOf(e.target),
          linkProbes,
          allProbes: probes,
          runtime,
          sessionRunning: session.state === 'running',
        }),
        detail: missedNote(live) ?? live?.lastSummary ?? '',
        checked: checkedAgo(live, now),
        rtt: live?.lastRttMs ?? null,
        tags: [],
      });
    }
    return out;
  }, [nodes, edges, probes, runtime, session.state, nodeStatusOf, now]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (problemsOnly && r.status !== 'down' && r.status !== 'warning') return false;
        if (!query) return true;
        const q = query.toLowerCase();
        return (
          r.name.toLowerCase().includes(q) ||
          r.target.toLowerCase().includes(q) ||
          r.type.toLowerCase().includes(q) ||
          r.status.includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q))
        );
      }),
    [rows, problemsOnly, query],
  );

  // LT-446: tick events, then copy or save exactly those. LT-447: the table
  // is one tab stop and the arrows walk it.
  const [pickedEvents, setPickedEvents] = useState<Set<string>>(new Set());
  const eventsRef = useRef<HTMLTableElement>(null);
  useRovingTabindex(eventsRef, [events.length, query, problemsOnly]);
  const meta = useStore((s) => s.meta);
  const exportFolder = useStore((s) => s.settings.exportFolder);
  const filteredEvents = events.filter((e) => {
    if (problemsOnly && e.currentStatus !== 'down' && e.currentStatus !== 'warning') return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      e.objectName.toLowerCase().includes(q) ||
      (e.target ?? '').toLowerCase().includes(q) ||
      e.message.toLowerCase().includes(q)
    );
  });

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  if (!open) {
    return (
      <div className="cv-panel is-collapsed">
        <button type="button" className="cv-btn" onClick={() => setOpen(true)}>
          Show status and events
        </button>
        <span className="cv-panel-summary">
          {(['healthy', 'warning', 'down', 'unknown'] as HealthStatus[]).map((s) => (
            <span key={s} style={{ color: STATUS_COLOR[s] }}>
              {STATUS_GLYPH[s]} {counts[s] ?? 0}
            </span>
          ))}
        </span>
      </div>
    );
  }

  return (
    <div className={`cv-panel${tab === 'crawl' || tab === 'collect' || tab === 'discover' || tab === 'backup' || tab === 'ssh' || tab === 'trace' || tab === 'tracert' || tab === 'whereis' ? ' is-tall' : ''}`}>
      <div className="cv-panel-head">
        <div
          className="cv-tabs"
          role="tablist"
          aria-label="Panels"
          // LT-240: arrow keys move along the tabs, Home and End to the ends.
          onKeyDown={(e) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]')];
            const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            e.preventDefault();
            tabs[next]?.focus();
            tabs[next]?.click();
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'objects'}
            tabIndex={tab === 'objects' ? 0 : -1}
            className={tab === 'objects' ? 'is-active' : ''}
            onClick={() => setTab('objects')}
          >
            Monitored objects ({rows.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'events'}
            tabIndex={tab === 'events' ? 0 : -1}
            className={tab === 'events' ? 'is-active' : ''}
            onClick={() => setTab('events')}
          >
            Event timeline ({events.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'discover'}
            tabIndex={tab === 'discover' ? 0 : -1}
            className={tab === 'discover' ? 'is-active' : ''}
            onClick={() => setTab('discover')}
          >
            Ping sweep
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'crawl'}
            tabIndex={tab === 'crawl' ? 0 : -1}
            className={tab === 'crawl' ? 'is-active' : ''}
            onClick={() => setTab('crawl')}
          >
            Discover devices
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'collect'}
            tabIndex={tab === 'collect' ? 0 : -1}
            className={tab === 'collect' ? 'is-active' : ''}
            onClick={() => setTab('collect')}
          >
            Collect
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'backup'}
            tabIndex={tab === 'backup' ? 0 : -1}
            className={tab === 'backup' ? 'is-active' : ''}
            onClick={() => setTab('backup')}
          >
            Backups
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'path'}
            tabIndex={tab === 'path' ? 0 : -1}
            className={tab === 'path' ? 'is-active' : ''}
            onClick={() => setTab('path')}
          >
            Path check
          </button>
          {/* LT-346: where a packet would go, from the routing tables already
              collected. Beside Path check, which asks whether it gets there. */}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'trace'}
            tabIndex={tab === 'trace' ? 0 : -1}
            className={tab === 'trace' ? 'is-active' : ''}
            onClick={() => setTab('trace')}
          >
            Path-Trace
          </button>
          {/* LT-505: where it actually went — a traceroute from here or from
              a device — beside Path-Trace's where it would go. */}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'tracert'}
            tabIndex={tab === 'tracert' ? 0 : -1}
            className={tab === 'tracert' ? 'is-active' : ''}
            onClick={() => setTab('tracert')}
          >
            Tracert
          </button>
          {/* LT-338: where a thing is, from what the crawl already found. */}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'whereis'}
            tabIndex={tab === 'whereis' ? 0 : -1}
            className={tab === 'whereis' ? 'is-active' : ''}
            onClick={() => setTab('whereis')}
          >
            {t('whereis.find')}
          </button>

          {/* LT-320: open shells. It is about the diagram in front of you —
              these are its devices — so this one belongs in the panel. */}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'ssh'}
            tabIndex={tab === 'ssh' ? 0 : -1}
            className={tab === 'ssh' ? 'is-active' : ''}
            onClick={() => setTab('ssh')}
          >
            {sshCount ? t('ssh.tab', { count: sshCount }) : t('ssh.title')}
          </button>
        </div>

        {tab !== 'discover' && tab !== 'crawl' && tab !== 'collect' && tab !== 'backup' && tab !== 'path' && tab !== 'trace' && tab !== 'tracert' && tab !== 'whereis' && tab !== 'ssh' && (
          <>
            <input
              className="cv-input cv-panel-search"
            aria-label="Filter the list"
              placeholder="Filter by name, IP, type, tag or status"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  jumpToFirst();
                }
              }}
            />
            <label className="cv-check cv-check-inline">
              <input
                type="checkbox"
                checked={problemsOnly}
                onChange={(e) => setProblemsOnly(e.target.checked)}
              />
              Warnings and down only
            </label>
          </>
        )}
        <button type="button" className="cv-btn cv-btn-small" onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>

      {/* LT-443: every running job, whichever tab started it. */}
      <JobsBar />
      {statusMessage && <div className="cv-panel-message" role="status" aria-live="polite">{statusMessage}</div>}

      <div className="cv-panel-body">
        {tab === 'discover' ? (
          <DiscoverPanel />
        ) : tab === 'crawl' ? (
          <CrawlPanel
            onBackup={(targets) => {
              setHandedOver(targets);
              setTab('backup');
            }}
          />
        ) : tab === 'backup' ? (
          <BackupPanel fromCrawl={handedOver} onConsumed={() => setHandedOver([])} />
        ) : tab === 'path' ? (
          <PathCheckPanel />
        ) : tab === 'trace' ? (
          <PathTracePanel />
        ) : tab === 'collect' ? (
          <CollectionPanel />
        ) : tab === 'tracert' ? (
          <TracertPanel />
        ) : tab === 'whereis' ? (
          <WhereIsPanel />
        ) : tab === 'ssh' ? (
          <SshPanel />
        ) : tab === 'objects' ? (
          <table className="cv-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Kind</th>
                <th>Name</th>
                <th>Type / rule</th>
                <th>Target</th>
                <th>RTT</th>
                <th>Checked</th>
                <th>Last result</th>
              </tr>
            </thead>
            <tbody>
              <ObjectRows rows={filtered} select={select} />
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="cv-help">
                    Nothing matches this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <>
          {pickedEvents.size > 0 && (
            <div className="cv-select-bar" role="toolbar" aria-label={t('select.bar')}>
              <span>{t('select.count', { count: pickedEvents.size })}</span>
              <button type="button" className="cv-btn cv-btn-small"
                onClick={() => void navigator.clipboard.writeText(eventsToCsv(events.filter((e) => pickedEvents.has(e.id))))}>
                {t('select.copyCsv')}
              </button>
              <button type="button" className="cv-btn cv-btn-small"
                onClick={() => void saveExport(`${slug(meta?.name ?? 'events')}-events-selected.csv`, eventsToCsv(events.filter((e) => pickedEvents.has(e.id))), 'text/csv', exportFolder)
                  .then((path) => { if (path) useStore.getState().setStatusMessage(t('select.exported', { path })); })
                  .catch(() => undefined)}>
                {t('select.exportCsv')}
              </button>
              <button type="button" className="cv-btn cv-btn-small" onClick={() => setPickedEvents(new Set())}>{t('select.clear')}</button>
            </div>
          )}
          <table className="cv-table" ref={eventsRef}>
            <thead>
              <tr>
                <th className="cv-pick-col">
                  <input type="checkbox" aria-label={t('select.all')}
                    checked={filteredEvents.length > 0 && filteredEvents.every((e) => pickedEvents.has(e.id))}
                    onChange={(ev) => setPickedEvents(ev.target.checked ? new Set(filteredEvents.map((e) => e.id)) : new Set())} />
                </th>
                <th>Time</th>
                <th>Object</th>
                <th>Name</th>
                <th>Transition</th>
                <th>Probe</th>
                <th>Target</th>
                <th>RTT</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.map((e) => (
                <tr
                  key={e.id}
                  data-picked={pickedEvents.has(e.id) ? 'yes' : undefined}
                  onDoubleClick={() =>
                    void navigator.clipboard.writeText(
                      `${formatTime(e.timestampMs, timeFormat)} ${e.objectType} ${e.objectName} ${
                        e.previousStatus
                      } → ${e.currentStatus} ${e.target ?? ''} ${e.message}`,
                    )
                  }
                  title="Double-click to copy this event"
                >
                  <td className="cv-pick-col">
                    <input type="checkbox" aria-label={t('select.row')} checked={pickedEvents.has(e.id)}
                      onClick={(ev) => ev.stopPropagation()}
                      onChange={(ev) => setPickedEvents((prev) => {
                        const next = new Set(prev);
                        if (ev.target.checked) next.add(e.id); else next.delete(e.id);
                        return next;
                      })} />
                  </td>
                  {/* LT-074: a DTG, not a bare clock time — a log line has to
                      say which day and which zone to be worth keeping. */}
                  <td className="cv-mono" title={new Date(e.timestampMs).toISOString()}>
                    {formatTime(e.timestampMs, timeFormat)}
                  </td>
                  <td>{e.objectType}</td>
                  <td>{e.objectName}</td>
                  <td>
                    <span style={{ color: STATUS_COLOR[e.previousStatus ?? 'unknown'] }}>
                      {STATUS_LABEL[e.previousStatus ?? 'unknown']}
                    </span>
                    {' → '}
                    <span style={{ color: STATUS_COLOR[e.currentStatus ?? 'unknown'] }}>
                      {STATUS_LABEL[e.currentStatus ?? 'unknown']}
                    </span>
                  </td>
                  <td className="cv-mono">{e.probeType ?? '—'}</td>
                  <td className="cv-mono">{e.target ?? '—'}</td>
                  <td className="cv-mono">{e.rttMs != null ? `${e.rttMs.toFixed(0)} ms` : '—'}</td>
                  <td className="cv-ellipsis">{e.message}</td>
                </tr>
              ))}
              {filteredEvents.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    {events.length === 0
                      ? <EmptyState what={t('empty.events.what')} why={t('empty.events.why')} />
                      : <EmptyState what={t('empty.events.filtered')} />}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </>
        )}
      </div>
    </div>
  );
}
