import { nodeForDrop } from '../lib/paletteDrop';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  MiniMap,
  ReactFlow,
  ViewportPortal,
  useReactFlow,
  useStoreApi,
  useStore as useFlowStore,
  ConnectionMode,
  SelectionMode,
  type Connection,
  type NodeChange,
  type OnConnect,
  getNodesBounds,
  useViewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { DeviceNode } from './nodes/DeviceNode';
import { NoteNode } from './nodes/NoteNode';
import { EdgeMarkerDefs, LiveEdge, nearestFractionOnPath } from './edges/LiveEdge';
import { allPaths } from './edges/pathRegistry';
import { STATUS_COLOR_DARK, canvasPalette, statusColors, type Ground } from '../theme';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { FindBox } from './FindBox';
import { ColourLegend } from './ColourLegend';
import { ShortcutHelp } from './ShortcutHelp';
import { GuidePanel } from './GuidePanel';
import { CommandPalette, type PaletteCommand } from './CommandPalette';
import { hidingUnmatched, litNodes } from '../lib/canvasFilter';
import { collapseLabel, foldedCount, hiddenByAll, worthCollapsing } from '../lib/collapseBranch';
import { nearestInDirection, nearestTo, type Direction } from '../lib/spatialNav';
import { edgeAriaLabel, nodeAriaLabel } from '../lib/ariaLabels';
import { InkStrokes, InkTools } from './InkLayer';
import { TraceroutePanel } from './TraceroutePanel';
import { Page } from './Page';
import { PageTabs } from './PageTabs';
import { effectivePage, pageForContent } from '../lib/pageRect';
import { collapseView, groupIdOf, isCollapsed } from '../lib/collapse';
import { routeForView } from '../lib/routeLinks';
import { alignmentFor, spacingHint, type Box, type Guide } from '../lib/alignment';
import { allPrinted, isEditable, isPrinted, isVisible, layersOf } from '../lib/layers';
import { resetToDefault, styleOf } from '../lib/linkDefaults';
import { useStore, type TopoEdge, type TopoNode, moveGroups } from '../state/store';
import { activePage, withPage, pageNodeById } from '../lib/pages';
import { openSsh, openSshElsewhere } from './sshActions';
import { isDesktop } from '../lib/ipc';
import { t } from '../i18n';
import { arrangeByLayerMessage, layoutMessage } from './arrangeMessages';
import { uid } from '../lib/id';
import { DEVICE_LABEL } from './icons';
import { shapeDefaultFields } from '../lib/shapeCatalog';
import { useDragOverlay } from '../state/dragOverlay';
import { restack, sameOrder, type Restack } from '../lib/zOrder';
import { addPoint, lassoed, type Point } from '../lib/lasso';
import { snapUnguided } from '../lib/gridSnap';
import { snapStep } from '../lib/gridScale';
import { PRINT_ACTUAL_ZOOM } from '../lib/pageSize';
import { Rulers } from './Rulers';
import { TraceFade } from './edges/traced';
import type { DeviceNodeData, DeviceType, LinkData, NoteNodeData, HealthStatus } from '../types/domain';

const nodeTypes = { device: DeviceNode, note: NoteNode };
const edgeTypes = { live: LiveEdge };

/** How big a shape arrives. A section is an area, so it arrives as one — a
 *  176x96 section would have to be resized before it could hold anything. */
function defaultSize(type: DeviceType): { width: number; height: number } {
  if (type === 'zone') return { width: 420, height: 300 };
  if (type === 'callout') return { width: 190, height: 64 };
  if (type === 'text') return { width: 168, height: 44 };
  // Shapes keep the card proportions; a device is its glyph, and a
  // glyph's bounds are square so the corners sit on the drawn shape.
  if (['rectangle', 'rounded', 'circle', 'diamond', 'cloud'].includes(type)) {
    return { width: 168, height: 92 };
  }
  return { width: 76, height: 76 };
}

/** Below this zoom the canvas draws devices and links without their detail:
 *  at 0.4 a 12px label is under five pixels tall. */
export const FAR_ZOOM = 0.4;
/** The grid a dragged object snaps to: the page's minor grid lines. */
export const GRID_STEP = 12;
/** …and only on a page this large — the same line culling was held
 *  to: below it, the canvas draws as it always has. */
export const FAR_MIN_DEVICES = 500;

export function makeDeviceNode(type: DeviceType, x: number, y: number): TopoNode {
  const data: DeviceNodeData = {
    label: DEVICE_LABEL[type],
    deviceType: type,
    tags: [],
    locked: false,
    maintenance: false,
    showDetails: true,
    // Ports, rack height and a management address to fill in.
    ...shapeDefaultFields(type, uid),
  };
  const { width, height } = defaultSize(type);
  return {
    id: uid(),
    type: 'device',
    position: { x, y },
    width,
    height,
    data,
  };
}

/**
 * The minimap, plain or coloured by health. Its own component so the
 * probe results it listens to re-render the minimap, not the whole canvas.
 * Health is carried by shape as well as colour: a down device is outlined
 * dashed, a warning one outlined solid.
 */
function HealthMiniMap({ health, ground }: { health: boolean; ground: Ground }) {
  const palette = canvasPalette(ground);
  useStore((s) => (health ? s.runtime : null));
  useStore((s) => (health ? s.session.state : null));
  const status = (id: string): HealthStatus => useStore.getState().nodeStatus(id);
  // While the whole diagram is in view the overview says nothing the page
  // does not, so it fades back and returns on hover — or the moment
  // something is off the edge.
  const viewport = useViewport();
  const nodes = useStore((s) => activePage(s.doc).nodes);
  const quiet = useMemo(() => {
    if (nodes.length === 0) return true;
    const pane = document.querySelector('.react-flow__pane')?.getBoundingClientRect();
    if (!pane) return false;
    const b = getNodesBounds(nodes);
    const left = b.x * viewport.zoom + viewport.x;
    const top = b.y * viewport.zoom + viewport.y;
    const right = (b.x + b.width) * viewport.zoom + viewport.x;
    const bottom = (b.y + b.height) * viewport.zoom + viewport.y;
    return left >= -8 && top >= -8 && right <= pane.width + 8 && bottom <= pane.height + 8;
  }, [nodes, viewport.x, viewport.y, viewport.zoom]);
  return (
    <MiniMap
      pannable
      zoomable
      className={`cv-minimap${health ? ' is-health' : ''}${quiet ? ' is-quiet' : ''}`}
      nodeColor={(n) =>
        n.type === 'note'
          ? palette.minimapNote
          : health && status(n.id) !== 'unknown'
            ? statusColors(ground)[status(n.id)]
            : palette.minimapNode
      }
      nodeClassName={(n) => (health && n.type !== 'note' ? `cv-mm-${status(n.id)}` : '')}
      maskColor={palette.minimapMask}
    />
  );
}

export function makeNote(x: number, y: number, variant: NoteNodeData['variant'] = 'plain'): TopoNode {
  const data: NoteNodeData = {
    title: variant === 'change' ? 'Change note' : undefined,
    body:
      variant === 'change'
        ? '## Pre-check\n- [ ] Baseline captured\n\n## Implementation\n- [ ] Step 1\n\n## Rollback\n- [ ] Restore config'
        : 'Note',
    variant,
    fontSize: 13,
    // Left unset on purpose: a note nobody has coloured follows the ground,
    // so a diagram drawn on black and printed on white does not carry dark
    // blocks through the middle of the page.
    locked: false,
  };
  return { id: uid(), type: 'note', position: { x, y }, width: 260, height: 160, data };
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}



export function Canvas() {
  const wrapper = useRef<HTMLDivElement>(null);
  // The outline of a lasso being drawn, in the wrapper's own pixels.
  const [lasso, setLasso] = useState<Point[] | null>(null);
  const rf = useReactFlow();
  /** React Flow's own store, for cancelling a selection box it has already
   *  started when space turns the drag into a pan. */
  const rfStore = useStoreApi();
  const ground = useStore((s) => s.settings.ground);
  const settings = useStore((s) => s.settings);

  // Zoomed far out over a large diagram, a device's name, status line
  // and badge, its connection handles and a link's hit band and labels are too
  // small to read or use — and they were most of what Chrome repainted on every
  // frame of a pan (at 5,000 devices, a pan took a third of the time with them
  // hidden). One class, which changes only when the answer does, hides them;
  // nothing re-renders. Only on a large page: an ordinary diagram fitted to the
  // window is often below 40% too, and has nothing to gain from losing them.
  const far = useFlowStore((s) => s.transform[2] < FAR_ZOOM && s.nodeLookup.size >= FAR_MIN_DEVICES);
  const [finding, setFinding] = useState(false);
  const [help, setHelp] = useState(false);
  // The command palette.
  const [palette, setPalette] = useState(false);
  // The top bar's Search opens the palette the canvas owns.
  const paletteRequest = useStore((s) => s.commandPaletteRequest);
  useEffect(() => {
    if (!paletteRequest) return;
    setPalette(true);
    useStore.getState().requestCommandPalette(false);
  }, [paletteRequest]);
  const [tracerouteTarget, setTracerouteTarget] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  /** Space held: the pointer becomes a hand and drags the diagram. */
  const [panning, setPanning] = useState(false);
  /** Space was let go mid-drag: the hand stays until the button comes up. */
  const releaseAfterDrag = useRef(false);
  /** Alt held: the guides stand down and the drag is free-hand. Sometimes a
   *  device has to sit deliberately two pixels off, and a snap that cannot be
   *  refused is a snap that gets fought. A ref, not state — it is read inside
   *  the drag path and must not re-render the canvas per keypress. */
  const altDown = useRef(false);
  /** Where the left button went down on the canvas and is still held — so
   *  space pressed a moment after the button can still turn the drag into a
   *  pan. */
  const pointerHeld = useRef<{ x: number; y: number } | null>(null);
  const panFrom = useRef<{
    from: { x: number; y: number; zoom: number };
    startX: number;
    startY: number;
  } | null>(null);
  /** Take the diagram in hand from this point and follow the pointer until the
   *  button comes up, wherever it goes.
   *
   *  The listeners are on the window rather than on the sheet, and both the
   *  pointer and the mouse pair are heard, because: in WebKitGTK a
   *  press of the *right* button is claimed for a context menu, after which the
   *  element gets no more pointer events for it — even with the pointer
   *  captured — so a right-button pan moved nothing at all, which is the drag a
   *  lot of people reach for first. Setting the viewport from the absolute
   *  distance travelled, not from each step, makes hearing the same movement
   *  twice harmless. */
  const grabAt = useCallback(
    (startX: number, startY: number) => {
      const from = rf.getViewport();
      panFrom.current = { from, startX, startY };
      const move = (ev: PointerEvent | MouseEvent) => {
        const g = panFrom.current;
        if (!g) return;
        rf.setViewport({
          x: g.from.x + (ev.clientX - g.startX),
          y: g.from.y + (ev.clientY - g.startY),
          zoom: g.from.zoom,
        });
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('mousemove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('mouseup', end);
        window.removeEventListener('pointercancel', end);
        panFrom.current = null;
        // The space bar was let go half way through the drag; the hand waited
        // for the button, and the button is up now.
        if (releaseAfterDrag.current) {
          releaseAfterDrag.current = false;
          setPanning(false);
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('mousemove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('mouseup', end);
      window.addEventListener('pointercancel', end);
    },
    [rf],
  );
  // A view, not a document change: folding a site must not touch what is
  // saved, so expanding restores exactly what was there.
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);

  const doc = useStore((s) => s.doc);
  const bundledIcons = useStore((s) => s.bundledIcons);
  const canPaste = useStore((s) => s.canPaste);
  const iconLibrary = useStore((s) => s.iconLibrary);
  const presenting = useStore((s) => s.presenting);
  // The page being drawn — this component renders exactly one.
  const pg = activePage(doc);

  const onConnect: OnConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      // Loose connections let any side reach any side, which also means a
      // node can be dropped on itself. A link from a device to itself is
      // never what someone meant to draw.
      if (c.source === c.target) return;

      // A line out of a piece of text is a leader, not a cable. Drawing one
      // from a note and then having to turn off its health, its arrow and its
      // packet dots by hand is three steps to say something obvious.
      const annotation = (id: string) => {
        const n = pg.nodes.find((x) => x.id === id);
        if (!n) return false;
        if (n.type === 'note') return true;
        const kind = (n.data as { deviceType?: string }).deviceType;
        return kind === 'text' || kind === 'callout';
      };
      const leader = annotation(c.source) || annotation(c.target);
      const edge = {
        id: uid(),
        source: c.source,
        target: c.target,
        sourceHandle: c.sourceHandle ?? null,
        targetHandle: c.targetHandle ?? null,
        type: 'live',
        data: {
          ...(leader ? { kind: 'leader' as const } : {}),
          sourcePortLabel: '',
          targetPortLabel: '',
          label: '',
          // A leader to a note is straight on purpose — a curved pointer at a
          // label is just harder to follow — and it points at nothing, so it
          // has no direction. A real link between two devices names neither:
          // `useStore.getState().addEdge` gives it the document's default style, which is
          // Bezier unless the operator saved something else.
          ...(leader
            ? {
                pathType: 'straight' as const,
                direction: 'none' as const,
                width: 2,
                // A stored default, not a drawn one: what is saved in the
                // document must not depend on which ground the person who
                // drew it was using.
                color: STATUS_COLOR_DARK.unknown,
              }
            : {}),
          enabled: true,
          maintenance: false,
          healthRule: leader ? { type: 'manual' } : { type: 'both-endpoints' },
        },
      } as unknown as TopoEdge;
      useStore.getState().addEdge(edge);
      useStore.getState().select(null, edge.id);
    },
    [pg.nodes],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData('application/coreview');
      if (!raw) return;
      const position = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const node = nodeForDrop(raw, position.x, position.y, {
        makeDeviceNode,
        makeNote,
        // The user's own folder first, so an id clash resolves to their
        // icon; the bundled set backs it, then whatever this
        // project has captured from its own canvas.
        iconLibrary: [...iconLibrary, ...bundledIcons, ...(doc.customShapes ?? [])],
      });
      if (node) useStore.getState().addNode(node);
    },
    [rf, iconLibrary, bundledIcons, doc.customShapes],
  );

  const nodeMenu = (nodeId: string): MenuItem[] => {
    // A folded box stands for objects rather than being one. Offering to
    // duplicate or delete it would act on an id that is not in the document.
    if (isCollapsed(nodeId)) {
      return [
        {
          label: 'Open this group',
          onSelect: () =>
            setFolded((was) => {
              const next = new Set(was);
              next.delete(groupIdOf(nodeId));
              return next;
            }),
        },
      ];
    }
    const node = pg.nodes.find((n) => n.id === nodeId);
    const locked = Boolean((node?.data as { locked?: boolean } | undefined)?.locked);
    const maintenance = Boolean((node?.data as DeviceNodeData | undefined)?.maintenance);
    const members = useStore.getState().groupMembers(nodeId);
    const selectedCount = pg.nodes.filter((n) => n.selected).length;
    // The same target a device's own primary check is aimed at, so
    // "where is this actually going" traces the address being monitored,
    // not just whichever address happens to be listed first.
    const nodeProbes = doc.probes.filter((p) => p.objectId === nodeId);
    const primaryTarget = (nodeProbes.find((p) => p.isPrimary) ?? nodeProbes[0])?.target.trim();
    return [
      { label: 'Edit properties', onSelect: () => useStore.getState().select(nodeId, null) },
      // This device, or the selection it is part of, and its neighbours.
      ...[1, 2].map((hops) => ({
        label: `Focus on ${selectedCount > 1 && node?.selected ? 'the selection' : 'this'} — ${t('plural.link', { count: hops })} out`,
        onSelect: () => useStore.getState().setFocus({ ids: selectedCount > 1 && node?.selected ? pg.nodes.filter((n) => n.selected).map((n) => n.id) : [nodeId], hops }),
      })),
      ...(primaryTarget
        ? [{ label: 'Traceroute', onSelect: () => setTracerouteTarget(primaryTarget) }]
        : []),
      // Fold what hangs off this device into it. Offered only when
      // there is something to fold — a leaf holds nothing, and an action that
      // does nothing is worse than an absent one. The label counts first, so
      // nobody has to try it to find out what it takes.
      ...(node?.type === 'device' &&
      (collapsed.includes(nodeId) || worthCollapsing(nodeId, pg.nodes, pg.edges))
        ? [
            {
              label: collapseLabel(nodeId, pg.nodes, pg.edges, new Set(collapsed)),
              onSelect: () => {
                const was = collapsed.includes(nodeId);
                const n = hiddenByAll([nodeId], pg.nodes, pg.edges).size;
                useStore.getState().toggleCollapsed(nodeId);
                useStore.getState().setStatusMessage(
                  was
                    ? `Expanded — ${t('plural.device', { count: n })} back on the page.`
                    : `Collapsed — ${t('plural.device', { count: n })} folded into this one. Nothing was deleted.`,
                );
              },
            },
          ]
        : []),
      ...(collapsed.length > 0
        ? [
            {
              label: `Expand everything — ${collapsed.length} collapsed`,
              onSelect: () => {
                useStore.getState().expandAll();
                useStore.getState().setStatusMessage('Everything is expanded.');
              },
            },
          ]
        : []),
      // A shell on this device, in the panel, beside the others.
      // Or in the terminal the machine already has. Which one the
      // plain entry does is a setting, and the other is always offered too —
      // a preference should not take a choice away.
      ...(node?.type === 'device' && isDesktop
        ? (settings.terminal.openWith === 'external'
            ? [
                { label: t('ssh.connect'), onSelect: () => void openSshElsewhere(node.data as DeviceNodeData) },
                { label: t('ssh.panel'), onSelect: () => void openSsh(nodeId, node.data as DeviceNodeData) },
              ]
            : [
                { label: t('ssh.connect'), onSelect: () => void openSsh(nodeId, node.data as DeviceNodeData) },
                { label: t('ssh.external'), onSelect: () => void openSshElsewhere(node.data as DeviceNodeData) },
              ])
        : []),
      {
        label: 'Duplicate',
        onSelect: () => {
          if (!node) return;
          useStore.getState().addNode({
            ...node,
            id: uid(),
            position: { x: node.position.x + 40, y: node.position.y + 40 },
            selected: false,
          } as TopoNode);
        },
      },
      ...(node?.type === 'device'
        ? [
            {
              label: 'Save to shape library',
              onSelect: () => {
                const d = node.data as DeviceNodeData;
                useStore.getState().saveCustomShape(nodeId, d.label || DEVICE_LABEL[d.deviceType]);
              },
            },
          ]
        : []),
      {
        label: maintenance ? 'Clear maintenance' : 'Set maintenance',
        onSelect: () => useStore.getState().updateNodeData(nodeId, { maintenance: !maintenance }),
      },
      {
        label: locked ? 'Unlock' : 'Lock',
        onSelect: () => useStore.getState().updateNodeData(nodeId, { locked: !locked }),
      },
      ...(selectedCount > 1
        ? ([
            ['left', 'Line up their left edges'],
            ['centre', 'Line up their centres'],
            ['right', 'Line up their right edges'],
            ['top', 'Line up their tops'],
            ['middle', 'Line up their middles'],
            ['bottom', 'Line up their bottoms'],
            ['across', 'Even the gaps across'],
            ['down', 'Even the gaps down'],
          ] as const).map(([how, label]) => ({
            label,
            onSelect: () => {
              const ids = pg.nodes.filter((n) => n.selected).map((n) => n.id);
              const moved = useStore.getState().arrange(ids, how);
              useStore.getState().setStatusMessage(
                moved === 0
                  ? 'They are already arranged that way.'
                  : `Moved ${t('plural.object', { count: moved })}.`,
              );
            },
          }))
        : []),
      ...(members.length > 1
        ? [
            {
              label: `Fold this group into one box (${members.length} objects)`,
              onSelect: () => {
                const group = (
                  pg.nodes.find((n) => n.id === nodeId)?.data as { groupId?: string }
                )?.groupId;
                if (group) setFolded((was) => new Set(was).add(group));
              },
            },
            {
              label: `Ungroup (${members.length} objects)`,
              onSelect: () => useStore.getState().ungroup(nodeId),
            },
          ]
        : selectedCount > 1
          ? [{ label: `Group ${selectedCount} objects`, onSelect: () => useStore.getState().groupSelected() }]
          : []),
      // The whole selection when this is part of one.
      { label: 'Bring to front (Ctrl+Shift+])', onSelect: () => reorder(nodeId, 'front') },
      { label: 'Bring forward (Ctrl+])', onSelect: () => reorder(nodeId, 'forward') },
      { label: 'Send backward (Ctrl+[)', onSelect: () => reorder(nodeId, 'backward') },
      { label: 'Send to back (Ctrl+Shift+[)', onSelect: () => reorder(nodeId, 'back') },
      {
        label: 'Delete',
        danger: true,
        onSelect: () => {
          useStore.getState().select(nodeId, null);
          useStore.getState().deleteSelected();
        },
      },
    ];
  };

  /** Restacks an object — or the selection it belongs to — as one undo step.
   *  */
  const reorder = useCallback(
    (nodeId: string | null, how: Restack) => {
      const selected = pg.nodes.filter((n) => n.selected).map((n) => n.id);
      const ids = new Set(nodeId && !selected.includes(nodeId) ? [nodeId] : selected);
      const nodes = restack(pg.nodes, ids, how);
      if (sameOrder(nodes, pg.nodes)) return;
      useStore.getState().commit();
      useStore.setState((s) => ({ doc: withPage(s.doc, { nodes }), dirty: true }));
    },
    [pg.nodes],
  );

  const edgeMenu = (edgeId: string): MenuItem[] => {
    const edge = pg.edges.find((e) => e.id === edgeId);
    const data = edge?.data;
    return [
      { label: 'Edit link properties', onSelect: () => useStore.getState().select(null, edgeId) },
      {
        label: 'Reverse flow direction',
        onSelect: () =>
          useStore.getState().updateEdgeData(edgeId, {
            direction: data?.direction === 'forward' ? 'reverse' : 'forward',
          }),
      },
      {
        label: 'Cycle path type',
        onSelect: () => {
          const order = ['smoothstep', 'bezier', 'step', 'straight', 'auto'] as const;
          const current = (data?.pathType === 'avoid' ? 'auto' : data?.pathType ?? 'smoothstep') as (typeof order)[number];
          const next = order[(order.indexOf(current) + 1) % order.length]!;
          useStore.getState().updateEdgeData(edgeId, { pathType: next });
        },
      },
      // Hand a link back to auto-routing.
      ...(data?.waypoints?.length
        ? [{ label: 'Reset routing', onSelect: () => useStore.getState().updateEdgeData(edgeId, { waypoints: [] }) }]
        : []),
      // Back to the look the operator chose — colour, path, flow,
      // width, line style — leaving the ports, label and health rule alone.
      {
        label: 'Reset to default style',
        onSelect: () => {
          useStore.getState().commit();
          useStore.getState().updateEdgeData(edgeId, resetToDefault(pg.canvas.linkStyle));
        },
      },
      {
        label: 'Save this style as the default',
        onSelect: () => {
          if (!data) return;
          useStore.getState().setDefaultLinkStyle(styleOf(data));
          useStore.getState().setStatusMessage('New links will look like this one, on every page.');
        },
      },
      {
        label: data?.maintenance ? 'Clear maintenance' : 'Set maintenance',
        onSelect: () => useStore.getState().updateEdgeData(edgeId, { maintenance: !data?.maintenance }),
      },
      {
        label: 'Delete',
        danger: true,
        onSelect: () => {
          useStore.getState().select(null, edgeId);
          useStore.getState().deleteSelected();
        },
      },
    ];
  };

  const paneMenu = (clientX: number, clientY: number): MenuItem[] => {
    const p = rf.screenToFlowPosition({ x: clientX, y: clientY });
    return [
      { label: 'Add note', onSelect: () => useStore.getState().addNode(makeNote(p.x, p.y)) },
      { label: 'Add change note', onSelect: () => useStore.getState().addNode(makeNote(p.x, p.y, 'change')) },
      { label: 'Add sticky note', onSelect: () => useStore.getState().addNode(makeNote(p.x, p.y, 'sticky')) },
      { label: 'Add container', onSelect: () => useStore.getState().addNode(makeDeviceNode('site', p.x, p.y)) },
      {
        label: 'Paste in place (Ctrl+Shift+V)',
        disabled: !canPaste(),
        onSelect: () => useStore.getState().pasteInPlace(),
      },
      { label: 'Fit view', onSelect: () => fitEverything() },
      { label: 'Zoom to selection', onSelect: () => zoomToSelection() },
      {
        label: doc.gridSnap ? 'Stop snapping to the grid (Ctrl+Shift+G)' : 'Snap to the grid (Ctrl+Shift+G)',
        onSelect: () => useStore.getState().setGridSnap(!doc.gridSnap),
      },
      { label: 'Save this view', onSelect: () => saveViewpoint() },
      ...(pg.canvas.viewpoints ?? []).map((v, i) => ({
        label: `Go to ${v.name}${i < 9 ? ` (Alt+${i + 1})` : ''}`,
        onSelect: () => void goToViewpoint(i),
      })),
      ...(pg.canvas.viewpoints ?? []).map((v) => ({
        label: `Forget ${v.name}`,
        onSelect: () =>
          useStore.getState().setCanvas({ viewpoints: (pg.canvas.viewpoints ?? []).filter((x) => x.id !== v.id) }),
      })),
      { label: 'Present (F5)', onSelect: () => useStore.getState().setPresenting(true) },
      {
        label: pg.canvas.minimapHealth ? 'Draw the minimap plain' : 'Colour the minimap by health',
        onSelect: () => useStore.getState().setCanvas({ minimapHealth: !pg.canvas.minimapHealth }),
      },
      {
        label: 'Fit page to content',
        onSelect: () => {
          // The one deliberate shrink. Growth is automatic; going back is not,
          // because a sheet that snaps smaller on its own makes the layout
          // jump under the pointer.
          useStore.getState().setCanvas({ sheetRect: pageForContent(pg.nodes) });
          useStore.getState().setStatusMessage('The page now fits what is on it.');
        },
      },
      { label: 'Find a device…', onSelect: () => setFinding(true) },
      ...(folded.size > 0
        ? [
            {
              label: `Open all folded groups (${folded.size})`,
              onSelect: () => setFolded(new Set()),
            },
          ]
        : []),
      {
        label: pg.canvas.gridEnabled ? 'Hide grid' : 'Show grid',
        onSelect: () => useStore.getState().setCanvas({ gridEnabled: !pg.canvas.gridEnabled }),
      },
      {
        label:
          (pg.canvas.nodeStyle ?? 'glyph') === 'glyph'
            ? 'Draw devices as cards'
            : 'Draw devices as symbols',
        onSelect: () =>
          useStore.getState().setCanvas({
            nodeStyle: (pg.canvas.nodeStyle ?? 'glyph') === 'glyph' ? 'card' : 'glyph',
          }),
      },
      {
        // Every link back on the page's default path, routed afresh.
        label: 'Re-route all links',
        onSelect: () => {
          const n = useStore.getState().rerouteAll();
          useStore.getState().setStatusMessage(n === 0 ? 'No links to re-route.' : `Re-routed ${t('plural.link', { count: n })} on the page's default path. Undo puts them back.`);
        },
      },
      {
        label: 'Tidy the layout',
        onSelect: () => {
          const { moved, rows, locked } = useStore.getState().tidyLayout();
          useStore.getState().setStatusMessage(
            moved === 0
              ? 'Nothing to tidy — the spacing is already even.'
              : `Evened out ${t('plural.device', { count: moved })} across ${t('plural.row', { count: rows })}. Nothing was rearranged.` +
                (locked ? ` ${t('plural.lockedDevice', { count: locked })} left alone.` : ''),
          );
        },
      },
      // The other layouts, each one undo step.
      ...([
        ['radial', 'Lay out radially, core in the middle'],
        ['force', 'Lay out as a mesh (force-directed)'],
        ['orthogonal', 'Lay out on a grid (orthogonal)'],
      ] as const).map(([kind, label]) => ({
        label,
        onSelect: () => useStore.getState().setStatusMessage(layoutMessage(useStore.getState().autoLayout(kind))),
      })),
      {
        // The other half of the pair. Tidy keeps the arrangement and fixes the
        // spacing; this replaces the arrangement, which is what a crawled or
        // imported topology usually needs and a hand-drawn one usually does
        // not. Named for what it produces rather than for the algorithm.
        label: t('canvasTools.arrangeLayers'),
        onSelect: () => useStore.getState().setStatusMessage(arrangeByLayerMessage(useStore.getState().flowLayout())),
      },
      ...(['health', 'role', 'subnet', 'tag', 'vlan'] as const)
        .filter((by) => by !== (pg.canvas.colourBy ?? 'health'))
        .map((by) => ({
          label:
            by === 'health'
              ? 'Colour devices by health'
              : by === 'role'
                ? 'Colour devices by what they are'
                : by === 'vlan'
                ? 'Colour devices by VLAN'
                : `Colour devices by ${by}`,
          onSelect: () => useStore.getState().setCanvas({ colourBy: by }),
        })),
      {
        // Outline or solid glyphs for the whole page.
        label: (pg.canvas.glyphVariant ?? 'outline') === 'solid' ? 'Draw devices as outlines' : 'Draw devices as solid tiles',
        onSelect: () =>
          useStore.getState().setCanvas({ glyphVariant: (pg.canvas.glyphVariant ?? 'outline') === 'solid' ? 'outline' : 'solid' }),
      },
      {
        label: (pg.canvas.lineJumps ?? true) ? 'Stop hopping crossed links' : 'Hop crossed links',
        onSelect: () =>
          useStore.getState().setCanvas({ lineJumps: !(pg.canvas.lineJumps ?? true) }),
      },
      {
        label: 'Let every link follow its devices',
        onSelect: () => {
          const freed = useStore.getState().unpinLinks();
          useStore.getState().setStatusMessage(
            freed === 0
              ? 'Every link already follows its devices.'
              : `${t('plural.link', { count: freed })} released. They will swing round to the ` +
                'nearer side as you move things.',
          );
        },
      },
      {
        label: 'Group each subnet together',
        onSelect: () => {
          const { groups, ungrouped } = useStore.getState().groupBySubnet();
          useStore.getState().setStatusMessage(
            groups === 0
              ? 'Nothing to group — no two devices share a /24.'
              : `Grouped ${t('plural.subnet', { count: groups })}. Dragging one device now moves its whole subnet.` +
                (ungrouped ? ` ${t('plural.device', { count: ungrouped })} left ungrouped.` : ''),
          );
        },
      },
      {
        label: settings.minimap ? 'Hide the overview box' : 'Show the overview box',
        onSelect: () => useStore.getState().setSettings({ minimap: !settings.minimap }),
      },
    ];
  };

  /** Double-click on bare canvas puts text where you clicked and starts
   *  typing. Every drawing tool does this, and the alternative — find the
   *  palette, drag a text shape out, double-click it — is three steps to
   *  write a word.
   *
   *  A native listener in the capture phase, because React Flow does not let
   *  a double-click on the pane reach anything above it: the React handler on
   *  the wrapper never ran, and nothing said why. */
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const write = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // Only on the canvas itself. Double-clicking a device renames it, and
      // dropping a text box on the thing being renamed is a surprise.
      if (!target?.classList.contains('react-flow__pane')) return;
      const at = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const node = makeDeviceNode('text', at.x - 60, at.y - 14);
      (node.data as DeviceNodeData).label = 'Text';
      node.width = 140;
      node.height = 30;
      useStore.getState().addNode(node);
      useStore.getState().beginEditing(node.id);
    };
    el.addEventListener('dblclick', write, true);
    return () => el.removeEventListener('dblclick', write, true);
  }, [rf]);

  /** Fit the sheet, not just what is on it.
   *
   *  Fitting to the devices alone puts the page edge off-screen, so the one
   *  thing that says where the drawing surface is cannot be seen. When the
   *  page is off, there is nothing to fit but the devices. */
  const fitEverything = useCallback(() => {
    if (!(pg.canvas.sheet ?? true)) {
      // A fit keeps the old ceiling: the wheel's walls were opened, and
      // unbounded fitting turns two close devices into a monitor-filling
      // glyph.
      rf.fitView({ padding: 0.2, maxZoom: 2 });
      return;
    }
    // The same rect the page renderer draws — one function, not two copies.
    const sheet = effectivePage(pg.canvas.sheetRect, pg.nodes);
    rf.fitBounds({ x: sheet.x, y: sheet.y, width: sheet.w, height: sheet.h }, { padding: 0.08 });
    if (rf.getZoom() > 2) rf.zoomTo(2);
  }, [pg.canvas.sheet, pg.canvas.sheetRect, pg.nodes, rf]);

  /** Fit what is selected, not the whole sheet. */
  const zoomToSelection = useCallback(() => {
    const sel = pg.nodes.filter((n) => n.selected);
    if (sel.length === 0) {
      useStore.getState().setStatusMessage('Select something to zoom to.');
      return;
    }
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const n of sel) {
      const w = n.width ?? n.measured?.width ?? 76;
      const h = n.height ?? n.measured?.height ?? 76;
      x1 = Math.min(x1, n.position.x);
      y1 = Math.min(y1, n.position.y);
      x2 = Math.max(x2, n.position.x + w);
      y2 = Math.max(y2, n.position.y + h);
    }
    rf.fitBounds({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, { padding: 0.3 });
    if (rf.getZoom() > 2) rf.zoomTo(2);
  }, [pg.nodes, rf]);

  /** What the palette can do after `>`. */
  const paletteCommands: PaletteCommand[] = useMemo(() => {
    const s = useStore.getState;
    const tab = (id: string, label: string): PaletteCommand => ({ id: `tab-${id}`, label: `Open ${label}`, hint: 'Bottom panel', run: () => s().requestPanelTab(id) });
    return [
      { id: 'fit', label: 'Fit the page', run: () => fitEverything() },
      { id: 'zoom-sel', label: 'Zoom to selection', run: () => zoomToSelection() },
      { id: 'find', label: 'Find on this page', hint: 'Ctrl+F', run: () => setFinding(true) },
      { id: 'present', label: 'Present', hint: 'F5', run: () => s().setPresenting(true) },
      { id: 'undo', label: 'Undo', hint: 'Ctrl+Z', run: () => s().undo() },
      { id: 'redo', label: 'Redo', hint: 'Ctrl+Y', run: () => s().redo() },
      { id: 'save', label: 'Save', hint: 'Ctrl+S', run: () => void s().saveProject() },
      { id: 'grid', label: 'Toggle snapping to the grid', hint: 'Ctrl+Shift+G', run: () => s().setGridSnap(!s().doc.gridSnap) },
      { id: 'page', label: 'Add a page', run: () => s().addPage('Page') },
      { id: 'arrange', label: t('canvasTools.arrangeLayers'), run: () => s().setStatusMessage(arrangeByLayerMessage(s().flowLayout())) },
      { id: 'start', label: 'Start checks', run: () => void s().startValidation() },
      { id: 'stop', label: 'Stop validation', run: () => void s().stopValidation() },
      { id: 'help', label: 'Keyboard shortcuts', hint: '?', run: () => setHelp(true) },
      tab('discover', 'Ping sweep'),
      tab('crawl', 'Discover devices'),
      tab('path', 'Path check'),
      // These four are a screen now, so they are named the same and
      // go straight there. `requestPanelTab` still redirects them for anything
      // that asks for the old tab.
      { id: 'tab-racks', label: 'Open Racks', hint: 'Tools', run: () => s().setToolsOpen(true, 'racks') },
      { id: 'tab-compare', label: 'Open Compare', hint: 'Tools', run: () => s().setToolsOpen(true, 'compare') },
      { id: 'tab-csv', label: 'Open From a file', hint: 'Tools', run: () => s().setToolsOpen(true, 'csv') },
      { id: 'tab-visio', label: 'Open From a drawing', hint: 'Tools', run: () => s().setToolsOpen(true, 'visio') },
      tab('events', 'Event timeline'),
    ];
  }, [fitEverything, zoomToSelection]);

  // Something asked for the page to be fitted — landing on a
  // generated application page showing one corner of it is a poor arrival.
  //
  // The fit runs when the *request number* changes, and nothing else.
  // `fitEverything` is rebuilt whenever `pg.nodes` changes identity, and a
  // selection does exactly that — so listing it here re-fitted the sheet on
  // every click on a device, throwing away wherever the person had put the
  // canvas. It is read through a ref so the effect always calls the current
  // one without depending on it.
  const fitEverythingRef = useRef(fitEverything);
  fitEverythingRef.current = fitEverything;
  const fitRequest = useStore((s) => s.fitRequest);
  useEffect(() => {
    if (fitRequest === 0) return;
    // After the page has been laid out, or it fits the one before it.
    const timer = setTimeout(() => fitEverythingRef.current(), 60);
    return () => clearTimeout(timer);
  }, [fitRequest]);

  /** Remember where the viewport is, as "View N" on this page. */
  const saveViewpoint = useCallback(() => {
    const list = pg.canvas.viewpoints ?? [];
    const taken = new Set(list.map((v) => v.name));
    let n = list.length + 1;
    while (taken.has(`View ${n}`)) n += 1;
    const name = `View ${n}`;
    const { x, y, zoom } = rf.getViewport();
    useStore.getState().setCanvas({ viewpoints: [...list, { id: uid(), name, x, y, zoom }] });
    const place = list.length + 1;
    useStore.getState().setStatusMessage(
      place <= 9 ? `Saved ${name}. Alt+${place} comes back to it.` : `Saved ${name}. The canvas menu comes back to it.`,
    );
  }, [pg.canvas.viewpoints, rf]);

  const goToViewpoint = useCallback(
    (index: number) => {
      const v = (pg.canvas.viewpoints ?? [])[index];
      if (!v) return false;
      void rf.setViewport({ x: v.x, y: v.y, zoom: v.zoom }, { duration: 250 });
      return true;
    },
    [pg.canvas.viewpoints, rf],
  );

  // Space held is "grab the diagram". Kept separate from the shortcut handler
  // below because it has to watch both the press and the release, and must
  // not fire while someone is typing a device name.
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return Boolean(
        el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable),
      );
    };
    // Shift is the other hand, and the one people reach for first:
    // it used to draw React Flow's selection box, which a plain drag
    // on the pane already does, so nothing is lost by making it pan. Not while
    // Alt is down — Alt+Shift is the lasso that adds to a selection.
    const hand = (e: KeyboardEvent) =>
      e.code === 'Space' ||
      // Not with Ctrl or Cmd: Ctrl+Shift+[ and friends are shortcuts, and the
      // hand appearing under them for as long as the keys are down is noise.
      (e.key === 'Shift' && !e.altKey && !altDown.current && !e.ctrlKey && !e.metaKey);
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        altDown.current = true;
        // Shift first and Alt second is a lasso that adds to the selection,
        // pressed in the other order; let go of the diagram and leave the
        // canvas to it, unless a pan is already under way.
        if (!panFrom.current) setPanning(false);
      }
      if (!hand(e) || e.repeat || typing(e.target)) return;
      // Space scrolls the page otherwise, which on a canvas means nothing
      // visible happens and the diagram jumps.
      e.preventDefault();
      setPanning(true);
      // The button went down a moment before space, as happens when
      // both are pressed together. React Flow has already begun a selection
      // box; stop it, drop whatever it caught, and pan from here instead.
      const held = pointerHeld.current;
      if (held && !panFrom.current) {
        rfStore.setState({ userSelectionActive: false, userSelectionRect: null, nodesSelectionActive: false });
        rfStore.getState().resetSelectedElements();
        grabAt(held.x, held.y);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altDown.current = false;
      if (e.code !== 'Space' && e.key !== 'Shift') return;
      // A drag already under way keeps going until the *button* is released.
      // Space starts the hand; letting go of it half way through a
      // drag is what everyone does, and tearing the hand away there left the
      // diagram sliding to a stop under the cursor instead of following it.
      if (panFrom.current) {
        releaseAfterDrag.current = true;
        return;
      }
      setPanning(false);
    };
    // Releasing space while the window is not focused would otherwise leave
    // the canvas stuck in panning.
    const blur = () => {
      altDown.current = false;
      panFrom.current = null;
      releaseAfterDrag.current = false;
      setPanning(false);
    };
    // Where a held button is now, so a pan that starts mid-drag starts from
    // the pointer rather than from where the button first went down.
    const track = (e: PointerEvent) => {
      if (pointerHeld.current) pointerHeld.current = { x: e.clientX, y: e.clientY };
    };
    const release = () => {
      pointerHeld.current = null;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('pointermove', track);
    window.addEventListener('pointerup', release);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', release);
    };
  }, [grabAt, rf, rfStore]);

  // In zoom mode, Shift+wheel scrolls the sheet — the wheel's one
  // other job — ahead of React Flow's own listener, which would zoom.
  const wheelMode = useStore((s) => s.settings.wheel);
  useEffect(() => {
    if (wheelMode !== 'zoom') return;
    // On the canvas wrapper, in the capture phase: React Flow's own wheel
    // listener is on the pane inside it, a listener on the same element
    // could not get ahead of it, and while Shift is held the pan sheet
    // lies over the pane and would take the event first.
    const pane = document.querySelector<HTMLElement>('.cv-canvas');
    if (!pane) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const v = rf.getViewport();
      // A mouse gives the whole scroll as deltaY; Shift turns it sideways
      // when nothing else is sideways, the way a document scrolls.
      const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      const dy = e.deltaX !== 0 ? e.deltaY : 0;
      void rf.setViewport({ x: v.x - dx, y: v.y - dy, zoom: v.zoom });
    };
    pane.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => pane.removeEventListener('wheel', onWheel, { capture: true });
  }, [wheelMode, rf]);

  // Printing at 1:1 — the sheet's corner at the paper's, one unit
  // to 1/144 inch — for the length of the print job, then back.
  const printScale = useStore((s) => s.settings.printScale);
  const printingNow = useStore((s) => s.printing);
  useEffect(() => {
    if (!printingNow || printScale !== 'actual') return;
    const was = rf.getViewport();
    const sheet = effectivePage(pg.canvas.sheetRect, pg.nodes);
    void rf.setViewport({ x: -sheet.x * PRINT_ACTUAL_ZOOM, y: -sheet.y * PRINT_ACTUAL_ZOOM, zoom: PRINT_ACTUAL_ZOOM });
    return () => { void rf.setViewport(was); };
    // The sheet at the moment printing starts is the one that goes on paper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printingNow, printScale, rf]);

  // Keyboard shortcuts. Ignored while typing in a field.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      // Ctrl+Alt+letter arranges a multiple selection — the keyboard half of
      // the context menu's align and distribute.
      if (mod && e.altKey) {
        const how = ({
          l: 'left', c: 'centre', r: 'right',
          t: 'top', m: 'middle', b: 'bottom',
          h: 'across', v: 'down',
        } as const)[e.key.toLowerCase() as 'l'];
        if (how) {
          const ids = pg.nodes.filter((n) => n.selected).map((n) => n.id);
          if (ids.length > 1) {
            e.preventDefault();
            const moved = useStore.getState().arrange(ids, how);
            useStore.getState().setStatusMessage(
              moved === 0
                ? 'They are already arranged that way.'
                : `Moved ${t('plural.object', { count: moved })}.`,
            );
            return;
          }
        }
      }
      // In presentation the keys are for moving between pages and
      // leaving; nothing edits the diagram.
      if (presenting) {
        const pages = doc.pages;
        const at = pages.findIndex((p) => p.id === doc.activePageId);
        if (e.key === 'Escape' || e.key === 'F5') {
          e.preventDefault();
          useStore.getState().setPresenting(false);
        } else if (['PageDown', 'ArrowRight', 'ArrowDown', ' '].includes(e.key)) {
          e.preventDefault();
          const next = pages[Math.min(pages.length - 1, Math.max(0, at) + 1)];
          if (next) useStore.getState().setActivePage(next.id);
        } else if (['PageUp', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
          e.preventDefault();
          const prev = pages[Math.max(0, at - 1)];
          if (prev) useStore.getState().setActivePage(prev.id);
        } else if (e.key === 'f' || e.key === 'F') {
          fitEverything();
        }
        return;
      }
      if (e.key === 'F5') {
        e.preventDefault();
        useStore.getState().setPresenting(true);
        return;
      }
      // Ctrl+PageUp/PageDown steps through the pages.
      if (mod && (e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault();
        const pages = doc.pages;
        const at = Math.max(0, pages.findIndex((p) => p.id === doc.activePageId));
        const to = pages[Math.min(pages.length - 1, Math.max(0, at + (e.key === 'PageDown' ? 1 : -1)))];
        if (to) useStore.getState().setActivePage(to.id);
        return;
      }
      // Alt+1…9 goes back to a saved view on this page.
      if (e.altKey && !mod && /^Digit[1-9]$/.test(e.code)) {
        if (goToViewpoint(Number(e.code.slice(5)) - 1)) e.preventDefault();
        return;
      }
      if (mod && !e.altKey && (e.key === '=' || e.key === '+')) {
        // Ctrl+= in, Ctrl+− out, Ctrl+0 actual size.
        e.preventDefault();
        void rf.zoomIn({ duration: 120 });
      } else if (mod && !e.altKey && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        void rf.zoomOut({ duration: 120 });
      } else if (mod && !e.altKey && !e.shiftKey && e.key === '0') {
        e.preventDefault();
        void rf.zoomTo(1, { duration: 150 });
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        useStore.getState().selectAll();
      } else if (mod && e.key.toLowerCase() === 'c') {
        const copied = useStore.getState().copySelection();
        if (copied > 0) {
          e.preventDefault();
          useStore.getState().setStatusMessage(`Copied ${t('plural.object', { count: copied })}.`);
        }
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        const pasted = useStore.getState().pasteInPlace();
        useStore.getState().setStatusMessage(
          pasted > 0 ? `Pasted ${t('plural.object', { count: pasted })} where they were copied from.` : 'Nothing has been copied.',
        );
      } else if (mod && e.key.toLowerCase() === 'v') {
        const pasted = useStore.getState().paste();
        if (pasted > 0) {
          e.preventDefault();
          useStore.getState().setStatusMessage(`Pasted ${t('plural.object', { count: pasted })}.`);
        }
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        const on = !doc.gridSnap;
        useStore.getState().setGridSnap(on);
        useStore.getState().setStatusMessage(on ? 'Snapping to the grid.' : 'Not snapping to the grid.');
      } else if (mod && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        // Ctrl+] / Ctrl+[ a step, with Shift all the way.
        e.preventDefault();
        const up = e.code === 'BracketRight';
        reorder(null, e.shiftKey ? (up ? 'front' : 'back') : up ? 'forward' : 'backward');
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFinding(true);
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void useStore.getState().saveProject();
      } else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        useStore.getState().undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        useStore.getState().redo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const sel = pg.nodes.find((n) => n.selected);
        if (sel) {
          // Offset by one grid step, and the copy takes the selection — the
          // original must let go of it, or the next Delete removes both.
          useStore.getState().selectNone();
          useStore.getState().addNode({
            ...sel,
            id: uid(),
            position: { x: sel.position.x + 60, y: sel.position.y + 60 },
            selected: true,
          } as TopoNode);
        }
      } else if (e.key.startsWith('Arrow') && e.altKey && !mod) {
        // Alt+arrow goes to the nearest device that way; with nothing
        // selected, to the device nearest the middle of the view.
        e.preventDefault();
        const boxes = pg.nodes
          .filter((n) => n.type === 'note' || (n.data as DeviceNodeData).deviceType !== 'zone')
          .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.width ?? n.measured?.width ?? 76, h: n.height ?? n.measured?.height ?? 76 }));
        const selectedNow = pg.nodes.filter((n) => n.selected);
        const wrap = document.querySelector('.cv-canvas')?.getBoundingClientRect();
        const middle = rf.screenToFlowPosition({ x: (wrap?.left ?? 0) + (wrap?.width ?? 800) / 2, y: (wrap?.top ?? 0) + (wrap?.height ?? 600) / 2 });
        const dir = e.key.slice(5).toLowerCase() as Direction;
        const target = selectedNow.length === 1 ? nearestInDirection(boxes, selectedNow[0]!.id, dir) : nearestTo(boxes, middle.x, middle.y);
        if (!target) return;
        useStore.getState().onNodesChange(pg.nodes.map((n) => ({ type: 'select' as const, id: n.id, selected: n.id === target })));
        useStore.getState().select(pg.nodes.find((n) => n.id === target)?.type === 'note' ? null : target, null);
        const b = boxes.find((x) => x.id === target)!;
        const { x: vx, y: vy, zoom } = rf.getViewport();
        const sx = b.x * zoom + vx;
        const sy = b.y * zoom + vy;
        if (wrap && (sx < 40 || sy < 40 || sx + b.w * zoom > wrap.width - 40 || sy + b.h * zoom > wrap.height - 40)) {
          void rf.setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom, duration: 200 });
        }
        // Announced for a screen reader through the live status line.
        const d = pg.nodes.find((n) => n.id === target)?.data as DeviceNodeData | undefined;
        useStore.getState().setStatusMessage(`${d?.label ?? 'Note'} selected`);
      } else if (e.key.startsWith('Arrow') && !mod) {
        // Arrows nudge by a pixel, Shift-arrows by a grid step. The keyboard
        // is how the last two pixels of a layout actually get done.
        const ids = pg.nodes
          .filter((n) => n.selected && !(n.data as { locked?: boolean }).locked)
          .map((n) => n.id);
        if (ids.length > 0) {
          e.preventDefault();
          const step = e.shiftKey ? 60 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          useStore.getState().onNodesChange(
            pg.nodes
              .filter((n) => ids.includes(n.id))
              .map((n) => ({
                id: n.id,
                type: 'position' as const,
                position: { x: n.position.x + dx, y: n.position.y + dy },
              })),
          );
        }
      } else if (e.key === 'Escape') {
        // Layered: the first Escape closes what is on top, the next clears
        // the selection. One key, nearest thing first.
        if (help) {
          setHelp(false);
          return;
        }
        if (useStore.getState().focus) {
          useStore.getState().setFocus(null);
          return;
        }
        useStore.getState().selectNone();
        setGuides([]);
      } else if (e.key === '?') {
        e.preventDefault();
        setHelp((h) => !h);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        useStore.getState().deleteSelected();
      } else if (e.key === 'F' && e.shiftKey && !mod) {
        zoomToSelection();
      } else if (e.key === 'f' && !mod) {
        fitEverything();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pg.nodes, rf, fitEverything, help, zoomToSelection, goToViewpoint, reorder, doc.activePageId, doc.gridSnap, doc.pages, presenting]);

  // React Flow decides whether a node can be dragged from a `draggable` field
  // on the node itself. `locked` lives in `data`, which it never looks at, so
  // "Lock position" hid the resize handles — the one part DeviceNode reads
  // directly — and left the node as draggable as before.
  // While a drag is in flight the canvas draws from its own copy of
  // the page's nodes, and the document is written once, on release — see
  // src/state/dragOverlay.ts for why.
  const [dragNodes, setDragNodes] = useState<TopoNode[] | null>(null);
  const dragNodesRef = useRef<TopoNode[] | null>(null);
  const printing = useStore((s) => s.printing);
  const liveNodes = dragNodes ?? pg.nodes;

  const view = useMemo(() => {
    // Hidden views come out first: everything after this — folding, routing,
    // hops — should be reasoning about the diagram as it is being looked at.
    // While printing, the views set not to print come out too.
    const layers = layersOf(pg.canvas.layers);
    const shows = printing ? isPrinted : isVisible;
    const anyHidden = printing ? !allPrinted(layers) : layers.some((l) => !l.visible);
    const nodes = anyHidden
      ? liveNodes.filter((n) => shows((n.data as { layers?: string[] }).layers, layers))
      : liveNodes;
    const alive = new Set(nodes.map((n) => n.id));
    const edges = anyHidden
      ? pg.edges.filter(
          (e) =>
            shows((e.data as { layers?: string[] } | undefined)?.layers, layers) &&
            // A link whose device is on a hidden view has nowhere to land.
            alive.has(e.source) &&
            alive.has(e.target),
        )
      : pg.edges;

    const folded_ = collapseView(nodes, edges, folded);
    // Routed after folding, so a link redrawn to a folded box leaves the side
    // of the box that faces where it is going.
    return { nodes: folded_.nodes, edges: routeForView(folded_.nodes, folded_.edges) };
  }, [liveNodes, pg.edges, pg.canvas.layers, folded, printing]);

  // What each node was turned into last time, keyed on the node itself.
  // A new object for every node on every change told React Flow that all of
  // them had changed, so every device re-rendered on every frame of a drag of
  // one of them. An unchanged node now keeps its object.
  // What the filter or focus leaves lit. Status is only
  // listened to when the filter asks about it.
  const canvasFilter = useStore((s) => s.canvasFilter);
  const focus = useStore((s) => s.focus);
  const statusTick = useStore((s) => (s.canvasFilter?.status ? s.runtime : null));
  const lit = useMemo(
    () => litNodes(view.nodes, view.edges, canvasFilter, focus, (id) => useStore.getState().nodeStatus(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view.nodes, view.edges, canvasFilter, focus, statusTick],
  );
  // With *Hide what does not match* ticked, the same match takes the
  // rest off the page instead of fading it. Nothing is deleted — `view.nodes`
  // is the drawing, not the document — and clearing the filter brings it all
  // back. A section (zone) always matches, so the backdrop never vanishes from
  // under the devices standing on it.
  const hiding = hidingUnmatched(canvasFilter) && lit !== null;
  // And whatever is folded away behind a collapsed device. The two
  // are independent — a device can be filtered out, folded away, or both —
  // so they are one set of ids to leave out of the drawing.
  const collapsed = useStore((s) => s.collapsed);
  const foldedBranches = useMemo(
    () => (collapsed.length > 0 ? hiddenByAll(collapsed, view.nodes, view.edges) : null),
    [collapsed, view.nodes, view.edges],
  );
  const shownNodes = useMemo(
    () =>
      view.nodes.filter(
        (n) => !(hiding && lit && !lit.has(n.id)) && !(foldedBranches && foldedBranches.has(n.id)),
      ),
    [view.nodes, hiding, lit, foldedBranches],
  );
  const derived = useRef(new WeakMap<TopoNode, { zIndex: number; locked: boolean; dimmed: boolean; holding: number; out: TopoNode }>());
  const nodes = useMemo(
    () =>
      shownNodes.map((n, i) => {
        const layers = layersOf(pg.canvas.layers);
        const locked =
          Boolean((n.data as { locked?: boolean }).locked) ||
          !isEditable((n.data as { layers?: string[] }).layers, layers);
        // A section is a backdrop: it has to sit under the devices standing
        // in it, or it covers them and the diagram is a set of empty boxes.
        //
        // Everything else takes its stacking from its position in the
        // document's own node array rather than a flat 1 for
        // every node. React Flow keeps its own node lookup as a Map keyed
        // by id and updates entries in place — re-ordering the array we
        // pass it does not move anything in that Map's iteration order, so
        // "Bring forward"/"Send backward" (which only ever reordered the
        // array) were changing nothing anyone could see. An explicit,
        // array-position-derived zIndex is what actually drives paint
        // order, and it does respond to that reorder.
        const zIndex = (n.data as { deviceType?: string }).deviceType === 'zone' ? 0 : i + 1;
        // Nothing on the page is dimmed while hiding: what would have been
        // faint is simply not here.
        const dimmed = !hiding && lit !== null && !lit.has(n.id);
        const holding = collapsed.includes(n.id) ? foldedCount(n.id, view.nodes, view.edges) : 0;
        const was = derived.current.get(n);
        if (was && was.zIndex === zIndex && was.locked === locked && was.dimmed === dimmed && was.holding === holding) return was.out;
        // What a screen reader says for it.
        const ariaLabel = nodeAriaLabel(n, (t) => DEVICE_LABEL[t as DeviceType] ?? t);
        const base = locked ? { ...n, draggable: false, zIndex, ariaLabel } : { ...n, zIndex, ariaLabel };
        // A collapsed device is marked, or a folded branch is
        // indistinguishable from a device that was never connected to
        // anything. How many it holds is in the menu item and the status
        // line, where there is room to say it in words.
        const classes = [n.className, dimmed ? 'is-dimmed' : '', holding > 0 ? 'is-collapsed' : '']
          .filter(Boolean)
          .join(' ');
        const out = dimmed || holding > 0 ? { ...base, className: classes } : base;
        derived.current.set(n, { zIndex, locked, dimmed, holding, out });
        return out;
      }),
    [shownNodes, pg.canvas.layers, lit, hiding, collapsed, view.nodes, view.edges],
  );
  // Names each link for a screen reader; Dims some. The copy is
  // kept per link object and reused while its label and dimming are unchanged,
  // so a drag does not hand React Flow a new object for every link each frame.
  const derivedEdges = useRef(new WeakMap<TopoEdge, { ariaLabel: string; dimmed: boolean; out: TopoEdge }>());
  const shownEdges = useMemo(() => {
    const names = new Map(view.nodes.map((n) => [n.id, (n.data as { label?: string; title?: string }).label ?? (n.data as { title?: string }).title ?? 'a note']));
    const nameOf = (id: string) => names.get(id) ?? 'a device';
    // A link with a hidden end has nowhere to land, so it goes with it.
    const onPage = new Set(shownNodes.map((n) => n.id));
    // A link with an end that is not drawn has nowhere to land.
    const edges = view.edges.filter((e) => onPage.has(e.source) && onPage.has(e.target));
    return edges.map((e) => {
      const ariaLabel = edgeAriaLabel(e, nameOf);
      const dimmed = !hiding && lit !== null && !(lit.has(e.source) && lit.has(e.target));
      const was = derivedEdges.current.get(e);
      if (was && was.ariaLabel === ariaLabel && was.dimmed === dimmed) return was.out;
      const out = dimmed ? { ...e, ariaLabel, className: `${e.className ?? ''} is-dimmed`.trim() } : { ...e, ariaLabel };
      derivedEdges.current.set(e, { ariaLabel, dimmed, out });
      return out;
    });
  }, [view.edges, view.nodes, lit, hiding, shownNodes]);

  const boxOf = (n: TopoNode): Box => ({
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    w: n.width ?? n.measured?.width ?? 168,
    h: n.height ?? n.measured?.height ?? 92,
  });

  /** Lines a dragged device up with the ones already placed, as the move
   *  arrives rather than after it.
   *
   *  Correcting the position from `onNodeDrag` does not hold: React Flow is
   *  mid-drag and its next event overwrites whatever was written, so the
   *  guide appeared and the device landed a few pixels out anyway. Rewriting
   *  the change on its way through is the only point at which the corrected
   *  position is the one React Flow goes on to use.
   *
   *  Grid snapping is not a substitute. It quantises to ten pixels, which is
   *  not the same as being in line — two devices can both sit on the grid and
   *  still be four pixels out from each other, and four pixels out is what a
   *  diagram looks untidy for. */
  /** Sends a batch of node changes where it belongs: positions still
   *  in flight to the drag overlay, everything else — and a drag's last
   *  position — to the document. */
  const route = useCallback(
    (changes: NodeChange<TopoNode>[]) => {
      const inFlight = (c: NodeChange<TopoNode>) => c.type === 'position' && c.dragging === true;
      const flying = changes.filter(inFlight);
      const rest = changes.filter((c) => !inFlight(c));
      const page = activePage(useStore.getState().doc);
      if (flying.length > 0) {
        // A drag is one undo step, taken as it starts — before anything
        // has moved — so one Ctrl+Z puts back everything it carried. A click
        // that moves nothing sends no position and takes no step.
        if (!dragNodesRef.current) useStore.getState().commit();
        let next = moveGroups(flying, dragNodesRef.current ?? page.nodes);
        if (rest.length > 0) {
          next = applyNodeChanges(rest, next) as TopoNode[];
          useStore.getState().onNodesChange(rest);
        }
        dragNodesRef.current = next;
        setDragNodes(next);
        const moved = new Map<string, TopoNode>();
        for (const n of next) if (pageNodeById(page, n.id)?.position !== n.position) moved.set(n.id, n);
        useDragOverlay.getState().publish(moved);
        return;
      }
      if (dragNodesRef.current) {
        dragNodesRef.current = null;
        setDragNodes(null);
        useDragOverlay.getState().publish(null);
      }
      useStore.getState().onNodesChange(changes);
    },
    [],
  );

  /** A drag that ended without its last position arriving still lands where
   *  it was dropped. */
  const flushDrag = useCallback(() => {
    const flying = dragNodesRef.current;
    if (!flying) return;
    const page = activePage(useStore.getState().doc);
    const finals = flying
      .filter((n) => pageNodeById(page, n.id)?.position !== n.position)
      .map((n) => ({ type: 'position', id: n.id, position: n.position, dragging: false }) as NodeChange<TopoNode>);
    route(finals);
  }, [route]);

  const onNodesChange = useCallback(
    (changes: NodeChange<TopoNode>[]) => {
      // Defaulted on. A document saved before this existed has no value here,
      // and reading that as "off" quietly disabled guides for every diagram
      // already drawn.
      // Grid snap is the project's setting, inverted while Alt is held;
      // Alt also refuses the guides for that drag.
      const gridOn = Boolean(useStore.getState().doc.gridSnap) !== altDown.current;
      // The grid that is drawn is the grid things land on.
      const step = snapStep(rf.getZoom());
      const toGrid = (v: number) => Math.round(v / step) * step;
      if (!(pg.canvas.snapEnabled ?? true) || altDown.current) {
        if (altDown.current) setGuides([]);
        const single = changes.filter((c) => c.type === 'position' && c.position);
        if (gridOn && single.length === 1) {
          route(
            changes.map((c) =>
              c === single[0] && c.type === 'position' && c.position
                ? { ...c, position: { x: toGrid(c.position.x), y: toGrid(c.position.y) } }
                : c,
            ),
          );
          return;
        }
        route(changes);
        return;
      }
      // Includes the last change of a drag, which arrives with `dragging`
      // already false and carries React Flow's own final position. Skipping
      // it let the guide show all the way through and then put the device
      // back where the pointer was, a few pixels out.
      const dragging = changes.filter(
        (c): c is NodeChange<TopoNode> & { id: string; position: { x: number; y: number } } =>
          c.type === 'position' && Boolean(c.position),
      );
      if (dragging.length !== 1) {
        // Nothing to line up against for a multi-selection drag: the whole
        // group is moving and its members are already in line with each other.
        if (dragging.length === 0 && changes.some((c) => c.type === 'position')) setGuides([]);
        route(changes);
        return;
      }

      const moving = dragging[0]!;
      const node = (dragNodesRef.current ?? pg.nodes).find((n) => n.id === moving.id);
      if (!node) {
        route(changes);
        return;
      }
      // In diagram units. Ten screen pixels at quarter zoom is forty units,
      // and a snap that grabs from forty away feels like the device is being
      // taken out of your hands.
      const tolerance = 7 / Math.max(0.2, rf.getZoom());
      const others = (dragNodesRef.current ?? pg.nodes).filter((n) => n.id !== moving.id && !n.selected).map(boxOf);
      const dragged = { ...boxOf(node), ...moving.position };
      const found = alignmentFor(dragged, others, tolerance);

      // Lining up is half of tidy; the other half is the gaps being equal.
      // Where both an edge and a rhythm are within reach on the same axis,
      // the one asking for the smaller correction wins: whichever the device
      // was already closer to is the one the person was aiming at.
      const settled = { x: found.x, y: found.y };
      const spacingGuides: Guide[] = [];
      const span = (from: number[], to: number[]) => ({
        from: Math.min(...from),
        to: Math.max(...to),
      });

      // "Nothing to snap to" is not a competitor: when no edge lined up,
      // found.x is just where the box already is, and comparing against that
      // zero made the rhythm unreachable except when an accidental edge
      // alignment happened to coexist.
      const xAligned = found.guides.some((g) => g.orientation === 'vertical');
      const rhythmX = spacingHint(dragged, others, 'x', tolerance);
      if (
        rhythmX !== null &&
        (!xAligned || Math.abs(rhythmX - dragged.x) <= Math.abs(found.x - dragged.x))
      ) {
        settled.x = rhythmX;
        const edges = span(
          [rhythmX, ...others.map((o) => o.x)],
          [rhythmX + dragged.w, ...others.map((o) => o.x + o.w)],
        );
        spacingGuides.push({
          orientation: 'horizontal',
          at: settled.y + dragged.h / 2,
          ...edges,
        });
      }

      const yAligned = found.guides.some((g) => g.orientation === 'horizontal');
      const rhythmY = spacingHint(dragged, others, 'y', tolerance);
      if (
        rhythmY !== null &&
        (!yAligned || Math.abs(rhythmY - dragged.y) <= Math.abs(found.y - dragged.y))
      ) {
        settled.y = rhythmY;
        const edges = span(
          [rhythmY, ...others.map((o) => o.y)],
          [rhythmY + dragged.h, ...others.map((o) => o.y + o.h)],
        );
        spacingGuides.push({
          orientation: 'vertical',
          at: settled.x + dragged.w / 2,
          ...edges,
        });
      }

      // A guide for an edge the device is no longer snapped to would be a
      // line pointing at nothing.
      const keptGuides = found.guides.filter((g) =>
        g.orientation === 'vertical' ? settled.x === found.x : settled.y === found.y,
      );

      // Guides win; where neither an edge nor a rhythm took an axis,
      // the grid does, if it is on.
      if (gridOn) Object.assign(settled, snapUnguided(settled, keptGuides, spacingGuides, snapStep(rf.getZoom())));
      setGuides([...keptGuides, ...spacingGuides]);
      route(
        changes.map((c) =>
          c === moving ? { ...c, position: { x: settled.x, y: settled.y } } : c,
        ) as NodeChange<TopoNode>[],
      );
    },
    [pg.canvas.snapEnabled, pg.nodes, rf, route],
  );


  return (
    <div
      className={`cv-canvas${panning ? ' is-panning' : ''}${far ? ' is-far' : ''}`}
      ref={wrapper}
      onPointerDownCapture={(e) => {
        if (e.button === 0) pointerHeld.current = { x: e.clientX, y: e.clientY };
        // A press on the canvas takes focus out of a panel's field.
        // Left there, a space meant for the canvas types into the field
        // instead, and the drag becomes a selection box.
        const active = document.activeElement as HTMLElement | null;
        if (
          active &&
          !wrapper.current?.contains(active) &&
          (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable)
        ) {
          active.blur();
        }
        // Alt+drag on empty canvas draws a lasso instead of a box;
        // with Shift as well, what it catches is added to the selection.
        const onPane = (e.target as HTMLElement).classList?.contains('react-flow__pane');
        if (e.button === 0 && e.altKey && onPane && wrapper.current) {
          e.stopPropagation();
          e.preventDefault();
          const origin = wrapper.current.getBoundingClientRect();
          const adding = e.shiftKey;
          const screen: Point[] = [{ x: e.clientX, y: e.clientY }];
          let outline: Point[] = [{ x: e.clientX - origin.left, y: e.clientY - origin.top }];
          setLasso(outline);
          const move = (ev: PointerEvent) => {
            const next = addPoint(outline, { x: ev.clientX - origin.left, y: ev.clientY - origin.top });
            if (next !== outline) {
              outline = next;
              screen.push({ x: ev.clientX, y: ev.clientY });
              setLasso(outline);
            }
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            setLasso(null);
            const flow = screen.map((p) => rf.screenToFlowPosition(p));
            const caught = new Set(lassoed(activePage(useStore.getState().doc).nodes, flow));
            const nodes = activePage(useStore.getState().doc).nodes;
            useStore.getState().onNodesChange(
              nodes
                .filter((n) => (adding ? caught.has(n.id) && !n.selected : Boolean(n.selected) !== caught.has(n.id)))
                .map((n) => ({ type: 'select', id: n.id, selected: caught.has(n.id) || (adding && Boolean(n.selected)) })),
            );
            if (caught.size > 0) useStore.getState().setStatusMessage(`Lasso caught ${t('plural.object', { count: caught.size })}.`);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }
      }}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <EdgeMarkerDefs />
      <TraceFade />
      {lasso && lasso.length > 1 && (
        <svg className="cv-lasso" aria-hidden>
          <polygon points={lasso.map((p) => `${p.x},${p.y}`).join(' ')} />
        </svg>
      )}
      <ReactFlow
        nodes={nodes}
        edges={shownEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={useStore.getState().onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={() => {
          setGuides([]);
          // After React Flow's own last change for the drag, if it sent one.
          setTimeout(flushDrag, 0);
        }}
        /* Every side of a device is a source, so a link can leave whichever
           side faces where it is going. Loose mode is what lets one of those
           sources also be the end of a link. */
        connectionMode={ConnectionMode.Loose}
        minZoom={0.01}
        maxZoom={100}
        onNodeClick={(_, n) => useStore.getState().select(n.id, null)}
        onEdgeClick={(_, e) => useStore.getState().select(null, e.id)}
        /* Double-click a spot on a link and write straight onto it.
           The empty text renders as an open caret; committing nothing removes
           it, so a stray double-click leaves no debris. */
        onEdgeDoubleClick={(event, edge) => {
          event.preventDefault();
          event.stopPropagation();
          const flow = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          const path = allPaths().get(edge.id);
          const at = (path && nearestFractionOnPath(path, flow.x, flow.y)) || 0.5;
          const texts = ((edge.data as LinkData | undefined)?.texts ?? []).concat({
            id: uid(),
            at,
            text: '',
          });
          useStore.getState().commit();
          useStore.getState().updateEdgeData(edge.id, { texts });
        }}
        onPaneClick={() => {
          useStore.getState().select(null, null);
          setMenu(null);
        }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          useStore.getState().select(n.id, null);
          setMenu({ x: e.clientX, y: e.clientY, items: nodeMenu(n.id) });
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault();
          useStore.getState().select(null, edge.id);
          setMenu({ x: e.clientX, y: e.clientY, items: edgeMenu(edge.id) });
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          const ev = e as React.MouseEvent;
          setMenu({ x: ev.clientX, y: ev.clientY, items: paneMenu(ev.clientX, ev.clientY) });
        }}
        /* No grid snap. It quantises to ten pixels, which is not the same as
           being in line — two devices can both sit on the grid and still be
           four pixels out from each other — and it fights the alignment
           guides for the last few pixels of every drag. Lining up with the
           neighbours is what people are actually trying to do. */
        /* The way Lucidchart and Visio work, because that is what anyone
           opening this already knows.
        
           Left-drag on empty canvas draws a selection box and the devices it
           catches move together. Holding space turns the pointer into a hand
           and drags the whole diagram — as does the middle button, which is
           the other thing people reach for. Shift-drag still adds to a
           selection, and Ctrl-click still picks devices one at a time. */
        /* React Flow's own arrow-key movement is off: it moved a focused node
           five pixels on top of our one-pixel nudge, so a single press walked
           a device six. Ours is the only keyboard movement. */
        disableKeyboardA11y
        panOnDrag={[1]}
        selectionOnDrag={!panning}
        selectionMode={SelectionMode.Partial}
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Control"
        /* The wheel zooms to the cursor, or scrolls like a document
           with Ctrl (or a pinch) zooming — the machine's choice. */
        zoomOnScroll={wheelMode === 'zoom'}
        panOnScroll={wheelMode === 'scroll'}
        zoomOnPinch
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ maxZoom: 2 }}
        /* React Flow is MIT, and its authors ask rather than require that the
           badge stay. It is a link out to their site sitting on top of the
           operator's diagram, and it was being mistaken for part of Coreview. */
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'live' }}
      >
        <ViewportPortal>
          {guides.map((g) => (
            <div
              key={`${g.orientation}-${g.at}-${g.from}`}
              className={`cv-guide is-${g.orientation}`}
              style={
                g.orientation === 'vertical'
                  ? { left: g.at, top: g.from, height: g.to - g.from }
                  : { top: g.at, left: g.from, width: g.to - g.from }
              }
            />
          ))}
        </ViewportPortal>
        {/* The grid is drawn inside the page now, so it stops at the paper's
            edge. React Flow's own Background painted the whole viewport, which
            is what made the desk and the page look like one surface. */}
        <Page />
        <InkStrokes />
        {settings.minimap && (
          <HealthMiniMap health={Boolean(pg.canvas.minimapHealth)} ground={ground} />
        )}
      </ReactFlow>
      {/* Rulers over the pane's edge, when the page asks for them. */}
      {(pg.canvas.rulers ?? false) && !presenting && <Rulers units={pg.canvas.rulerUnits ?? 'mm'} />}
      <ColourLegend />
      {/* Space held: a sheet over the whole canvas that takes the drag and
          moves the viewport itself.
      
          React Flow's own `panOnDrag` cannot do this, because a drag that
          begins over a device is captured by the device before the pane sees
          it — and a device is exactly where the pointer usually is. Turning
          the nodes off instead does not work either: React Flow sets
          pointer-events on them inline, where no stylesheet reaches. A sheet
          on top is the one thing that reliably gets the pointer first. */}
      {panning && (
        <div
          className="cv-pan-sheet"
          onPointerDown={(e) => {
            // Any button: whichever one is under the hand while the space bar
            // is held is the one doing the panning.
            e.preventDefault();
            if (!panFrom.current) grabAt(e.clientX, e.clientY);
          }}
          // A right press is a context menu everywhere unless it is refused
          // here, and in WebKitGTK refusing it is also what keeps the rest of
          // the drag coming.
          onContextMenu={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
        />
      )}
      {(focus || lit) && (
        <div className="cv-dim-chip" role="status">
          {focus ? `Focused on ${focus.ids.length === 1 ? ((pg.nodes.find((n) => n.id === focus.ids[0])?.data as DeviceNodeData | undefined)?.label ?? 'a device') : `${focus.ids.length} devices`}, ${t('plural.link', { count: focus.hops })} out` : 'Filtered'}
          {lit && ` · ${lit.size} of ${view.nodes.length} lit`}
          {focus && <button type="button" className="cv-btn cv-btn-small" onClick={() => useStore.getState().setFocus(null)}>Leave focus</button>}
          {canvasFilter && <button type="button" className="cv-btn cv-btn-small" onClick={() => useStore.getState().setCanvasFilter(null)}>Clear filter</button>}
        </div>
      )}
      <InkTools />
      <GuidePanel />
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {palette && (
        <CommandPalette
          onClose={() => setPalette(false)}
          commands={paletteCommands}
          onGoTo={(item) => {
            if (!item.nodeId) return;
            if (item.pageId && item.pageId !== doc.activePageId) useStore.getState().setActivePage(item.pageId);
            const id = item.nodeId;
            // After the page has rendered, select it and bring it into view.
            window.setTimeout(() => {
              const s = useStore.getState();
              const nodes = s.doc.pages.find((p) => p.id === s.doc.activePageId)?.nodes ?? [];
              s.onNodesChange(nodes.map((n) => ({ type: 'select' as const, id: n.id, selected: n.id === id })));
              s.select(id, null);
              void rf.fitView({ nodes: [{ id }], maxZoom: 1.5, duration: 300 });
            }, 60);
          }}
          onAddShape={(type) => {
            const box = document.querySelector('.cv-canvas')?.getBoundingClientRect();
            const at = rf.screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 800) / 2, y: (box?.top ?? 0) + (box?.height ?? 600) / 2 });
            useStore.getState().addNode(makeDeviceNode(type as DeviceType, at.x, at.y));
            useStore.getState().setStatusMessage(`Added ${DEVICE_LABEL[type as DeviceType]} in the middle of the view.`);
          }}
        />
      )}
      {tracerouteTarget && (
        <TraceroutePanel target={tracerouteTarget} onClose={() => setTracerouteTarget(null)} />
      )}
      {finding && <FindBox onClose={() => setFinding(false)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <PageTabs />
    </div>
  );
}
