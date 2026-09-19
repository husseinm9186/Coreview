import { nodeForDrop } from '../lib/paletteDrop';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Controls,
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
import { litNodes } from '../lib/canvasFilter';
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
import { uid } from '../lib/id';
import { DEVICE_LABEL } from './icons';
import { shapeDefaultFields } from '../lib/shapeCatalog';
import { useDragOverlay } from '../state/dragOverlay';
import { restack, sameOrder, type Restack } from '../lib/zOrder';
import { addPoint, lassoed, type Point } from '../lib/lasso';
import { snapUnguided } from '../lib/gridSnap';
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
  // Shapes keep the card proportions; a device is its glyph (LT-053), and a
  // glyph's bounds are square so the corners sit on the drawn shape.
  if (['rectangle', 'rounded', 'circle', 'diamond', 'cloud'].includes(type)) {
    return { width: 168, height: 92 };
  }
  return { width: 76, height: 76 };
}

/** Below this zoom the canvas draws devices and links without their detail
 *  (LT-189): at 0.4 a 12px label is under five pixels tall. */
export const FAR_ZOOM = 0.4;
/** The grid a dragged object snaps to (LT-175): the page's minor grid lines. */
export const GRID_STEP = 12;
/** …and only on a page this large (LT-189) — the same line culling was held
 *  to (D-010, LT-188): below it, the canvas draws as it always has. */
export const FAR_MIN_DEVICES = 500;

export function makeDeviceNode(type: DeviceType, x: number, y: number): TopoNode {
  const data: DeviceNodeData = {
    label: DEVICE_LABEL[type],
    deviceType: type,
    tags: [],
    locked: false,
    maintenance: false,
    showDetails: true,
    // LT-171: ports, rack height and a management address to fill in.
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
 * The minimap, plain or coloured by health (LT-191). Its own component so the
 * probe results it listens to re-render the minimap, not the whole canvas.
 * Health is carried by shape as well as colour: a down device is outlined
 * dashed, a warning one outlined solid.
 */
function HealthMiniMap({ health, ground }: { health: boolean; ground: Ground }) {
  const palette = canvasPalette(ground);
  useStore((s) => (health ? s.runtime : null));
  useStore((s) => (health ? s.session.state : null));
  const status = (id: string): HealthStatus => useStore.getState().nodeStatus(id);
  return (
    <MiniMap
      pannable
      zoomable
      className={`cv-minimap${health ? ' is-health' : ''}`}
      nodeColor={(n) =>
        n.type === 'note'
          ? palette.minimapNote
          : health
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
  // LT-173: the outline of a lasso being drawn, in the wrapper's own pixels.
  const [lasso, setLasso] = useState<Point[] | null>(null);
  const rf = useReactFlow();
  /** React Flow's own store, for cancelling a selection box it has already
   *  started when space turns the drag into a pan (LT-158). */
  const rfStore = useStoreApi();
  const ground = useStore((s) => s.settings.ground);
  const settings = useStore((s) => s.settings);

  // LT-189: zoomed far out over a large diagram, a device's name, status line
  // and badge, its connection handles and a link's hit band and labels are too
  // small to read or use — and they were most of what Chrome repainted on every
  // frame of a pan (at 5,000 devices, a pan took a third of the time with them
  // hidden). One class, which changes only when the answer does, hides them;
  // nothing re-renders. Only on a large page: an ordinary diagram fitted to the
  // window is often below 40% too, and has nothing to gain from losing them.
  const far = useFlowStore((s) => s.transform[2] < FAR_ZOOM && s.nodeLookup.size >= FAR_MIN_DEVICES);
  const [finding, setFinding] = useState(false);
  const [help, setHelp] = useState(false);
  // LT-230: the command palette.
  const [palette, setPalette] = useState(false);
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
   *  pan (LT-158). */
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
   *  pointer and the mouse pair are heard, because of LT-287: in WebKitGTK a
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
  const store = useStore();
  // The page being drawn (LT-094) — this component renders exactly one.
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
          // `store.addEdge` gives it the document's default style, which is
          // Bezier unless the operator saved something else (LT-130).
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
      store.addEdge(edge);
      store.select(null, edge.id);
    },
    [store, pg.nodes],
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
        // icon; the bundled set (D-022) backs it, then whatever this
        // project has captured from its own canvas (LT-104).
        iconLibrary: [...store.iconLibrary, ...store.bundledIcons, ...(store.doc.customShapes ?? [])],
      });
      if (node) store.addNode(node);
    },
    [rf, store],
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
    const members = store.groupMembers(nodeId);
    const selectedCount = pg.nodes.filter((n) => n.selected).length;
    // The same target a device's own primary check is aimed at (LT-061), so
    // "where is this actually going" traces the address being monitored,
    // not just whichever address happens to be listed first.
    const nodeProbes = doc.probes.filter((p) => p.objectId === nodeId);
    const primaryTarget = (nodeProbes.find((p) => p.isPrimary) ?? nodeProbes[0])?.target.trim();
    return [
      { label: 'Edit properties', onSelect: () => store.select(nodeId, null) },
      // LT-233: this device, or the selection it is part of, and its neighbours.
      ...[1, 2].map((hops) => ({
        label: `Focus on ${selectedCount > 1 && node?.selected ? 'the selection' : 'this'} — ${hops} link${hops === 1 ? '' : 's'} out`,
        onSelect: () => store.setFocus({ ids: selectedCount > 1 && node?.selected ? pg.nodes.filter((n) => n.selected).map((n) => n.id) : [nodeId], hops }),
      })),
      ...(primaryTarget
        ? [{ label: 'Traceroute', onSelect: () => setTracerouteTarget(primaryTarget) }]
        : []),
      {
        label: 'Duplicate',
        onSelect: () => {
          if (!node) return;
          store.addNode({
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
                store.saveCustomShape(nodeId, d.label || DEVICE_LABEL[d.deviceType]);
              },
            },
          ]
        : []),
      {
        label: maintenance ? 'Clear maintenance' : 'Set maintenance',
        onSelect: () => store.updateNodeData(nodeId, { maintenance: !maintenance }),
      },
      {
        label: locked ? 'Unlock' : 'Lock',
        onSelect: () => store.updateNodeData(nodeId, { locked: !locked }),
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
              const moved = store.arrange(ids, how);
              store.setStatusMessage(
                moved === 0
                  ? 'They are already arranged that way.'
                  : `Moved ${moved} object${moved === 1 ? '' : 's'}.`,
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
              onSelect: () => store.ungroup(nodeId),
            },
          ]
        : selectedCount > 1
          ? [{ label: `Group ${selectedCount} objects`, onSelect: () => store.groupSelected() }]
          : []),
      // LT-174: the whole selection when this is part of one.
      { label: 'Bring to front (Ctrl+Shift+])', onSelect: () => reorder(nodeId, 'front') },
      { label: 'Bring forward (Ctrl+])', onSelect: () => reorder(nodeId, 'forward') },
      { label: 'Send backward (Ctrl+[)', onSelect: () => reorder(nodeId, 'backward') },
      { label: 'Send to back (Ctrl+Shift+[)', onSelect: () => reorder(nodeId, 'back') },
      {
        label: 'Delete',
        danger: true,
        onSelect: () => {
          store.select(nodeId, null);
          store.deleteSelected();
        },
      },
    ];
  };

  /** Restacks an object — or the selection it belongs to — as one undo step
   *  (LT-101, LT-174). */
  const reorder = useCallback(
    (nodeId: string | null, how: Restack) => {
      const selected = pg.nodes.filter((n) => n.selected).map((n) => n.id);
      const ids = new Set(nodeId && !selected.includes(nodeId) ? [nodeId] : selected);
      const nodes = restack(pg.nodes, ids, how);
      if (sameOrder(nodes, pg.nodes)) return;
      store.commit();
      useStore.setState((s) => ({ doc: withPage(s.doc, { nodes }), dirty: true }));
    },
    [pg.nodes, store],
  );

  const edgeMenu = (edgeId: string): MenuItem[] => {
    const edge = pg.edges.find((e) => e.id === edgeId);
    const data = edge?.data;
    return [
      { label: 'Edit link properties', onSelect: () => store.select(null, edgeId) },
      {
        label: 'Reverse flow direction',
        onSelect: () =>
          store.updateEdgeData(edgeId, {
            direction: data?.direction === 'forward' ? 'reverse' : 'forward',
          }),
      },
      {
        label: 'Cycle path type',
        onSelect: () => {
          const order = ['smoothstep', 'bezier', 'step', 'straight', 'avoid'] as const;
          const next = order[(order.indexOf(data?.pathType ?? 'smoothstep') + 1) % order.length]!;
          store.updateEdgeData(edgeId, { pathType: next });
        },
      },
      // LT-068: hand a link back to auto-routing.
      ...(data?.waypoints?.length
        ? [{ label: 'Reset routing', onSelect: () => store.updateEdgeData(edgeId, { waypoints: [] }) }]
        : []),
      // LT-079: back to the look the operator chose — colour, path, flow,
      // width, line style — leaving the ports, label and health rule alone.
      {
        label: 'Reset to default style',
        onSelect: () => {
          store.commit();
          store.updateEdgeData(edgeId, resetToDefault(pg.canvas.linkStyle));
        },
      },
      {
        label: 'Save this style as the default',
        onSelect: () => {
          if (!data) return;
          store.setDefaultLinkStyle(styleOf(data));
          store.setStatusMessage('New links will look like this one, on every page.');
        },
      },
      {
        label: data?.maintenance ? 'Clear maintenance' : 'Set maintenance',
        onSelect: () => store.updateEdgeData(edgeId, { maintenance: !data?.maintenance }),
      },
      {
        label: 'Delete',
        danger: true,
        onSelect: () => {
          store.select(null, edgeId);
          store.deleteSelected();
        },
      },
    ];
  };

  const paneMenu = (clientX: number, clientY: number): MenuItem[] => {
    const p = rf.screenToFlowPosition({ x: clientX, y: clientY });
    return [
      { label: 'Add note', onSelect: () => store.addNode(makeNote(p.x, p.y)) },
      { label: 'Add change note', onSelect: () => store.addNode(makeNote(p.x, p.y, 'change')) },
      { label: 'Add sticky note', onSelect: () => store.addNode(makeNote(p.x, p.y, 'sticky')) },
      { label: 'Add container', onSelect: () => store.addNode(makeDeviceNode('site', p.x, p.y)) },
      {
        label: 'Paste in place (Ctrl+Shift+V)',
        disabled: !store.canPaste(),
        onSelect: () => store.pasteInPlace(),
      },
      { label: 'Fit view', onSelect: () => fitEverything() },
      // LT-192 / LT-193.
      { label: 'Zoom to selection', onSelect: () => zoomToSelection() },
      {
        label: store.doc.gridSnap ? 'Stop snapping to the grid (Ctrl+Shift+G)' : 'Snap to the grid (Ctrl+Shift+G)',
        onSelect: () => store.setGridSnap(!store.doc.gridSnap),
      },
      { label: 'Save this view', onSelect: () => saveViewpoint() },
      ...(pg.canvas.viewpoints ?? []).map((v, i) => ({
        label: `Go to ${v.name}${i < 9 ? ` (Alt+${i + 1})` : ''}`,
        onSelect: () => void goToViewpoint(i),
      })),
      ...(pg.canvas.viewpoints ?? []).map((v) => ({
        label: `Forget ${v.name}`,
        onSelect: () =>
          store.setCanvas({ viewpoints: (pg.canvas.viewpoints ?? []).filter((x) => x.id !== v.id) }),
      })),
      { label: 'Present (F5)', onSelect: () => store.setPresenting(true) },
      {
        label: pg.canvas.minimapHealth ? 'Draw the minimap plain' : 'Colour the minimap by health',
        onSelect: () => store.setCanvas({ minimapHealth: !pg.canvas.minimapHealth }),
      },
      {
        label: 'Fit page to content',
        onSelect: () => {
          // The one deliberate shrink. Growth is automatic; going back is not,
          // because a sheet that snaps smaller on its own makes the layout
          // jump under the pointer.
          store.setCanvas({ sheetRect: pageForContent(pg.nodes) });
          store.setStatusMessage('The page now fits what is on it.');
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
        onSelect: () => store.setCanvas({ gridEnabled: !pg.canvas.gridEnabled }),
      },
      {
        label:
          (pg.canvas.nodeStyle ?? 'glyph') === 'glyph'
            ? 'Draw devices as cards'
            : 'Draw devices as symbols',
        onSelect: () =>
          store.setCanvas({
            nodeStyle: (pg.canvas.nodeStyle ?? 'glyph') === 'glyph' ? 'card' : 'glyph',
          }),
      },
      {
        label: 'Tidy the layout',
        onSelect: () => {
          const { moved, rows, locked } = store.tidyLayout();
          store.setStatusMessage(
            moved === 0
              ? 'Nothing to tidy — the spacing is already even.'
              : `Evened out ${moved} device${moved === 1 ? '' : 's'} across ${rows} row${
                  rows === 1 ? '' : 's'
                }. Nothing was rearranged.` +
                (locked ? ` ${locked} locked device${locked === 1 ? '' : 's'} left alone.` : ''),
          );
        },
      },
      // LT-177: the other layouts, each one undo step.
      ...([
        ['radial', 'Lay out radially, core in the middle'],
        ['force', 'Lay out as a mesh (force-directed)'],
        ['orthogonal', 'Lay out on a grid (orthogonal)'],
      ] as const).map(([kind, label]) => ({
        label,
        onSelect: () => {
          const { moved, scope, locked, tooMany } = store.autoLayout(kind);
          store.setStatusMessage(
            tooMany
              ? `A mesh layout is limited to ${tooMany.toLocaleString()} devices at once. Select part of the diagram and try again.`
              : moved === 0
              ? 'Nothing to lay out.'
              : `Laid out ${moved} device${moved === 1 ? '' : 's'} ${scope === 'selection' ? 'in the selection' : 'on this page'}.` +
                  (locked ? ` ${locked} locked device${locked === 1 ? '' : 's'} left alone.` : '') +
                  ' Undo puts it back.',
          );
        },
      })),
      {
        // The other half of the pair. Tidy keeps the arrangement and fixes the
        // spacing; this replaces the arrangement, which is what a crawled or
        // imported topology usually needs and a hand-drawn one usually does
        // not. Named for what it produces rather than for the algorithm.
        label: 'Arrange top to bottom',
        onSelect: () => {
          const { moved, tiers, locked } = store.flowLayout();
          store.setStatusMessage(
            moved === 0
              ? 'Nothing to arrange on this page.'
              : `Arranged ${moved} device${moved === 1 ? '' : 's'} into ${tiers} layer${
                  tiers === 1 ? '' : 's'
                }, internet at the top.` +
                (locked ? ` ${locked} locked device${locked === 1 ? '' : 's'} left alone.` : '') +
                ' Undo puts it back.',
          );
        },
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
          onSelect: () => store.setCanvas({ colourBy: by }),
        })),
      {
        // LT-168: outline or solid glyphs for the whole page.
        label: (pg.canvas.glyphVariant ?? 'outline') === 'solid' ? 'Draw devices as outlines' : 'Draw devices as solid tiles',
        onSelect: () =>
          store.setCanvas({ glyphVariant: (pg.canvas.glyphVariant ?? 'outline') === 'solid' ? 'outline' : 'solid' }),
      },
      {
        label: (pg.canvas.lineJumps ?? true) ? 'Stop hopping crossed links' : 'Hop crossed links',
        onSelect: () =>
          store.setCanvas({ lineJumps: !(pg.canvas.lineJumps ?? true) }),
      },
      {
        label: 'Let every link follow its devices',
        onSelect: () => {
          const freed = store.unpinLinks();
          store.setStatusMessage(
            freed === 0
              ? 'Every link already follows its devices.'
              : `${freed} link${freed === 1 ? '' : 's'} released. They will swing round to the ` +
                'nearer side as you move things.',
          );
        },
      },
      {
        label: 'Group each subnet together',
        onSelect: () => {
          const { groups, ungrouped } = store.groupBySubnet();
          store.setStatusMessage(
            groups === 0
              ? 'Nothing to group — no two devices share a /24.'
              : `Grouped ${groups} subnet${groups === 1 ? '' : 's'}. Dragging one device now moves its whole subnet.` +
                (ungrouped ? ` ${ungrouped} device${ungrouped === 1 ? '' : 's'} left ungrouped.` : ''),
          );
        },
      },
      {
        label: settings.minimap ? 'Hide the overview box' : 'Show the overview box',
        onSelect: () => store.setSettings({ minimap: !settings.minimap }),
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
      store.addNode(node);
      store.beginEditing(node.id);
    };
    el.addEventListener('dblclick', write, true);
    return () => el.removeEventListener('dblclick', write, true);
  }, [rf, store]);

  /** Fit the sheet, not just what is on it.
   *
   *  Fitting to the devices alone puts the page edge off-screen, so the one
   *  thing that says where the drawing surface is cannot be seen. When the
   *  page is off, there is nothing to fit but the devices. */
  const fitEverything = useCallback(() => {
    if (!(pg.canvas.sheet ?? true)) {
      // A fit keeps the old ceiling: LT-047 opened the wheel's walls, and
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

  /** LT-192: fit what is selected, not the whole sheet. */
  const zoomToSelection = useCallback(() => {
    const sel = pg.nodes.filter((n) => n.selected);
    if (sel.length === 0) {
      store.setStatusMessage('Select something to zoom to.');
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
  }, [pg.nodes, rf, store]);

  /** LT-230: what the palette can do after `>`. */
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
      { id: 'arrange', label: 'Arrange top to bottom', run: () => s().flowLayout() },
      { id: 'start', label: 'Start validation', run: () => void s().startValidation() },
      { id: 'stop', label: 'Stop validation', run: () => void s().stopValidation() },
      { id: 'help', label: 'Keyboard shortcuts', hint: '?', run: () => setHelp(true) },
      tab('discover', 'Ping sweep'),
      tab('crawl', 'Discover devices'),
      tab('racks', 'Racks'),
      tab('path', 'Path check'),
      tab('compare', 'Compare'),
      tab('events', 'Event timeline'),
    ];
  }, [fitEverything, zoomToSelection]);

  /** LT-192: remember where the viewport is, as "View N" on this page. */
  const saveViewpoint = useCallback(() => {
    const list = pg.canvas.viewpoints ?? [];
    const taken = new Set(list.map((v) => v.name));
    let n = list.length + 1;
    while (taken.has(`View ${n}`)) n += 1;
    const name = `View ${n}`;
    const { x, y, zoom } = rf.getViewport();
    store.setCanvas({ viewpoints: [...list, { id: uid(), name, x, y, zoom }] });
    const place = list.length + 1;
    store.setStatusMessage(
      place <= 9 ? `Saved ${name}. Alt+${place} comes back to it.` : `Saved ${name}. The canvas menu comes back to it.`,
    );
  }, [pg.canvas.viewpoints, rf, store]);

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
    // Shift is the other hand, and the one the report reached for first
    // (LT-287): it used to draw React Flow's selection box, which a plain drag
    // on the pane already does, so nothing is lost by making it pan. Not while
    // Alt is down — Alt+Shift is the lasso that adds to a selection (LT-173).
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
      // LT-158: the button went down a moment before space, as happens when
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
      // A drag already under way keeps going until the *button* is released
      // (LT-075). Space starts the hand; letting go of it half way through a
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
            const moved = store.arrange(ids, how);
            store.setStatusMessage(
              moved === 0
                ? 'They are already arranged that way.'
                : `Moved ${moved} object${moved === 1 ? '' : 's'}.`,
            );
            return;
          }
        }
      }
      // LT-193: in presentation the keys are for moving between pages and
      // leaving; nothing edits the diagram.
      if (store.presenting) {
        const pages = store.doc.pages;
        const at = pages.findIndex((p) => p.id === store.doc.activePageId);
        if (e.key === 'Escape' || e.key === 'F5') {
          e.preventDefault();
          store.setPresenting(false);
        } else if (['PageDown', 'ArrowRight', 'ArrowDown', ' '].includes(e.key)) {
          e.preventDefault();
          const next = pages[Math.min(pages.length - 1, Math.max(0, at) + 1)];
          if (next) store.setActivePage(next.id);
        } else if (['PageUp', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
          e.preventDefault();
          const prev = pages[Math.max(0, at - 1)];
          if (prev) store.setActivePage(prev.id);
        } else if (e.key === 'f' || e.key === 'F') {
          fitEverything();
        }
        return;
      }
      if (e.key === 'F5') {
        e.preventDefault();
        store.setPresenting(true);
        return;
      }
      // LT-183: Ctrl+PageUp/PageDown steps through the pages.
      if (mod && (e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault();
        const pages = store.doc.pages;
        const at = Math.max(0, pages.findIndex((p) => p.id === store.doc.activePageId));
        const to = pages[Math.min(pages.length - 1, Math.max(0, at + (e.key === 'PageDown' ? 1 : -1)))];
        if (to) store.setActivePage(to.id);
        return;
      }
      // LT-192: Alt+1…9 goes back to a saved view on this page.
      if (e.altKey && !mod && /^Digit[1-9]$/.test(e.code)) {
        if (goToViewpoint(Number(e.code.slice(5)) - 1)) e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        store.selectAll();
      } else if (mod && e.key.toLowerCase() === 'c') {
        const copied = store.copySelection();
        if (copied > 0) {
          e.preventDefault();
          store.setStatusMessage(`Copied ${copied} object${copied === 1 ? '' : 's'}.`);
        }
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'v') {
        // LT-186.
        e.preventDefault();
        const pasted = store.pasteInPlace();
        store.setStatusMessage(
          pasted > 0 ? `Pasted ${pasted} object${pasted === 1 ? '' : 's'} where they were copied from.` : 'Nothing has been copied.',
        );
      } else if (mod && e.key.toLowerCase() === 'v') {
        const pasted = store.paste();
        if (pasted > 0) {
          e.preventDefault();
          store.setStatusMessage(`Pasted ${pasted} object${pasted === 1 ? '' : 's'}.`);
        }
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'g') {
        // LT-175.
        e.preventDefault();
        const on = !store.doc.gridSnap;
        store.setGridSnap(on);
        store.setStatusMessage(on ? 'Snapping to the grid.' : 'Not snapping to the grid.');
      } else if (mod && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        // LT-174: Ctrl+] / Ctrl+[ a step, with Shift all the way.
        e.preventDefault();
        const up = e.code === 'BracketRight';
        reorder(null, e.shiftKey ? (up ? 'front' : 'back') : up ? 'forward' : 'backward');
      } else if (mod && e.key.toLowerCase() === 'k') {
        // LT-230.
        e.preventDefault();
        setPalette(true);
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFinding(true);
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void store.saveProject();
      } else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        store.redo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const sel = pg.nodes.find((n) => n.selected);
        if (sel) {
          // Offset by one grid step, and the copy takes the selection — the
          // original must let go of it, or the next Delete removes both.
          store.selectNone();
          store.addNode({
            ...sel,
            id: uid(),
            position: { x: sel.position.x + 60, y: sel.position.y + 60 },
            selected: true,
          } as TopoNode);
        }
      } else if (e.key.startsWith('Arrow') && e.altKey && !mod) {
        // LT-240: Alt+arrow goes to the nearest device that way; with nothing
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
        store.onNodesChange(pg.nodes.map((n) => ({ type: 'select' as const, id: n.id, selected: n.id === target })));
        store.select(pg.nodes.find((n) => n.id === target)?.type === 'note' ? null : target, null);
        const b = boxes.find((x) => x.id === target)!;
        const { x: vx, y: vy, zoom } = rf.getViewport();
        const sx = b.x * zoom + vx;
        const sy = b.y * zoom + vy;
        if (wrap && (sx < 40 || sy < 40 || sx + b.w * zoom > wrap.width - 40 || sy + b.h * zoom > wrap.height - 40)) {
          void rf.setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom, duration: 200 });
        }
        // Announced for a screen reader through the live status line.
        const d = pg.nodes.find((n) => n.id === target)?.data as DeviceNodeData | undefined;
        store.setStatusMessage(`${d?.label ?? 'Note'} selected`);
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
          store.onNodesChange(
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
        if (store.focus) {
          store.setFocus(null);
          return;
        }
        store.selectNone();
        setGuides([]);
      } else if (e.key === '?') {
        e.preventDefault();
        setHelp((h) => !h);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        store.deleteSelected();
      } else if (e.key === 'F' && e.shiftKey && !mod) {
        zoomToSelection();
      } else if (e.key === 'f' && !mod) {
        fitEverything();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pg.nodes, rf, store, fitEverything, help, zoomToSelection, goToViewpoint, reorder]);

  // React Flow decides whether a node can be dragged from a `draggable` field
  // on the node itself. `locked` lives in `data`, which it never looks at, so
  // "Lock position" hid the resize handles — the one part DeviceNode reads
  // directly — and left the node as draggable as before.
  // LT-189: while a drag is in flight the canvas draws from its own copy of
  // the page's nodes, and the document is written once, on release — see
  // src/state/dragOverlay.ts for why.
  const [dragNodes, setDragNodes] = useState<TopoNode[] | null>(null);
  const dragNodesRef = useRef<TopoNode[] | null>(null);
  const printing = useStore((s) => s.printing);
  const liveNodes = dragNodes ?? pg.nodes;

  const view = useMemo(() => {
    // Hidden views come out first: everything after this — folding, routing,
    // hops — should be reasoning about the diagram as it is being looked at.
    // While printing (LT-184), the views set not to print come out too.
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

  // LT-189: what each node was turned into last time, keyed on the node itself.
  // A new object for every node on every change told React Flow that all of
  // them had changed, so every device re-rendered on every frame of a drag of
  // one of them. An unchanged node now keeps its object.
  // LT-232, LT-233: what the filter or focus leaves lit. Status is only
  // listened to when the filter asks about it.
  const canvasFilter = useStore((s) => s.canvasFilter);
  const focus = useStore((s) => s.focus);
  const statusTick = useStore((s) => (s.canvasFilter?.status ? s.runtime : null));
  const lit = useMemo(
    () => litNodes(view.nodes, view.edges, canvasFilter, focus, (id) => useStore.getState().nodeStatus(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view.nodes, view.edges, canvasFilter, focus, statusTick],
  );
  const derived = useRef(new WeakMap<TopoNode, { zIndex: number; locked: boolean; dimmed: boolean; out: TopoNode }>());
  const nodes = useMemo(
    () =>
      view.nodes.map((n, i) => {
        const layers = layersOf(pg.canvas.layers);
        const locked =
          Boolean((n.data as { locked?: boolean }).locked) ||
          !isEditable((n.data as { layers?: string[] }).layers, layers);
        // A section is a backdrop: it has to sit under the devices standing
        // in it, or it covers them and the diagram is a set of empty boxes.
        //
        // Everything else takes its stacking from its position in the
        // document's own node array (LT-101) rather than a flat 1 for
        // every node. React Flow keeps its own node lookup as a Map keyed
        // by id and updates entries in place — re-ordering the array we
        // pass it does not move anything in that Map's iteration order, so
        // "Bring forward"/"Send backward" (which only ever reordered the
        // array) were changing nothing anyone could see. An explicit,
        // array-position-derived zIndex is what actually drives paint
        // order, and it does respond to that reorder.
        const zIndex = (n.data as { deviceType?: string }).deviceType === 'zone' ? 0 : i + 1;
        const dimmed = lit !== null && !lit.has(n.id);
        const was = derived.current.get(n);
        if (was && was.zIndex === zIndex && was.locked === locked && was.dimmed === dimmed) return was.out;
        // LT-241: what a screen reader says for it.
        const ariaLabel = nodeAriaLabel(n, (t) => DEVICE_LABEL[t as DeviceType] ?? t);
        const base = locked ? { ...n, draggable: false, zIndex, ariaLabel } : { ...n, zIndex, ariaLabel };
        const out = dimmed ? { ...base, className: `${n.className ?? ''} is-dimmed`.trim() } : base;
        derived.current.set(n, { zIndex, locked, dimmed, out });
        return out;
      }),
    [view.nodes, pg.canvas.layers, lit],
  );
  // LT-241 names each link for a screen reader; LT-232 dims some. The copy is
  // kept per link object and reused while its label and dimming are unchanged,
  // so a drag does not hand React Flow a new object for every link each frame
  // (LT-189).
  const derivedEdges = useRef(new WeakMap<TopoEdge, { ariaLabel: string; dimmed: boolean; out: TopoEdge }>());
  const shownEdges = useMemo(() => {
    const names = new Map(view.nodes.map((n) => [n.id, (n.data as { label?: string; title?: string }).label ?? (n.data as { title?: string }).title ?? 'a note']));
    const nameOf = (id: string) => names.get(id) ?? 'a device';
    return view.edges.map((e) => {
      const ariaLabel = edgeAriaLabel(e, nameOf);
      const dimmed = lit !== null && !(lit.has(e.source) && lit.has(e.target));
      const was = derivedEdges.current.get(e);
      if (was && was.ariaLabel === ariaLabel && was.dimmed === dimmed) return was.out;
      const out = dimmed ? { ...e, ariaLabel, className: `${e.className ?? ''} is-dimmed`.trim() } : { ...e, ariaLabel };
      derivedEdges.current.set(e, { ariaLabel, dimmed, out });
      return out;
    });
  }, [view.edges, view.nodes, lit]);

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
  /** Sends a batch of node changes where it belongs (LT-189): positions still
   *  in flight to the drag overlay, everything else — and a drag's last
   *  position — to the document. */
  const route = useCallback(
    (changes: NodeChange<TopoNode>[]) => {
      const inFlight = (c: NodeChange<TopoNode>) => c.type === 'position' && c.dragging === true;
      const flying = changes.filter(inFlight);
      const rest = changes.filter((c) => !inFlight(c));
      const page = activePage(useStore.getState().doc);
      if (flying.length > 0) {
        // LT-273: a drag is one undo step, taken as it starts — before anything
        // has moved — so one Ctrl+Z puts back everything it carried. A click
        // that moves nothing sends no position and takes no step.
        if (!dragNodesRef.current) store.commit();
        let next = moveGroups(flying, dragNodesRef.current ?? page.nodes);
        if (rest.length > 0) {
          next = applyNodeChanges(rest, next) as TopoNode[];
          store.onNodesChange(rest);
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
      store.onNodesChange(changes);
    },
    [store],
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
      // LT-175: grid snap is the project's setting, inverted while Alt is held;
      // Alt also refuses the guides for that drag.
      const gridOn = Boolean(useStore.getState().doc.gridSnap) !== altDown.current;
      const toGrid = (v: number) => Math.round(v / GRID_STEP) * GRID_STEP;
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

      // LT-175: guides win; where neither an edge nor a rhythm took an axis,
      // the grid does, if it is on.
      if (gridOn) Object.assign(settled, snapUnguided(settled, keptGuides, spacingGuides, GRID_STEP));
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
        // LT-158: a press on the canvas takes focus out of a panel's field.
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
        // LT-173: Alt+drag on empty canvas draws a lasso instead of a box;
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
            store.onNodesChange(
              nodes
                .filter((n) => (adding ? caught.has(n.id) && !n.selected : Boolean(n.selected) !== caught.has(n.id)))
                .map((n) => ({ type: 'select', id: n.id, selected: caught.has(n.id) || (adding && Boolean(n.selected)) })),
            );
            if (caught.size > 0) store.setStatusMessage(`Lasso caught ${caught.size} object${caught.size === 1 ? '' : 's'}.`);
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
        onEdgesChange={store.onEdgesChange}
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
        onNodeClick={(_, n) => store.select(n.id, null)}
        onEdgeClick={(_, e) => store.select(null, e.id)}
        /* LT-052: double-click a spot on a link and write straight onto it.
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
          store.commit();
          store.updateEdgeData(edge.id, { texts });
        }}
        onPaneClick={() => {
          store.select(null, null);
          setMenu(null);
        }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          store.select(n.id, null);
          setMenu({ x: e.clientX, y: e.clientY, items: nodeMenu(n.id) });
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault();
          store.select(null, edge.id);
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
        panOnScroll={false}
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
        {/* LT-238. */}
        <InkStrokes />
        <Controls showInteractive={false} />
        {settings.minimap && (
          <HealthMiniMap health={Boolean(pg.canvas.minimapHealth)} ground={ground} />
        )}
      </ReactFlow>
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
            // is held is the one doing the panning (LT-287).
            e.preventDefault();
            if (!panFrom.current) grabAt(e.clientX, e.clientY);
          }}
          // A right press is a context menu everywhere unless it is refused
          // here, and in WebKitGTK refusing it is also what keeps the rest of
          // the drag coming (LT-287).
          onContextMenu={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
        />
      )}
      {(focus || lit) && (
        <div className="cv-dim-chip" role="status">
          {focus ? `Focused on ${focus.ids.length === 1 ? ((pg.nodes.find((n) => n.id === focus.ids[0])?.data as DeviceNodeData | undefined)?.label ?? 'a device') : `${focus.ids.length} devices`}, ${focus.hops} link${focus.hops === 1 ? '' : 's'} out` : 'Filtered'}
          {lit && ` · ${lit.size} of ${view.nodes.length} lit`}
          {focus && <button type="button" className="cv-btn cv-btn-small" onClick={() => store.setFocus(null)}>Leave focus</button>}
          {canvasFilter && <button type="button" className="cv-btn cv-btn-small" onClick={() => store.setCanvasFilter(null)}>Clear filter</button>}
        </div>
      )}
      <InkTools />
      {/* LT-271 */}
      <GuidePanel />
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {palette && (
        <CommandPalette
          onClose={() => setPalette(false)}
          commands={paletteCommands}
          onGoTo={(item) => {
            if (!item.nodeId) return;
            if (item.pageId && item.pageId !== store.doc.activePageId) store.setActivePage(item.pageId);
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
            store.addNode(makeDeviceNode(type as DeviceType, at.x, at.y));
            store.setStatusMessage(`Added ${DEVICE_LABEL[type as DeviceType]} in the middle of the view.`);
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
