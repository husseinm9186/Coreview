import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import { useStableList } from '../lib/useStableList';
import { useReactFlow } from '@xyflow/react';
import { findNodes } from '../lib/findNodes';
import { t } from '../i18n';

import { useStore, type DockTab } from '../state/store';
import { JobsBar } from './JobsBar';
import { EmptyState } from './EmptyState';
import { useRovingTabindex } from './useRovingTabindex';
import { eventsToCsv } from '../lib/csv';
import { saveExport, slug } from '../lib/exports';
import { DiscoverPanel } from './DiscoverPanel';
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
import { ChromeIcon, IconButton } from './chromeIcons';
import { dockSideFor, dockWidthClass } from '../lib/dockPlacement';
import type { DeviceNodeData, HealthStatus, LinkData, ProbeRuntime } from '../types/domain';
import { STATUS_GLYPH, STATUS_LABEL } from '../types/domain';
import { activePage, allEdges, allNodes } from '../lib/pages';
import { roleOf } from '../lib/clusters';
import { buildTree, flattenTree, openForFit, type TreeBranch, type TreeLeafRow } from '../lib/objectTree';

type Row = TreeLeafRow & {
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

/** The monitored objects' rows. Memoised: a drag re-renders the
 *  panel, and two thousand rows need not follow when none of them changed. */
const ObjectRows = memo(function ObjectRows({
  rows,
  select,
  depth = 0,
  selectedId = null,
}: {
  rows: Row[];
  select: (nodeId: string | null, edgeId: string | null) => void;
  /** How far under a branch the rows sit. */
  depth?: number;
  /** The row selected on the canvas, marked so the table follows it. */
  selectedId?: string | null;
}) {
  return (
    <>
      {rows.map((r) => {
        const pick = () => (r.kind === 'node' ? select(r.id, null) : select(null, r.id));
        return (
          <tr
            key={r.id}
            className={`is-${r.status}${depth ? ` is-depth-${depth}` : ''}${r.id === selectedId ? ' is-selected' : ''}`}
            data-id={r.id}
            tabIndex={0}
            onClick={pick}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                pick();
              }
            }}
          >
            <td>
              {/* A dot and a word; the word in the status colour only when
                  there is something wrong. The glyph stays for the screen
                  reader, so colour is never the only carrier. */}
              <span className={`cv-status-chip is-${r.status}`}>
                <span className="cv-count-dot" aria-hidden="true" />
                <span className="cv-sr">{STATUS_GLYPH[r.status]} </span>
                {r.status === 'unknown' ? t('dock.notChecked') : STATUS_LABEL[r.status]}
              </span>
            </td>
            <td className="cv-kind">{r.kind}</td>
            <td className="cv-name">{r.name}</td>
            <td>{r.type}</td>
            <td className="cv-mono">{r.target || <span className="cv-dash">—</span>}</td>
            <td className="cv-num">{r.rtt != null ? r.rtt.toFixed(0) : <span className="cv-dash">—</span>}</td>
            <td className="cv-num cv-stale">{r.checked ?? <span className="cv-dash">—</span>}</td>
            <td className="cv-ellipsis">{r.detail || <span className="cv-dash">—</span>}</td>
          </tr>
        );
      })}
    </>
  );
});

/** One branch of the tree: a site or a role, with how many it holds and
 *  the worst of them. Click or Enter opens and closes it. */
function BranchRow({ branch, open, onToggle }: { branch: TreeBranch<Row>; open: boolean; onToggle: () => void }) {
  const problems = [
    branch.down ? t('dock.branchDown', { count: branch.down }) : '',
    branch.warning ? t('dock.branchWarning', { count: branch.warning }) : '',
  ].filter(Boolean);
  return (
    <tr
      className={`cv-tree-branch is-depth-${branch.depth} is-${branch.worst}${open ? ' is-open' : ''}`}
      data-branch={branch.key}
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <td colSpan={8}>
        <span className="cv-tree-toggle" aria-hidden="true">
          <ChromeIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        </span>
        {/* Spaces between the parts, so the row reads "HQ 20 2 down" to a
            screen reader rather than as one word. */}
        <span className="cv-tree-label">{branch.label}</span>{' '}
        <span className="cv-tree-count">{branch.count}</span>{' '}
        {problems.length > 0 && <span className={`cv-status-chip is-${branch.worst}`}><span className="cv-count-dot" aria-hidden="true" />{problems.join(' · ')}</span>}
      </td>
    </tr>
  );
}

/** The dock's tabs by what they answer. Every tab is here once. */
const DOCK_GROUPS: { key: 'monitor' | 'discover' | 'paths' | 'ops'; tabs: DockTab[] }[] = [
  { key: 'monitor', tabs: ['objects', 'events'] },
  // Collect is Discover devices ▸ Advanced now; the tab id stays so
  // whatever asks for it still lands there.
  { key: 'discover', tabs: ['crawl', 'discover'] },
  { key: 'paths', tabs: ['trace', 'path', 'tracert', 'whereis'] },
  { key: 'ops', tabs: ['backup', 'ssh'] },
];

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
  // A tab asked for from the command palette.
  const panelRequest = useStore((s) => s.panelRequest);
  const setOpen = useStore((s) => s.setPanelOpen);
  // The pages and the probes, not the whole document.
  const pages = useStore((s) => s.doc.pages);
  const probes = useStore((s) => s.doc.probes);
  const runtime = useStore((s) => s.runtime);
  const events = useStore((s) => s.events);
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const session = useStore((s) => s.session);
  const statusMessage = useStore((s) => s.statusMessage);
  const nodeStatusOf = useStore((s) => s.nodeStatus);
  const select = useStore((s) => s.select);

  // Compare, Racks and the two imports left for a screen of their own.
  // What is here is what reports on the diagram while it is being worked on.
  // The tab lives in the store, so the rail can open and name it.
  const tab = useStore((s) => s.dockTab);
  const setTab = useStore((s) => s.setDockTab);
  const dockPlacements = useStore((s) => s.dockPlacements);
  useEffect(() => {
    if (!panelRequest) return;
    // The register moved to a screen of its own. Anything that still
    // asks for its old tabs opens that instead of selecting a tab that is no
    // longer here.
    if (panelRequest === 'ipam' || panelRequest === 'lab') {
      useStore.getState().setRegisterOpen(true);
    } else if (panelRequest === 'compare' || panelRequest === 'racks' || panelRequest === 'csv' || panelRequest === 'visio') {
      // These four are a screen now. Anything still asking for the tab
      // gets the screen, opened on the view it asked for.
      useStore.getState().setToolsOpen(true, panelRequest);
    } else if (panelRequest === 'collect') {
      // The engine's own view is under Discover devices ▸ Advanced.
      setTab('crawl');
      useStore.getState().setDiscoverAdvanced(true);
    } else {
      setTab(panelRequest as typeof tab);
    }
    useStore.getState().requestPanelTab(null);
  }, [panelRequest, setTab]);
  // Devices handed over from a crawl, so a discovery can go straight to a
  // backup without being drawn first.
  const [handedOver, setHandedOver] = useState<{ address: string; name: string }[]>([]);
  // And from the inspector's Backup button, the same way.
  const backupHandover = useStore((s) => s.backupHandover);
  useEffect(() => {
    if (!backupHandover) return;
    setHandedOver(backupHandover);
    setTab('backup');
    useStore.getState().requestBackup(null);
  }, [backupHandover, setTab]);
  // How many shells are open, on the tab itself.
  const sshCount = useStore((s) => s.sshSessions.length);
  const [query, setQuery] = useState('');
  const rf = useReactFlow();
  // The active page only: jumpToFirst below centres the viewport on
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
  /** All, problems (warning and down), or down only. */
  const [problems, setProblems] = useState<'all' | 'problems' | 'down'>('all');
  const problemsOnly = problems !== 'all';
  const dockMaxRaw = useStore((s) => s.dockMax);
  // The dock's height, dragged on its grip and remembered on this machine.
  const [dockHeight, setDockHeight] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem('coreview.view.dockHeight'));
      return Number.isFinite(v) && v >= 120 ? v : null;
    } catch {
      return null;
    }
  });
  const keepHeight = (h: number | null) => {
    setDockHeight(h);
    try {
      if (h) localStorage.setItem('coreview.view.dockHeight', String(Math.round(h)));
      else localStorage.removeItem('coreview.view.dockHeight');
    } catch {
      /* no storage here */
    }
  };
  const panelRef = useRef<HTMLDivElement>(null);
  const grabGrip = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const startY = e.clientY;
    const startH = el.getBoundingClientRect().height;
    const room = (el.parentElement?.getBoundingClientRect().height ?? window.innerHeight) - 120;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setDockHeight(Math.max(120, Math.min(room, startH + (startY - ev.clientY))));
    const up = (ev: PointerEvent) => {
      keepHeight(Math.max(120, Math.min(room, startH + (startY - ev.clientY))));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  /** Double-click on the grip: a third of the body, or six tenths of it. */
  const toggleHeight = () => {
    const room = panelRef.current?.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
    const small = Math.round(room * 0.3);
    keepHeight(dockHeight && dockHeight > small + 20 ? small : Math.round(room * 0.6));
  };

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

  // The table shows names, types and statuses, none of which a drag
  // changes. Held steady while only positions move, the rows below are not
  // rebuilt — and two thousand table rows not re-rendered — on every frame.
  const nodes = useStableList(
    allNodes({ pages }),
    (a, b) => a.id === b.id && a.type === b.type && a.data === b.data,
  );
  const edges = useStableList(allEdges({ pages }), (a, b) => a === b);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    // Every page: monitoring is project-wide regardless of which
    // page a device or link is drawn on.
    const labelOf = new Map(nodes.map((n) => [n.id, (n.data as DeviceNodeData | undefined)?.label]));
    const siteOf = new Map(nodes.map((n) => [n.id, ((n.data as DeviceNodeData | undefined)?.site ?? '').trim()]));
    for (const n of nodes) {
      if (n.type !== 'device') continue;
      const d = n.data as DeviceNodeData;
      const own = probes.filter((p) => p.objectId === n.id);
      const primary = own.find((p) => p.isPrimary && p.enabled) ?? own.find((p) => p.enabled);
      const live = primary ? runtime.get(primary.id) : undefined;
      out.push({
        id: n.id,
        kind: 'node',
        site: siteOf.get(n.id) ?? '',
        role: roleOf(d),
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
        site: siteOf.get(e.source) ?? '',
        role: 'links',
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
        if (problems === 'problems' && r.status !== 'down' && r.status !== 'warning') return false;
        if (problems === 'down' && r.status !== 'down') return false;
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
    [rows, problems, query],
  );

  // The table as a tree — site › role › device — once there is something
  // to fold. The branches that will not fit the panel fold first; the one
  // holding what is selected on the canvas is always open; what somebody
  // opened or closed by hand stays as they left it.
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const selectedEdgeId = useStore((s) => s.selectedEdgeId);
  const selectedId = selectedNodeId ?? selectedEdgeId;
  const tree = useMemo(() => buildTree(filtered, (site) => site || t('dock.noSite')), [filtered]);
  const [manualOpen, setManualOpen] = useState<Map<string, boolean>>(() => new Map());
  const bodyRef = useRef<HTMLDivElement>(null);
  // How many rows the panel's body shows without scrolling.
  const [fits, setFits] = useState(40);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const rowPx = parseFloat(getComputedStyle(document.documentElement).fontSize) * 2.30769231 || 30;
      // Less the header row.
      setFits(Math.max(3, Math.floor(el.getBoundingClientRect().height / rowPx) - 1));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab]);
  const openKeys = useMemo(() => openForFit(tree, fits, selectedId, manualOpen), [tree, fits, selectedId, manualOpen]);
  const drawn = useMemo(() => flattenTree(tree, openKeys), [tree, openKeys]);
  const toggleBranch = (key: string) => setManualOpen((was) => new Map(was).set(key, !openKeys.has(key)));
  // The table follows the canvas: the selected row is brought into view.
  useEffect(() => {
    if (!selectedId || tab !== 'objects') return;
    const row = bodyRef.current?.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(selectedId)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, tab, drawn]);

  // Tick events, then copy or save exactly those. The table
  // is one tab stop and the arrows walk it.
  const [pickedEvents, setPickedEvents] = useState<Set<string>>(new Set());
  const eventsRef = useRef<HTMLTableElement>(null);
  useRovingTabindex(eventsRef, [events.length, query, problemsOnly]);
  const meta = useStore((s) => s.meta);
  const exportFolder = useStore((s) => s.settings.exportFolder);
  const filteredEvents = events.filter((e) => {
    if (problems === 'problems' && e.currentStatus !== 'down' && e.currentStatus !== 'warning') return false;
    if (problems === 'down' && e.currentStatus !== 'down') return false;
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

  const label = (id: DockTab): string => {
    switch (id) {
      case 'objects': return `Monitored objects (${rows.length})`;
      case 'events': return `Event timeline (${events.length})`;
      case 'discover': return 'Ping sweep';
      case 'crawl': return 'Discover devices';
      case 'collect': return 'Collect';
      case 'backup': return 'Backups';
      case 'path': return 'Path check';
      // Where a packet would go, beside Path check, which asks whether it gets there.
      case 'trace': return 'Path-Trace';
      // Where it actually went, beside where it would go.
      case 'tracert': return 'Tracert';
      // Where a thing is, from what the crawl already found.
      case 'whereis': return t('whereis.find');
      // Open shells — the diagram's own devices, so the dock keeps a tab.
      case 'ssh': return sshCount ? t('ssh.tab', { count: sshCount }) : t('ssh.title');
    }
  };

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
        {/* The strip stays in sight with the dock folded away. */}
        <DockStrip compact />
      </div>
    );
  }

  const tall = tab === 'crawl' || tab === 'collect' || tab === 'discover' || tab === 'backup' || tab === 'ssh' || tab === 'trace' || tab === 'tracert' || tab === 'whereis';
  const listTab = tab === 'objects' || tab === 'events';
  const dockSide = dockSideFor(tab, dockPlacements);
  const dockMax = dockMaxRaw && dockSide === 'bottom';
  const shown = tab === 'objects' ? filtered.length : filteredEvents.length;
  const total = tab === 'objects' ? rows.length : events.length;
  const down = counts.down ?? 0;
  const warning = counts.warning ?? 0;

  return (
    <div
      ref={panelRef}
      className={`cv-panel${tall ? ' is-tall' : ''}${dockMax ? ' is-max' : ''}${dockSide === 'right' ? ` is-dock-right ${dockWidthClass(tab)}` : ''}`}
      style={dockSide === 'bottom' && !dockMax && dockHeight ? { height: `${dockHeight}px` } : undefined}
    >
      {/* The grip: drag to resize, double-click for a third or six tenths. */}
      {dockSide === 'bottom' && !dockMax && (
        <div className="cv-dock-grip" role="separator" aria-orientation="horizontal" aria-label={t('dock.gripHint')} title={t('dock.gripHint')}
          onPointerDown={grabGrip} onDoubleClick={toggleHeight} />
      )}
      <div className="cv-panel-tabs">
        <div
          className="cv-tabs"
          role="tablist"
          aria-label="Panels"
          // Arrow keys move along every tab, in the groups' own order, Home
          // and End to the ends; the group that holds the chosen tab is the
          // one drawn first.
          onKeyDown={(e) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            const order = DOCK_GROUPS.flatMap((g) => g.tabs);
            const at = order.indexOf(tab);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length;
            e.preventDefault();
            const id = order[next]!;
            // Every tab is in the row already, so the next one can take
            // focus now; the state follows and keeps it there.
            e.currentTarget.querySelector<HTMLButtonElement>(`button[role="tab"][data-tab="${id}"]`)?.focus();
            setTab(id);
          }}
        >
          {/* The same tabs, grouped by what they answer. The group the rail
              has chosen comes first and in full; the rest follow a rule,
              smaller, so every tab is still one click away. The group names
              are read, not seen. */}
          {DOCK_GROUPS.map((g) => {
            const current = g.tabs.includes(tab);
            return (
              <span key={g.key} className={`cv-tab-group${current ? ' is-current' : ''}`} data-group={g.key} role="group" aria-label={t(`dock.group.${g.key}`)}>
                <span className="cv-tab-group-name cv-sr">{t(`dock.group.${g.key}`)}</span>
                {g.tabs.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    data-tab={id}
                    aria-selected={tab === id}
                    tabIndex={tab === id ? 0 : -1}
                    className={tab === id ? 'is-active' : ''}
                    onClick={() => setTab(id)}
                  >
                    {label(id)}
                  </button>
                ))}
              </span>
            );
          })}
        </div>
        <span className="cv-panel-tools">
          {/* The dock taking the canvas's room, down the right for a wide table, and away. */}
          {dockSide === 'bottom' && (
            <IconButton icon="maximise" label={dockMax ? t('dock.restore') : t('dock.maximise')} pressed={dockMax} region="dock-max"
              onClick={() => useStore.getState().setDockMax(!dockMax)} />
          )}
          <button
            type="button"
            className="cv-icon-btn"
            data-action="dock-side"
            title={dockSide === 'right' ? t('dock.dockBelowHint') : t('dock.dockRightHint')}
            onClick={() => useStore.getState().setDockPlacement(tab, dockSide === 'right' ? 'bottom' : 'right')}
          >
            <ChromeIcon name="pop-out" />
            <span className="cv-sr">{dockSide === 'right' ? t('dock.dockBelow') : t('dock.dockRight')}</span>
          </button>
          <IconButton icon="hide" label={t('dock.hide')} region="dock-hide" onClick={() => setOpen(false)} />
        </span>
      </div>

      {listTab && (
        <div className="cv-panel-head">
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
          <div className="cv-seg cv-seg-small cv-panel-seg" role="group" aria-label={t('dock.filterLabel')}>
            {(['all', 'problems', 'down'] as const).map((p) => (
              <button key={p} type="button" className={problems === p ? 'is-on' : ''} aria-pressed={problems === p} onClick={() => setProblems(p)}>
                {t(`dock.filter.${p}`)}
              </button>
            ))}
          </div>
          <span className="cv-panel-count">{t('dock.ofCount', { shown, total })}</span>
        </div>
      )}

      {/* When anything is down, a strip says so on every tab, and leads to it. */}
      {down > 0 && !(tab === 'objects' && problemsOnly) && (
        <div className="cv-dock-problem" role="status">
          <ChromeIcon name="alert" />
          <span>{warning > 0 ? t('dock.problemsBoth', { down, warning }) : t('dock.problemsDown', { down })}</span>
          <button type="button" className="cv-link-btn" onClick={() => { setTab('objects'); setProblems('problems'); }}>{t('dock.show')}</button>
        </div>
      )}

      {statusMessage && <div className="cv-panel-message" role="status" aria-live="polite">{statusMessage}</div>}

      <div className="cv-panel-body" ref={bodyRef}>
        {tab === 'discover' ? (
          <DiscoverPanel />
        ) : tab === 'crawl' || tab === 'collect' ? (
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
        ) : tab === 'tracert' ? (
          <TracertPanel />
        ) : tab === 'whereis' ? (
          <WhereIsPanel />
        ) : tab === 'ssh' ? (
          <SshPanel />
        ) : tab === 'objects' ? (
          <table className="cv-table cv-targets">
            {/* The column contract: what is counted is right-aligned and
                tabular, what could be pasted into a terminal is mono, and
                the last result takes what is left. */}
            <colgroup>
              <col className="col-status" /><col className="col-kind" /><col className="col-name" /><col className="col-type" />
              <col className="col-target" /><col className="col-num" /><col className="col-num" /><col />
            </colgroup>
            <thead>
              <tr>
                <th>Status</th>
                <th>Kind</th>
                <th>Name</th>
                <th>Type / rule</th>
                <th>Target</th>
                <th className="cv-num">RTT ms</th>
                <th className="cv-num">Checked</th>
                <th>Last result</th>
              </tr>
            </thead>
            <tbody>
              {tree.length === 0 ? (
                <ObjectRows rows={filtered} select={select} selectedId={selectedId} />
              ) : (
                drawn.map((d) =>
                  d.kind === 'branch' ? (
                    <BranchRow key={d.branch.key} branch={d.branch} open={d.open} onToggle={() => toggleBranch(d.branch.key)} />
                  ) : null,
                ).map((el, i) => {
                  // Leaves are drawn by branch, so a branch's rows stay one memoised run.
                  const d = drawn[i]!;
                  if (d.kind !== 'branch' || !d.open || d.branch.leaves.length === 0) return el;
                  return (
                    <Fragment key={d.branch.key}>
                      {el}
                      <ObjectRows rows={d.branch.leaves} select={select} depth={d.branch.depth + 1} selectedId={selectedId} />
                    </Fragment>
                  );
                })
              )}
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
                  {/* A DTG, not a bare clock time — a log line has to
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
                      ? <EmptyState icon="note" title={t('empty.events.what')} line={t('empty.events.why')} />
                      : <EmptyState icon="filter" title={t('empty.events.filtered')} />}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </>
        )}
      </div>

      {/* Every running job, whichever tab started it, along
          the dock's bottom, with the clock in the format Settings chose. */}
      <DockStrip />
    </div>
  );
}

/**
 * The strip along the dock's bottom: the jobs that are running,
 * one line each, and the clock — which is where the Times setting shows.
 * The clock ticks once a second; nothing else here re-renders for it.
 */
function DockStrip({ compact = false }: { compact?: boolean }) {
  // The clock moved to the top bar, where it is in sight on every screen;
  // the strip is the status line: what is selected, and the jobs.
  const selectedId = useStore((s) => s.selectedNodeId);
  const pg = useStore((s) => activePage(s.doc));
  const node = selectedId ? pg.nodes.find((n) => n.id === selectedId) : undefined;
  const links = node ? pg.edges.filter((e) => e.source === node.id || e.target === node.id).length : 0;
  const address = node && node.type === 'device' ? (node.data as { addresses?: { address: string; isPrimary?: boolean }[] }).addresses?.find((a) => a.isPrimary)?.address ?? (node.data as { addresses?: { address: string }[] }).addresses?.[0]?.address : undefined;
  return (
    <div className={`cv-dock-strip${compact ? ' is-compact' : ''}`} data-region="dock-strip">
      {!compact && node && (
        <span className="cv-strip-selection" data-region="strip-selection">
          <span className="cv-strip-name">{(node.data as { label?: string; title?: string }).label ?? (node.data as { title?: string }).title ?? ''}</span>
          {address && <span className="cv-mono cv-strip-addr">{address}</span>}
          <span className="cv-strip-links">{t('plural.link', { count: links })}</span>
        </span>
      )}
      <JobsBar compact />
    </div>
  );
}
