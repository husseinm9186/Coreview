/**
 * Rack elevations: the project's racks drawn U by
 * U on a canvas of their own, from the front, the rear or the side, with the
 * devices on the diagram placed in them and the furniture a rack holds that
 * is not on the diagram — patch panels, PDUs, UPSs, shelves, blanks, and
 * reservations — beside them.
 *
 * A device or a piece of furniture is dragged into a rack, or moved within or
 * between racks, and always lands on a whole U — there is no free placement
 * to turn off (the amendment) — and on the face being looked at.
 * A move into space something else holds is refused with what is
 * in the way. The selected box moves a U at a time with the arrow keys. Each
 * box is drawn as what it is: the class glyph and colour, port
 * blocks, bays, outlets or jacks, a status light, an airflow arrow, its
 * stack member number; a chosen colour replaces the class colour.
 * A stack's cables run down the side of the rack the way the vendor's guide
 * draws them. The side view shows each box as deep as it
 * is. Racks stand where they are — building, floor, room, row — and the page
 * groups them so. Zoom with Ctrl+wheel or the buttons.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { saveExport, slug } from '../lib/exports';
import { allEdges, allNodes } from '../lib/pages';
import { cableColour, isUnracked, linksOutOf, patchCablesFor, pduLoad, powerCordsFor, spreadStubs, type LinkLike, type PatchCable, type PowerCord } from '../lib/rackCables';
import { GENERIC_TEMPLATES, templateFromNetboxYaml, type DeviceTemplate } from '../lib/deviceTemplates';
import { ipc, isDesktop } from '../lib/ipc';
import {
  AIRFLOWS,
  DEFAULT_RACK_DEPTH_MM,
  DEFAULT_RACK_UNITS,
  DEFAULT_RACK_WIDTH_MM,
  MAX_RACK_UNITS,
  airflowOf,
  depthFraction,
  elevation,
  firstFreeU,
  furnitureRackables,
  groupRacks,
  placeOf,
  placementProblem,
  rackHeightMm,
  rackableOf,
  spanOf,
  takesSpace,
  uAt,
  uLabel,
  usageOf,
  type Airflow,
  type Rack,
  type RackFace,
  type RackItem,
  type Rackable,
} from '../lib/rack';
import { FURNITURE, furnitureSpec, type FurnitureKind } from '../lib/rackFurniture';
import { rackAdvice } from '../lib/rackAdvice';
import { layoutOf, type RackLayout } from '../lib/rackLayout';
import { floorSvg, footprintsFor } from '../lib/floorPlan';
import { FloorView } from './FloorView';
import { rackElevationDxf } from '../lib/rackDxf';
import { rackElevationSvg } from '../lib/rackSvg';
import { STACK_PRESETS, roleOf, stackCables, stackPreset, type Stack, type StackTopology } from '../lib/stacking';
import { useStore } from '../state/store';
import { GROUP_WHEEL_DARK, deviceColor } from '../theme';
import type { DeviceNodeData, DeviceType, LinkData } from '../types/domain';
import { t } from '../i18n';
import { DeviceGlyph, DEVICE_LABEL } from './icons';

export const UNIT_PX = 14;
const DRAG_TYPE = 'application/x-coreview-device';
const DRAG_FURNITURE = 'application/x-coreview-furniture';
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];
/** The colours a box can be given. */
const SWATCHES = ['#5ea1ff', '#3fb66a', '#e8a33d', '#e4564a', '#b07ff0', '#2cc6c6', '#f06fae', '#c9a227', '#98a3b3'];

type View = RackFace | 'side' | 'floor';

/** Which device or item is being dragged. `dataTransfer` cannot be read
 *  during dragover, only on drop, so the preview needs its own note of it. */
let dragging: { id: string; units: number; label: string; kind: 'device' | 'furniture' | 'new'; furniture?: FurnitureKind; rackId?: string } | null = null;

const sameRack = (a: string | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/** The colour a stack's cables are drawn in: one per stack, from the wheel. */
const stackColour = (index: number) => GROUP_WHEEL_DARK[index % GROUP_WHEEL_DARK.length]!;

/** The face a drop on this view lands on: the side view mounts on the front. */
const faceOfView = (view: View): RackFace => (view === 'rear' ? 'rear' : 'front');
/** The rack layout Ctrl+C took, until Ctrl+V. Lives for the window, like a clipboard. */
let layoutClip: RackLayout | null = null;

export function RackPanel() {
  // The racks and the pages, not the whole document.
  const pages = useStore((s) => s.doc.pages);
  const docRacks = useStore((s) => s.doc.racks);
  const docStacks = useStore((s) => s.doc.stacks);
  const docTemplates = useStore((s) => s.doc.deviceTemplates);
  const meta = useStore((s) => s.meta);
  const exportFolder = useStore((s) => s.settings.exportFolder);
  const ground = useStore((s) => s.settings.ground);
  const nodeStatus = useStore((s) => s.nodeStatus);
  const linkStatus = useStore((s) => s.linkStatus);
  const store = useStore.getState;
  const [view, setView] = useState<View>('front');
  // The diagram's links, as the racks draw them.
  const [showCables, setShowCables] = useState(true);
  const links = useMemo<LinkLike[]>(
    () => allEdges({ pages }).filter((e) => (e.data as LinkData | undefined)?.kind !== 'leader').map((e) => {
      const d = (e.data ?? {}) as LinkData;
      return { id: e.id, source: e.source, target: e.target, sourcePortLabel: d.sourcePortLabel, targetPortLabel: d.targetPortLabel, cableType: d.cableType, cableLength: d.cableLength, color: d.color, colorMode: d.colorMode };
    }),
    [pages],
  );
  const face = faceOfView(view);
  const [selected, setSelected] = useState<string | null>(null);
  // More boxes chosen with Shift-click; the arrows move them together.
  const [extra, setExtra] = useState<string[]>([]);
  const [find, setFind] = useState('');
  const [found, setFound] = useState<{ ids: string[]; at: number } | null>(null);
  const [newName, setNewName] = useState('');
  const [newUnits, setNewUnits] = useState(String(DEFAULT_RACK_UNITS));
  const [filter, setFilter] = useState('');
  const [placeFilter, setPlaceFilter] = useState('');
  const [hover, setHover] = useState<{ rackId: string; u: number; units: number; problem: string | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  // The rack new furniture goes to when it is clicked rather than dragged.
  const [targetRack, setTargetRack] = useState<string | null>(null);
  const [stackEditor, setStackEditor] = useState<{ id?: string; name: string; technology: string; topology: StackTopology; members: string[] } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const racks = useMemo(() => docRacks ?? [], [docRacks]);
  const stacks = useMemo(() => docStacks ?? [], [docStacks]);
  // The generic templates, then what the operator imported.
  const templates = useMemo<DeviceTemplate[]>(() => [...GENERIC_TEMPLATES, ...(docTemplates ?? [])], [docTemplates]);
  const [templateId, setTemplateId] = useState(GENERIC_TEMPLATES[0]!.id);
  const template = templates.find((x) => x.id === templateId) ?? templates[0]!;
  const fileRef = useRef<HTMLInputElement>(null);
  const devices = useMemo(() => {
    const memberOf = new Map<string, { id: string; name: string; member: number; role?: string }>();
    stacks.forEach((s) => {
      const preset = stackPreset(s.technology);
      s.members.forEach((m, i) => memberOf.set(m.nodeId, { id: s.id, name: s.name, member: m.number, role: roleOf(i, preset, m.role) }));
    });
    return allNodes({ pages })
      .filter((n) => n.type === 'device')
      .map((n) => {
        const r = rackableOf(n.id, n.data as DeviceNodeData);
        r.status = nodeStatus(n.id);
        const st = memberOf.get(n.id);
        if (st) r.stack = st;
        return r;
      });
  }, [pages, stacks, nodeStatus]);
  const byId = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  const furnitureById = useMemo(() => {
    const m = new Map<string, { rack: Rack; item: Rackable }>();
    for (const rack of racks) for (const f of furnitureRackables(rack)) m.set(f.id, { rack, item: f });
    return m;
  }, [racks]);
  const rackNames = new Set(racks.map((r) => r.name.trim().toLowerCase()));
  // Everything with a height that is not yet in a U of a rack that exists.
  const waiting = devices.filter(
    (d) =>
      takesSpace(d) &&
      !(d.rackU !== undefined && rackNames.has((d.rack ?? '').trim().toLowerCase())) &&
      (!filter.trim() || `${d.label} ${d.rack ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())),
  );
  const chosen: Rackable | undefined = selected ? (byId.get(selected) ?? furnitureById.get(selected)?.item) : undefined;
  // The diagram's selected link, when it is one of the rack's cables.
  const selectedEdge = useStore((s) => s.selectedEdgeId);
  const cableLink = selectedEdge ? links.find((l) => l.id === selectedEdge) : undefined;
  const chosenRack = chosen ? racks.find((r) => sameRack(chosen.rack, r.name)) : undefined;
  const chosenIds = useMemo(() => (selected ? [selected, ...extra.filter((id) => id !== selected)] : []), [selected, extra]);
  const choose = (id: string | null, additive = false) => {
    // Choosing a box is leaving the link; its cable goes out.
    if (id && useStore.getState().selectedEdgeId) useStore.getState().select(null, null);
    if (!additive || !id) {
      setSelected(id);
      setExtra([]);
      return;
    }
    if (!selected) { setSelected(id); return; }
    if (id === selected) {
      // Dropping the anchor: the next one becomes it.
      setSelected(extra[0] ?? null);
      setExtra(extra.slice(1));
      return;
    }
    setExtra(extra.includes(id) ? extra.filter((x) => x !== id) : [...extra, id]);
  };
  /** The next box whose name has the search, across every rack, chosen and scrolled to. */
  const findNext = () => {
    const q = find.trim().toLowerCase();
    if (!q) { setFound(null); return; }
    const inRacks = [...devices, ...racks.flatMap((r) => furnitureRackables(r))].filter((d) => d.rackU !== undefined && racks.some((r) => sameRack(d.rack, r.name)));
    const ids = inRacks.filter((d) => d.label.toLowerCase().includes(q)).map((d) => d.id);
    if (ids.length === 0) { setFound({ ids, at: 0 }); say(`Nothing in a rack is called "${find.trim()}".`, ''); return; }
    const at = found && found.ids.join() === ids.join() ? (found.at + 1) % ids.length : 0;
    setFound({ ids, at });
    const id = ids[at]!;
    const d = inRacks.find((x) => x.id === id)!;
    const rack = racks.find((r) => sameRack(d.rack, r.name));
    if (rack && placeFilter.trim() && !shownRacks.some((r) => r.id === rack.id)) setPlaceFilter('');
    choose(id);
    if (rack) setTargetRack(rack.id);
    setMessage(`${d.label}: ${rack?.name ?? ''} U${d.rackU} — ${at + 1} of ${ids.length}.`);
    requestAnimationFrame(() => stageRef.current?.querySelector<HTMLElement>(`[data-device="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }));
  };
  const shownRacks = placeFilter.trim()
    ? racks.filter((r) => `${placeOf(r)} ${r.name}`.toLowerCase().includes(placeFilter.trim().toLowerCase()))
    : racks;
  const groups = groupRacks(shownRacks);
  const target = racks.find((r) => r.id === targetRack) ?? chosenRack ?? racks[0];

  const say = (problem: string | null, done: string) => setMessage(problem ?? done);

  /** Everything the placement rules must see for a rack: the diagram's devices and the rack's own furniture. */
  const allFor = (rack: Rack) => [...devices, ...furnitureRackables(rack)];

  const dropAt = (rack: Rack, e: React.DragEvent<HTMLElement>, units: number, item?: Rackable) => {
    // Measured from inside the rail's border, where the first U starts; the
    // stage may be zoomed, so a U is UNIT_PX times that on screen.
    const slots = e.currentTarget.getBoundingClientRect();
    const u = uAt((e.clientY - slots.top) / zoom - e.currentTarget.clientTop, UNIT_PX, rack.units, units);
    const probe: Rackable = item ?? { id: '\u0000new', label: dragging?.label ?? '', rackUnits: units, rackFace: face, rackDepth: 'full', kind: 'furniture' };
    return { u, problem: placementProblem(rack, allFor(rack), probe, u, face) };
  };

  // The air a rack moves, for the floor's aisles.
  const airOfRack = (rack: Rack) => airflowOf(allFor(rack).filter((d) => sameRack(d.rack, rack.name) && d.rackU !== undefined && takesSpace(d)));
  const exportSvg = async () => {
    if (view === 'floor') {
      const group = groups.find((g) => g.racks.some((r) => r.id === target?.id)) ?? groups[0];
      if (!group) return;
      const svg = floorSvg(group.heading, footprintsFor(group.racks), airOfRack);
      const path = await saveExport(`${slug(meta?.name ?? 'project')}-floor.svg`, svg, 'image/svg+xml', exportFolder);
      if (path) setMessage(`Saved the floor of ${group.heading || 'the racks'} to ${path}.`);
      return;
    }
    const svg = rackElevationSvg(racks, devices, face, { stacks, links: showCables ? links : [], statusOf: linkStatus, project: meta?.name, revision: racks.find((r) => r.revision)?.revision });
    const path = await saveExport(`${slug(meta?.name ?? 'project')}-racks-${face}.svg`, svg, 'image/svg+xml', exportFolder);
    if (path) setMessage(`Saved the ${face} elevations to ${path}.`);
  };

  // The drawing for anyone's CAD.
  const exportDxf = async () => {
    const dxf = rackElevationDxf(racks, devices, face, { project: meta?.name, revision: racks.find((r) => r.revision)?.revision, links: showCables ? links : [] });
    const path = await saveExport(`${slug(meta?.name ?? 'project')}-racks-${face}.dxf`, dxf, 'application/dxf', exportFolder);
    if (path) setMessage(`Saved the ${face} elevations as DXF to ${path}.`);
  };

  const exportPng = async () => {
    const svg = rackElevationSvg(racks, devices, face, { stacks, links: showCables ? links : [], statusOf: linkStatus, project: meta?.name, revision: racks.find((r) => r.revision)?.revision });
    const blob = await svgToPng(svg);
    if (!blob) {
      setMessage('This browser could not rasterise the drawing; the SVG export is the same picture.');
      return;
    }
    const path = await saveExport(`${slug(meta?.name ?? 'project')}-racks-${face}.png`, new Uint8Array(await blob.arrayBuffer()), 'image/png', exportFolder);
    if (path) setMessage(`Saved the ${face} elevations to ${path}.`);
  };

  const fit = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const inner = stage.querySelector<HTMLElement>('.cv-racks-zoom');
    if (!inner) return;
    const w = inner.scrollWidth / zoom;
    const h = inner.scrollHeight / zoom;
    const z = Math.min(2, Math.max(0.3, Math.min((stage.clientWidth - 24) / w, (stage.clientHeight - 24) / h)));
    setZoom(Math.round(z * 100) / 100);
  };
  const zoomStep = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 0.001);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))]!;
    setZoom(next);
  };
  // Ctrl+wheel zooms the stage; a plain wheel scrolls it.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.round(Math.min(2, Math.max(0.3, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))) * 100) / 100);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  const addFurnitureTo = (rack: Rack | undefined, kind: FurnitureKind, u?: number) => {
    if (!rack) {
      setMessage('Add a rack first, then what goes in it.');
      return;
    }
    const spec = furnitureSpec(kind);
    const label = kind === 'reserved' ? 'Reserved' : spec.label;
    // Clicked rather than dropped: the first free U from the top, like a
    // device built into a rack; a zero-U item has no U. Either way it lands
    // on the face being looked at.
    if (u === undefined && spec.units > 0) {
      const probe: Rackable = { id: '\u0000new', label, rack: rack.name, rackUnits: spec.units, rackFace: face, rackDepth: spec.depth, kind: 'furniture', furniture: kind };
      const free = firstFreeU(rack, allFor(rack), probe);
      if (free === null) {
        setMessage(`No room in ${rack.name} for ${label}.`);
        return;
      }
      u = free;
    }
    const problem = store().addFurniture(rack.id, kind, label, undefined, u, face);
    say(problem, `${label} added to ${rack.name}${u !== undefined ? ` at U${u}` : ''}.`);
    if (!problem) {
      const added = (store().doc.racks ?? []).find((r) => r.id === rack.id)?.items?.at(-1);
      if (added) setSelected(added.id);
    }
  };

  /** A template becomes furniture on the rack, or sets a drawn device's rack fields. */
  const addFromTemplate = (rack: Rack | undefined, tpl: DeviceTemplate) => {
    if (!rack) {
      setMessage('Add a rack first, then what goes in it.');
      return;
    }
    const kind: FurnitureKind = tpl.furniture ?? (tpl.deviceType === 'server' ? 'server' : tpl.deviceType === 'storage' ? 'storage' : 'other');
    const probe: Rackable = { id: '\u0000new', label: tpl.name, rack: rack.name, rackUnits: tpl.units, rackFace: face, rackDepth: tpl.depth, kind: 'furniture', furniture: kind };
    const u = tpl.units > 0 ? firstFreeU(rack, allFor(rack), probe) : undefined;
    if (tpl.units > 0 && u === null) {
      setMessage(`No room in ${rack.name} for ${tpl.name}.`);
      return;
    }
    const problem = store().addFurniture(rack.id, kind, tpl.name, tpl.units, u ?? undefined, face);
    if (problem) {
      setMessage(problem);
      return;
    }
    const added = (store().doc.racks ?? []).find((r) => r.id === rack.id)?.items?.at(-1);
    if (added) {
      store().updateFurniture(rack.id, added.id, { depth: tpl.depth, depthMm: tpl.depthMm, outlets: tpl.outlets, powerW: tpl.powerW, weightKg: tpl.weightKg, airflow: tpl.airflow, ports: tpl.ports, note: tpl.note });
      setSelected(added.id);
    }
    setMessage(`${tpl.name} added to ${rack.name}${u ? ` at U${u}` : ''}.`);
  };
  const applyTemplate = (tpl: DeviceTemplate) => {
    if (!chosen || chosen.kind === 'furniture') return;
    say(store().applyTemplate(chosen.id, tpl), `${chosen.label} is now a ${tpl.name}: ${tpl.units}U, ${tpl.ports ?? 0} ports.`);
  };
  const importTemplate = async (text: string, name: string) => {
    const r = templateFromNetboxYaml(text, `nb-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    if ('problem' in r) {
      setMessage(r.problem);
      return;
    }
    const problem = store().addTemplate(r.template);
    say(problem, t('rackPanel.templateImported', { name: r.template.name, units: r.template.units }));
    if (!problem) setTemplateId(r.template.id);
  };
  const pickTemplateFile = async () => {
    if (!isDesktop) {
      fileRef.current?.click();
      return;
    }
    try {
      const path = await ipc.pickImportFile();
      if (!path) return;
      await importTemplate(await ipc.readImport(path), path.split(/[\\/]/).pop() ?? path);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const stackOf = (id: string) => stacks.find((s) => s.id === id);
  const openStackEditor = (s: Stack) =>
    setStackEditor({ id: s.id, name: s.name, technology: s.technology, topology: s.topology, members: s.members.map((m) => m.nodeId) });

  return (
    <div
      className="cv-racks"
      onKeyDown={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
        // Ctrl+C copies the target rack's layout, Ctrl+V pastes it into the target.
        if ((e.ctrlKey || e.metaKey) && !typing && (e.key === 'c' || e.key === 'v') && target) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'c') { layoutClip = layoutOf(target); setMessage(`${target.name}: layout copied — ${layoutClip.items.length} items. Choose another rack and press Ctrl+V.`); }
          else if (!layoutClip) setMessage('Nothing copied yet — Ctrl+C on a rack first.');
          else setMessage(store().pasteLayout(target.id, layoutClip));
          return;
        }
        if (!chosen || typing) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          e.stopPropagation();
          const n = chosenIds.length;
          store().takeOut(chosenIds);
          choose(null);
          setMessage(n > 1 ? `${n} taken out of the rack.` : `${chosen.label} taken out of the rack.`);
          return;
        }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        const rack = chosenRack;
        if (!rack || chosen.rackU === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === 'ArrowUp' ? 1 : -1;
        const problem = store().shiftInRack(rack.id, chosenIds, delta);
        say(problem, chosenIds.length > 1 ? `${chosenIds.length} moved ${delta > 0 ? 'up' : 'down'} one U.` : `${chosen.label} moved to U${chosen.rackU + delta}.`);
      }}
    >
      <div className="cv-racks-bar">
        <div className="cv-seg" role="group" aria-label={t('rackPanel.rackFace')}>
          {(['front', 'rear', 'side', 'floor'] as const).map((f) => (
            <button key={f} type="button" className={view === f ? 'is-on' : ''} aria-pressed={view === f} title={f === 'side' ? t('rackPanel.sideHint') : f === 'floor' ? t('rackPanel.floorHint') : undefined} onClick={() => setView(f)}>
              {f === 'front' ? 'Front' : f === 'rear' ? 'Rear' : f === 'side' ? t('rackPanel.side') : t('rackPanel.floor')}
            </button>
          ))}
        </div>
        <form
          className="cv-row cv-row-tight"
          onSubmit={(e) => {
            e.preventDefault();
            const problem = store().addRack(newName, Number(newUnits));
            say(problem, `Added ${newName.trim()}.`);
            if (!problem) setNewName('');
          }}
        >
          <input className="cv-input" aria-label={t('rackPanel.newRackName')} placeholder={t('rackPanel.rackName')} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input
            className="cv-input cv-input-narrow"
            aria-label={t('rackPanel.newRackHeightIn')}
            type="number"
            min={1}
            max={MAX_RACK_UNITS}
            value={newUnits}
            onChange={(e) => setNewUnits(e.target.value)}
          />
          <button type="submit" className="cv-btn cv-btn-small">
            {t('rackPanel.addRack')}
          </button>
        </form>
        <button
          type="button"
          className="cv-btn cv-btn-small"
          title={t('rackPanel.aRackForEvery')}
          onClick={() => {
            const got = store().buildRacksFromDevices();
            setMessage(
              got.racks === 0 && got.placed === 0
                ? got.full.length
                  ? `No room for ${got.full.join(', ')}.`
                  : 'Nothing to add: every device that names a rack is already in it.'
                : `Added ${t('plural.rack', { count: got.racks })} and placed ${t('plural.device', { count: got.placed })}.` +
                    (got.full.length ? ` No room for ${got.full.join(', ')}.` : ''),
            );
          }}
        >
          {t('rackPanel.buildRacksFromDevices')}
        </button>
        <button type="button" className="cv-btn cv-btn-small" disabled={racks.length === 0} onClick={() => void exportSvg()}>
          Export {view === 'floor' ? 'floor' : face} as SVG
        </button>
        <button type="button" className="cv-btn cv-btn-small" disabled={racks.length === 0} onClick={() => void exportPng()}>
          {t('rackPanel.exportPng', { face })}
        </button>
        <button type="button" className="cv-btn cv-btn-small" disabled={racks.length === 0} title={t('rackPanel.exportDxfHint')} onClick={() => void exportDxf()}>
          {t('rackPanel.exportDxf', { face })}
        </button>
        <button type="button" className="cv-btn cv-btn-small" disabled={racks.length === 0} title={t('rackPanel.printHint')} onClick={() => window.print()}>
          {t('rackPanel.print')}
        </button>
        {/* The zoom. */}
        <div className="cv-racks-zoomctl" role="group" aria-label={t('rackPanel.zoom')}>
          <button type="button" className="cv-btn cv-btn-small" aria-label={t('rackPanel.zoomOut')} onClick={() => zoomStep(-1)}>−</button>
          <button type="button" className="cv-btn cv-btn-small cv-racks-zoomvalue" title={t('rackPanel.zoomReset')} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" className="cv-btn cv-btn-small" aria-label={t('rackPanel.zoomIn')} onClick={() => zoomStep(1)}>+</button>
          <button type="button" className="cv-btn cv-btn-small" onClick={fit}>{t('rackPanel.fit')}</button>
        </div>
        {/* The diagram's links as cables, and the cords, on or off. */}
        <label className="cv-check cv-check-inline" title={t('rackPanel.cablesHint')}>
          <input type="checkbox" checked={showCables} onChange={(e) => setShowCables(e.target.checked)} />
          {t('rackPanel.cables')}
        </label>
        <form className="cv-racks-find" onSubmit={(e) => { e.preventDefault(); findNext(); }} role="search">
          <input className="cv-input" aria-label={t('rackPanel.find')} placeholder={t('rackPanel.find')} title={t('rackPanel.findHint')} value={find} onChange={(e) => { setFind(e.target.value); setFound(null); }} />
          {found && found.ids.length > 0 && <span className="cv-racks-find-count">{found.at + 1}/{found.ids.length}</span>}
        </form>
        {racks.length > 1 && (
          <input className="cv-input cv-racks-place-filter" aria-label={t('rackPanel.placeFilter')} placeholder={t('rackPanel.placeFilter')} value={placeFilter} onChange={(e) => setPlaceFilter(e.target.value)} />
        )}
        {message && (
          <span className="cv-racks-message" role="status">
            {message}
          </span>
        )}
      </div>

      {/* A selected cable gets a bar of its own: its ends and a colour. */}
      {!chosen && cableLink && (
        <div className="cv-racks-chosen cv-racks-cablebar" data-region="cable-bar">
          <strong>{byId.get(cableLink.source)?.label ?? cableLink.source} {cableLink.sourcePortLabel ?? ''} ↔ {byId.get(cableLink.target)?.label ?? cableLink.target} {cableLink.targetPortLabel ?? ''}</strong>
          <span>{cableLink.cableType ?? t('rackPanel.cableUntyped')}{cableLink.cableLength ? ` · ${cableLink.cableLength}` : ''}</span>
          <span className="cv-racks-swatches" role="group" aria-label={t('rackPanel.cableColour')} data-region="cable-colour">
            {SWATCHES.map((c) => (
              <button key={c} type="button" className={`cv-swatch${cableLink.colorMode === 'fixed' && cableLink.color === c ? ' is-on' : ''}`} style={{ background: c }} aria-label={`${t('rackPanel.cableColour')} ${c}`} aria-pressed={cableLink.colorMode === 'fixed' && cableLink.color === c}
                onClick={() => { store().commit(); store().updateEdgeData(cableLink.id, { color: c, colorMode: 'fixed' }); setMessage(t('rackPanel.cableColoured')); }} />
            ))}
            <button type="button" className={`cv-swatch is-none${cableLink.colorMode !== 'fixed' ? ' is-on' : ''}`} aria-label={t('rackPanel.cableAutoColour')} aria-pressed={cableLink.colorMode !== 'fixed'} title={t('rackPanel.cableAutoColour')}
              onClick={() => { store().commit(); store().updateEdgeData(cableLink.id, { colorMode: 'status' }); setMessage(t('rackPanel.cableAuto')); }}>×</button>
          </span>
        </div>
      )}
      {chosen && (
        <ChosenBar
          chosen={chosen}
          rack={chosenRack}
          pdus={chosenRack ? allFor(chosenRack).filter((d) => sameRack(d.rack, chosenRack.name) && isPdu(d) && d.id !== chosen.id) : []}
          stack={chosen.stack ? stackOf(chosen.stack.id) : undefined}
          say={say}
          onEditStack={openStackEditor}
          onRemoved={() => choose(null)}
          chosenIds={chosenIds}
        />
      )}

      {/* The stack editor is a card across the top, not a column. */}
      {stackEditor && (
        <StackEditor
          draft={stackEditor}
          devices={devices}
          onChange={setStackEditor}
          onClose={() => setStackEditor(null)}
          say={say}
        />
      )}

      <div className="cv-racks-body">
        <aside className="cv-racks-waiting">
          <input className="cv-input" aria-label={t('rackPanel.filterDevices')} placeholder={t('rackPanel.filterDevices')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <p className="cv-help">{t('rackPanel.dragADeviceInto')}</p>
          <ul>
            {waiting.slice(0, 200).map((d) => (
              <li
                key={d.id}
                draggable
                className={`cv-racks-device${selected === d.id ? ' is-selected' : ''}`}
                onDragStart={(e) => {
                  dragging = { id: d.id, units: d.rackUnits!, label: d.label, kind: 'device' };
                  e.dataTransfer.setData(DRAG_TYPE, d.id);
                }}
                onDragEnd={() => {
                  dragging = null;
                }}
                onClick={() => setSelected(d.id)}
              >
                <span className="cv-racks-device-name">
                  <DeviceGlyph type={(d.deviceType ?? 'generic') as DeviceType} className="cv-racks-device-glyph" style={{ color: d.colour ?? deviceColor(d.deviceType ?? 'generic', ground) }} />
                  {d.label}
                </span>
                <span className="cv-racks-units">
                  {d.rackUnits}U{d.rack ? ` · ${d.rack}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {waiting.length > 200 && <p className="cv-help">{waiting.length - 200} more — filter to find them.</p>}

          {/* What a rack holds that is not on the diagram. */}
          <h4 className="cv-racks-side-head">{t('rackPanel.furniture')}</h4>
          <p className="cv-help">
            {t('rackPanel.furnitureHint', { rack: target?.name ?? '—' })}
          </p>
          <div className="cv-racks-furniture" data-region="rack-furniture">
            {FURNITURE.map((f) => (
              <button
                key={f.kind}
                type="button"
                className={`cv-btn cv-btn-small cv-racks-furniture-item is-${f.kind}`}
                draggable
                title={`${f.hint} ${f.units === 0 ? 'Zero-U.' : `${f.units}U by default.`}`}
                data-kind={f.kind}
                onDragStart={(e) => {
                  dragging = { id: '\u0000new', units: f.units, label: f.label, kind: 'new', furniture: f.kind };
                  e.dataTransfer.setData(DRAG_FURNITURE, f.kind);
                }}
                onDragEnd={() => {
                  dragging = null;
                }}
                onClick={() => addFurnitureTo(target, f.kind)}
              >
                <FurnitureGlyph kind={f.kind} />
                {f.label}
              </button>
            ))}
          </div>

          {/* Templates, ours and the operator's. */}
          <h4 className="cv-racks-side-head">{t('rackPanel.templates')}</h4>
          <div className="cv-racks-templates" data-region="rack-templates">
            <select className="cv-input" aria-label={t('rackPanel.template')} value={template.id} onChange={(e) => setTemplateId(e.target.value)}>
              <optgroup label={t('rackPanel.templatesGeneric')}>
                {GENERIC_TEMPLATES.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </optgroup>
              {(docTemplates ?? []).length > 0 && (
                <optgroup label={t('rackPanel.templatesImported')}>
                  {(docTemplates ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </optgroup>
              )}
            </select>
            <p className="cv-help cv-racks-template-line" data-region="template-line">
              {t('rackPanel.templateLine', { units: template.units, depth: template.depthMm ? `${template.depthMm} mm` : template.depth, ports: template.ports ?? template.outlets ?? 0, watts: template.powerW ?? 0, kg: template.weightKg ?? 0 })}
              {template.note ? ` · ${template.note}` : ''}
            </p>
            <div className="cv-row cv-row-tight">
              {(template.deviceType || !template.furniture) && (
                <button type="button" className="cv-btn cv-btn-small" disabled={!chosen || chosen.kind === 'furniture'} title={t('rackPanel.applyTemplateHint')} onClick={() => applyTemplate(template)}>
                  {chosen && chosen.kind !== 'furniture' ? t('rackPanel.applyTemplateTo', { name: chosen.label }) : t('rackPanel.applyTemplate')}
                </button>
              )}
              <button type="button" className="cv-btn cv-btn-small" title={t('rackPanel.addTemplateHint')} onClick={() => addFromTemplate(target, template)}>
                {t('rackPanel.addTemplateTo', { rack: target?.name ?? '—' })}
              </button>
              {template.source === 'netbox' && (
                <button type="button" className="cv-btn cv-btn-small is-danger" onClick={() => { store().removeTemplate(template.id); setTemplateId(GENERIC_TEMPLATES[0]!.id); }}>
                  {t('rackPanel.removeTemplate')}
                </button>
              )}
            </div>
            <button type="button" className="cv-btn cv-btn-small" title={t('rackPanel.importTemplateHint')} onClick={() => void pickTemplateFile()}>
              {t('rackPanel.importTemplate')}
            </button>
            <input ref={fileRef} type="file" accept=".yaml,.yml,text/yaml" hidden aria-label={t('rackPanel.importTemplate')}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void f.text().then((text) => importTemplate(text, f.name)); }} />
          </div>

          {/* The stacks. */}
          <h4 className="cv-racks-side-head">{t('rackPanel.stacks')}</h4>
          <ul className="cv-racks-stacks" data-region="rack-stacks">
            {stacks.map((s, i) => {
              const preset = stackPreset(s.technology);
              return (
                <li key={s.id} className="cv-racks-stack">
                  <i className="cv-racks-stack-swatch" style={{ background: stackColour(i) }} aria-hidden="true" />
                  <button type="button" className="cv-link-button" onClick={() => openStackEditor(s)}>
                    {s.name}
                  </button>
                  <span className="cv-help">
                    {preset?.name ?? s.technology} · {s.topology} · {t('plural.member', { count: s.members.length })}
                  </span>
                </li>
              );
            })}
          </ul>
          <button type="button" className="cv-btn cv-btn-small" onClick={() => setStackEditor({ name: '', technology: 'cisco-stackwise-480', topology: 'ring', members: [] })}>
            {t('rackPanel.newStack')}
          </button>
        </aside>

        <div className="cv-racks-stage" ref={stageRef} data-region="rack-stage" data-view={view} onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
          {/* The scale, so a printed or captured stage says what a U is. */}
          {racks.length > 0 && (
            <div className="cv-racks-scale" data-region="rack-scale" aria-label={t('rackPanel.scale')}>
              <i style={{ width: 5 * UNIT_PX * zoom }} />
              <span>{t('rackPanel.scaleLine', { mm: Math.round(5 * 44.45) })}</span>
            </div>
          )}
          {racks.length === 0 && (
            <p className="cv-help cv-racks-empty">
              No racks yet. Add one, or give devices a rack name in the inspector (Rack / room) and build racks from them.
            </p>
          )}
          <div className="cv-racks-zoom" style={{ transform: `scale(${zoom})` }}>
            {groups.map((g) => (
              <section key={g.heading || '\u0000here'} className="cv-racks-place" aria-label={g.heading || t('rackPanel.noPlace')}>
                {g.heading && <h3 className="cv-racks-place-head">{g.heading}</h3>}
                {/* The floor — the room's racks as footprints. */}
                {view === 'floor' && (
                  <FloorView
                    heading={g.heading}
                    racks={g.racks}
                    zoom={zoom}
                    airOf={airOfRack}
                    target={target?.id ?? null}
                    onPick={(id) => { setTargetRack(id); choose(null); }}
                    onOpen={(id) => { setTargetRack(id); setView('front'); setMessage(t('rackPanel.openedFromFloor', { name: racks.find((r) => r.id === id)?.name ?? '' })); }}
                    say={say}
                  />
                )}
                <div className="cv-racks-row">
                  {view !== 'floor' && g.racks.map((rack) => (
                    <RackView
                      key={rack.id}
                      rack={rack}
                      view={view}
                      items={allFor(rack)}
                      stacks={stacks}
                      links={showCables ? links : []}
                      linkStatus={linkStatus}
                      zoom={zoom}
                      ground={ground}
                      selected={selected}
                      hover={hover?.rackId === rack.id ? hover : null}
                      isTarget={target?.id === rack.id}
                      onSelect={(id, additive) => { choose(id, additive); setTargetRack(rack.id); }}
                      chosenIds={chosenIds}
                      say={say}
                      onDragOver={(e) => {
                        e.preventDefault();
                        const types = [...e.dataTransfer.types];
                        if (!dragging || (!types.includes(DRAG_TYPE) && !types.includes(DRAG_FURNITURE))) return;
                        const item = dragging.kind === 'device' ? byId.get(dragging.id) : dragging.kind === 'furniture' ? furnitureById.get(dragging.id)?.item : undefined;
                        const units = item?.rackUnits ?? dragging.units;
                        if (!units) return;
                        const { u, problem } = dropAt(rack, e, units, item);
                        if (hover?.rackId !== rack.id || hover.u !== u || hover.problem !== problem) {
                          setHover({ rackId: rack.id, u, units, problem });
                        }
                      }}
                      onDragLeave={() => setHover(null)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setHover(null);
                        const deviceId = e.dataTransfer.getData(DRAG_TYPE);
                        const kind = e.dataTransfer.getData(DRAG_FURNITURE) as FurnitureKind | '';
                        if (deviceId && byId.has(deviceId)) {
                          const device = byId.get(deviceId)!;
                          const { u } = dropAt(rack, e, device.rackUnits!, device);
                          const problem = store().placeInRack(device.id, rack.id, u, face);
                          say(problem, `${device.label} placed in ${rack.name} at U${u}.`);
                          if (!problem) setSelected(device.id);
                        } else if (deviceId && furnitureById.has(deviceId)) {
                          // Furniture moved within or between racks.
                          const { rack: from, item } = furnitureById.get(deviceId)!;
                          const { u } = dropAt(rack, e, item.rackUnits!, item);
                          if (from.id === rack.id) {
                            say(store().placeFurniture(rack.id, item.id, u, face), `${item.label} moved to U${u}.`);
                          } else {
                            const f = from.items!.find((x) => x.id === item.id)!;
                            const problem = store().addFurniture(rack.id, f.kind, f.label, f.units, u, face);
                            if (!problem) store().removeFurniture(from.id, item.id);
                            say(problem, `${item.label} moved to ${rack.name} at U${u}.`);
                          }
                        } else if (kind) {
                          const spec = furnitureSpec(kind);
                          const { u } = dropAt(rack, e, spec.units);
                          addFurnitureTo(rack, kind, spec.units > 0 ? u : undefined);
                        }
                        dragging = null;
                      }}
                      onItemDragStart={(item) => {
                        dragging = { id: item.id, units: item.rackUnits!, label: item.label, kind: item.kind === 'furniture' ? 'furniture' : 'device', rackId: rack.id };
                      }}
                      onItemDragEnd={() => {
                        dragging = null;
                      }}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- a rack */

function RackView({
  rack, view, items, stacks, links, linkStatus, zoom, ground, selected, chosenIds, hover, isTarget, onSelect, say, onDragOver, onDragLeave, onDrop, onItemDragStart, onItemDragEnd,
}: {
  rack: Rack;
  view: View;
  items: Rackable[];
  stacks: Stack[];
  links: LinkLike[];
  linkStatus: (edgeId: string) => string;
  zoom: number;
  ground: 'light' | 'dark';
  selected: string | null;
  chosenIds: string[];
  hover: { u: number; units: number; problem: string | null } | null;
  isTarget: boolean;
  onSelect: (id: string | null, additive?: boolean) => void;
  say: (problem: string | null, done: string) => void;
  onDragOver: React.DragEventHandler<HTMLDivElement>;
  onDragLeave: () => void;
  onDrop: React.DragEventHandler<HTMLDivElement>;
  onItemDragStart: (item: Rackable) => void;
  onItemDragEnd: () => void;
}) {
  const store = useStore.getState;
  const face = faceOfView(view);
  const elev = elevation(rack, items, face);
  const members = items.filter((d) => sameRack(d.rack, rack.name));
  const usage = usageOf(rack, members);
  const air = airflowOf(members.filter((d) => d.rackU !== undefined && takesSpace(d)));
  const [where, setWhere] = useState(false);
  const place = placeOf(rack);
  // The side view shows every placed box, from the rail it is mounted on.
  const sideItems = useMemo(() => members.map((d) => ({ device: d, span: spanOf(d) })).filter((x): x is { device: Rackable; span: { bottom: number; top: number } } => x.span !== null && x.span.top <= rack.units), [members, rack.units]);
  const zeroHere = elev.zeroU.filter((d) => view === 'side' || (d.rackFace === 'rear') === (face === 'rear'));
  const slotsRef = useRef<HTMLDivElement>(null);
  // Patch cables on the front, power cords on the rear.
  const patch = useMemo(() => (view === 'front' ? patchCablesFor(rack.name, items, links, linkStatus) : []), [view, rack.name, items, links, linkStatus]);
  const cords = useMemo(() => (view === 'rear' && links.length >= 0 ? powerCordsFor(rack.name, items) : []), [view, rack.name, items, links.length]);
  const pdus = members.filter(isPdu);
  // What a planner would tell you about this rack.
  const advice = useMemo(() => rackAdvice(rack, members, stacks, links), [rack, members, stacks, links]);
  // The links that leave for devices in no rack, per box.
  const linksOut = useMemo(() => linksOutOf(patch), [patch]);
  // The selected link lights its cable; a click on a port cell
  // selects the link plugged into that port.
  const selectedEdgeId = useStore((s) => s.selectedEdgeId);
  const onPort = (itemId: string, n: number): boolean => {
    const c = patch.find((x) => (x.from.itemId === itemId && x.from.port === n) || (!('elsewhere' in x.to) && x.to.itemId === itemId && x.to.port === n));
    if (!c) return false;
    useStore.getState().select(null, c.edgeId);
    return true;
  };

  // The cables of every stack with a member placed in this rack, on
  // the face its ports are on.
  const cables = useMemo(() => {
    const out: { stack: Stack; colour: string; index: number; preset: ReturnType<typeof stackPreset>; lines: { fromId: string; toId: string; fromPort: string; toPort: string; kind: string; elsewhere?: string }[] }[] = [];
    if (view === 'side') return out;
    stacks.forEach((stack, index) => {
      const preset = stackPreset(stack.technology);
      const portsOn = preset?.portsOn ?? 'rear';
      if (portsOn !== face) return;
      const placedHere = (id: string) => {
        const d = items.find((x) => x.id === id);
        return d && sameRack(d.rack, rack.name) && d.rackU !== undefined;
      };
      if (!stack.members.some((m) => placedHere(m.nodeId))) return;
      const lines = stackCables(stack, preset).map((c) => {
        const from = stack.members[c.from.member]!.nodeId;
        const to = stack.members[c.to.member]!.nodeId;
        const other = !placedHere(from) ? from : !placedHere(to) ? to : undefined;
        const elsewhere = other ? (items.find((x) => x.id === other)?.rack || 'not racked') : undefined;
        return { fromId: from, toId: to, fromPort: c.from.port, toPort: c.to.port, kind: c.kind, elsewhere };
      });
      out.push({ stack, colour: stackColour(index), index, preset, lines });
    });
    return out;
  }, [stacks, items, rack.name, face, view]);

  // The rails count from the bottom or the top as the rack says;
  // in the side view the right rail is a millimetre ruler instead.
  const numbers = (side: 'left' | 'right') => (
    <ol className={`cv-rack-numbers is-${side}${side === 'right' && view === 'side' ? ' is-mm' : ''}`} aria-hidden="true" data-numbering={rack.numbering ?? 'bottom'}>
      {Array.from({ length: rack.units }, (_, i) => {
        const u = rack.units - i;
        const fifth = u % 5 === 0;
        return (
          <li key={i} style={{ height: UNIT_PX }} className={fifth ? 'is-fifth' : ''}>
            {side === 'right' && view === 'side' ? (fifth || u === rack.units ? Math.round(u * 44.45) : '') : uLabel(rack, u)}
          </li>
        );
      })}
    </ol>
  );

  return (
    <section className={`cv-rack${isTarget ? ' is-target' : ''} is-view-${view} is-form-${rack.form ?? '4-post'}`} aria-label={`Rack ${rack.name}`} data-rack-id={rack.id} data-form={rack.form ?? '4-post'} onClick={() => onSelect(selected)}>
      <header className="cv-rack-head">
        <input
          className="cv-input cv-rack-name"
          aria-label={t('rackPanel.rackName')}
          defaultValue={rack.name}
          onBlur={(e) => {
            if (e.target.value.trim() === rack.name) return;
            const problem = store().updateRack(rack.id, { name: e.target.value });
            if (problem) e.target.value = rack.name;
            say(problem, `Renamed to ${e.target.value.trim()}.`);
          }}
        />
        <input
          className="cv-input cv-input-narrow"
          aria-label={t('rackPanel.rackHeightInU')}
          type="number"
          min={1}
          max={MAX_RACK_UNITS}
          defaultValue={rack.units}
          onBlur={(e) => {
            if (Number(e.target.value) === rack.units) return;
            const problem = store().updateRack(rack.id, { units: Number(e.target.value) });
            if (problem) e.target.value = String(rack.units);
            say(problem, `${rack.name} is ${e.target.value}U.`);
          }}
        />
        <button type="button" className={`cv-btn cv-btn-small cv-rack-where${where ? ' is-active' : ''}`} aria-pressed={where} title={t('rackPanel.whereHint')} onClick={() => setWhere((w) => !w)}>
          {t('rackPanel.where')}
        </button>
        <button type="button" className="cv-btn cv-btn-small cv-rack-duplicate" aria-label={`Duplicate rack ${rack.name}`} title={t('rackPanel.duplicateHint')} onClick={(e) => {
          // The same rack again, furniture and all, beside this one.
          e.stopPropagation();
          const id = store().duplicateRack(rack.id);
          if (id) { onSelect(null); say(null, t('rackPanel.duplicated', { name: store().doc.racks?.find((r) => r.id === id)?.name ?? '' })); }
        }}>
          ⧉
        </button>
        <button type="button" className="cv-layer-remove" aria-label={`Remove rack ${rack.name}`} title={t('rackPanel.removeThisRackDevices')} onClick={() => {
          // A rack is not removed by a slip of the pointer.
          const boxes = members.filter((d) => d.kind !== 'furniture' && d.rackU !== undefined).length;
          if (!window.confirm(t('rackPanel.confirmRemove', { name: rack.name, boxes, items: (rack.items ?? []).length }))) return;
          store().removeRack(rack.id);
        }}>
          ×
        </button>
      </header>
      {!where && (
        <div className="cv-rack-place" data-region="rack-place">
          {place || ' '}
          <span className="cv-rack-size" data-region="rack-dims">{t('rackPanel.dims', { height: rackHeightMm(rack), units: rack.units, depth: rack.depthMm ?? DEFAULT_RACK_DEPTH_MM, width: rack.widthMm ?? DEFAULT_RACK_WIDTH_MM, form: t(`rackPanel.form.${rack.form ?? '4-post'}`) })}</span>
        </div>
      )}
      {where && (
        <div className="cv-rack-wherefields" data-region="rack-where">
          {([['building', 'Building'], ['floor', 'Floor'], ['room', 'Room'], ['row', 'Row'], ['position', 'Position']] as const).map(([k, label]) => (
            <label key={k} className="cv-field cv-field-narrow">
              <span>{label}</span>
              <input className="cv-input" defaultValue={rack[k] ?? ''} aria-label={`${label} of rack ${rack.name}`}
                onBlur={(e) => { if ((e.target.value.trim() || undefined) !== rack[k]) say(store().updateRack(rack.id, { [k]: e.target.value }), `${rack.name}: ${label.toLowerCase()} set.`); }} />
            </label>
          ))}
          <label className="cv-field cv-field-narrow">
            <span>{t('rackPanel.rackWidth')}</span>
            <input className="cv-input" type="number" min={0} placeholder={String(DEFAULT_RACK_WIDTH_MM)} defaultValue={rack.widthMm ?? ''} aria-label={`Width of rack ${rack.name} in millimetres`}
              onBlur={(e) => say(store().updateRack(rack.id, { widthMm: Number(e.target.value) || 0 }), `${rack.name}: width set.`)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('rackPanel.rackDepth')}</span>
            <input className="cv-input" type="number" min={0} placeholder={String(DEFAULT_RACK_DEPTH_MM)} defaultValue={rack.depthMm ?? ''} aria-label={`Depth of rack ${rack.name} in millimetres`}
              onBlur={(e) => say(store().updateRack(rack.id, { depthMm: Number(e.target.value) || 0 }), `${rack.name}: depth set.`)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('rackPanel.numbering')}</span>
            <select className="cv-input" aria-label={`Numbering of rack ${rack.name}`} defaultValue={rack.numbering ?? 'bottom'}
              onChange={(e) => say(store().updateRack(rack.id, { numbering: e.target.value as 'bottom' | 'top' }), `${rack.name}: numbered from the ${e.target.value}.`)}>
              <option value="bottom">{t('rackPanel.numberingBottom')}</option>
              <option value="top">{t('rackPanel.numberingTop')}</option>
            </select>
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('rackPanel.formLabel')}</span>
            <select className="cv-input" aria-label={`Form of rack ${rack.name}`} defaultValue={rack.form ?? '4-post'}
              onChange={(e) => say(store().updateRack(rack.id, { form: e.target.value as '2-post' | '4-post' | 'enclosed' }), `${rack.name}: ${e.target.value}.`)}>
              {(['2-post', '4-post', 'enclosed'] as const).map((f) => <option key={f} value={f}>{t(`rackPanel.form.${f}`)}</option>)}
            </select>
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('rackPanel.revision')}</span>
            <input className="cv-input" defaultValue={rack.revision ?? ''} aria-label={`Revision of rack ${rack.name}`} placeholder="A"
              onBlur={(e) => { if ((e.target.value.trim() || undefined) !== rack.revision) say(store().updateRack(rack.id, { revision: e.target.value }), `${rack.name}: revision ${e.target.value.trim() || 'cleared'}.`); }} />
          </label>
          {/* The layout, carried to another rack. */}
          <span className="cv-racks-layoutbtns">
            <button type="button" className="cv-btn cv-btn-small" title={t('rackPanel.copyLayoutHint')}
              onClick={(e) => { e.stopPropagation(); layoutClip = layoutOf(rack); say(null, t('rackPanel.copiedLayout', { name: rack.name, count: layoutClip.items.length })); }}>
              {t('rackPanel.copyLayout')}
            </button>
            <button type="button" className="cv-btn cv-btn-small" disabled={!layoutClip} title={t('rackPanel.pasteLayoutHint')}
              onClick={(e) => { e.stopPropagation(); if (layoutClip) say(null, store().pasteLayout(rack.id, layoutClip)); }}>
              {t('rackPanel.pasteLayout')}
            </button>
          </span>
          <label className="cv-field cv-field-narrow">
            <span>{t('rackPanel.powerLimit')}</span>
            <input className="cv-input" type="number" min={0} defaultValue={rack.powerLimitW ?? ''} aria-label={`Power limit of rack ${rack.name}`}
              onBlur={(e) => say(store().updateRack(rack.id, { powerLimitW: Number(e.target.value) || 0 }), `${rack.name}: power limit set.`)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('rackPanel.weightLimit')}</span>
            <input className="cv-input" type="number" min={0} defaultValue={rack.weightLimitKg ?? ''} aria-label={`Weight limit of rack ${rack.name}`}
              onBlur={(e) => say(store().updateRack(rack.id, { weightLimitKg: Number(e.target.value) || 0 }), `${rack.name}: weight limit set.`)} />
          </label>
        </div>
      )}
      <div className="cv-rack-frame">
        {numbers('left')}
        <div className="cv-rack-post is-left" aria-hidden="true" style={{ height: rack.units * UNIT_PX }} />
        <div
          ref={slotsRef}
          className="cv-rack-slots"
          data-rack={rack.name}
          style={{ height: rack.units * UNIT_PX, ['--zerou' as string]: zeroHere.length }}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
        >
          {view !== 'side' && elev.items.map((item) => (
            <Faceplate
              key={item.device.id}
              item={item}
              top={(rack.units - item.top) * UNIT_PX}
              face={face}
              ground={ground}
              selected={selected === item.device.id}
              out={linksOut.get(item.device.id)}
              onPort={(n) => onPort(item.device.id, n)}
              also={chosenIds.includes(item.device.id) && selected !== item.device.id}
              onSelect={(additive) => onSelect(item.device.id, additive)}
              onDragStart={(e) => {
                onItemDragStart(item.device);
                e.dataTransfer.setData(DRAG_TYPE, item.device.id);
              }}
              onDragEnd={onItemDragEnd}
            />
          ))}
          {view === 'side' && (
            <>
              <span className="cv-rack-side-rail is-front" aria-hidden="true">{t('rackPanel.front')}</span>
              <span className="cv-rack-side-rail is-rear" aria-hidden="true">{t('rackPanel.rear')}</span>
              {sideItems.map(({ device: d, span }) => {
                const fraction = depthFraction(d, rack);
                const rear = d.rackFace === 'rear';
                const colour = d.colour ?? (d.kind === 'furniture' ? undefined : deviceColor(d.deviceType ?? 'generic', ground));
                return (
                  <button
                    key={d.id}
                    type="button"
                    data-device={d.id}
                    data-depth={Math.round(fraction * 100)}
                    className={`cv-rack-side-item${rear ? ' is-rear' : ' is-front'}${selected === d.id ? ' is-selected' : ''}${d.furniture === 'reserved' ? ' is-reserved' : ''}`}
                    style={{ top: (rack.units - span.top) * UNIT_PX, height: (span.top - span.bottom + 1) * UNIT_PX, width: `${fraction * 100}%`, ...(colour ? { ['--rack-item-colour' as string]: colour } : {}) }}
                    title={`${d.label} — U${span.bottom}${span.top > span.bottom ? `–${span.top}` : ''} · ${d.depthMm ? `${d.depthMm} mm` : d.rackDepth === 'half' ? 'half depth' : 'full depth'} · mounted ${rear ? 'rear' : 'front'}`}
                    onClick={(e) => { e.stopPropagation(); onSelect(d.id); }}
                  >
                    <span className="cv-rack-item-label">{d.label}</span>
                    <span className="cv-rack-side-depth">{d.depthMm ? `${d.depthMm} mm` : d.rackDepth === 'half' ? '½' : ''}</span>
                  </button>
                );
              })}
            </>
          )}
          {/* A zero-U item is a strip down the post, on the face it is mounted on. */}
          {zeroHere.length > 0 && (
            <div className={`cv-rack-zerou${view === 'side' ? ' is-side' : ''}`} data-region="rack-zerou">
              {zeroHere.map((d) => (
                <button key={d.id} type="button" data-device={d.id} data-outlets={d.outlets ?? furnitureSpec(d.furniture ?? 'other').ports ?? 8} className={`cv-rack-zerou-item is-${d.furniture ?? 'device'}${selected === d.id ? ' is-selected' : ''}`}
                  style={d.colour ? { ['--rack-item-colour' as string]: d.colour } : undefined}
                  title={`${d.label} — zero-U, down the ${d.rackFace === 'rear' ? 'rear' : 'front'} post`}
                  onClick={(e) => { e.stopPropagation(); onSelect(d.id); }}>
                  <span>{d.label}</span>
                </button>
              ))}
            </div>
          )}
          {(patch.length > 0 || cords.length > 0) && (
            <CableOverlay slotsRef={slotsRef} zoom={zoom} patch={patch} cords={cords} items={items} face={face} onPick={(edgeId) => useStore.getState().select(null, edgeId)} lit={{ edgeId: selectedEdgeId, itemId: selected }} />
          )}
          {hover && view !== 'side' && (
            <div
              className={`cv-rack-ghost${hover.problem ? ' is-refused' : ''}`}
              style={{ top: (rack.units - (hover.u + hover.units - 1)) * UNIT_PX, height: hover.units * UNIT_PX }}
              title={hover.problem ?? `U${hover.u}`}
            />
          )}
        </div>
        <div className="cv-rack-post is-right" aria-hidden="true" style={{ height: rack.units * UNIT_PX }} />
        {numbers('right')}
        {cables.length > 0 && <StackCablesOverlay rack={rack} view={elev} cables={cables} />}
      </div>
      <div className="cv-rack-base" aria-hidden="true" />
      {/* What the rack carries. */}
      <footer className="cv-rack-summary" data-region="rack-summary">
        <span>{t('rackPanel.usage', { used: usage.used, free: usage.free, reserved: usage.reserved })}</span>
        {(usage.powerW > 0 || rack.powerLimitW) && (
          <span className={rack.powerLimitW && usage.powerW > rack.powerLimitW ? 'is-over' : ''}>
            {usage.powerW} W{rack.powerLimitW ? ` / ${rack.powerLimitW} W` : ''}{usage.unknownPower ? ` (${usage.unknownPower} unknown)` : ''} · {Math.round(usage.powerW * 3.412)} BTU/h
          </span>
        )}
        {(usage.weightKg > 0 || rack.weightLimitKg) && (
          <span className={rack.weightLimitKg && usage.weightKg > rack.weightLimitKg ? 'is-over' : ''}>
            {usage.weightKg} kg{rack.weightLimitKg ? ` / ${rack.weightLimitKg} kg` : ''}
          </span>
        )}
        {(air.frontToBack || air.backToFront || air.side) > 0 && (
          <span className={air.mixed ? 'is-over' : ''} title={air.mixed ? t('rackPanel.airMixedHint') : undefined}>
            {t('rackPanel.air', { f2b: air.frontToBack, b2f: air.backToFront, side: air.side })}{air.mixed ? ` — ${t('rackPanel.airMixed')}` : ''}
          </span>
        )}
        {/* Each PDU's load. */}
        {pdus.map((p) => {
          const load = pduLoad(p, members);
          const over = (p.powerW && load.watts > p.powerW) || load.used > load.outlets || load.twice.length > 0;
          return (
            <span key={p.id} className={over ? 'is-over' : ''} data-region="pdu-load" title={load.twice.length ? t('rackPanel.pduTwice', { names: load.twice.join(', ') }) : undefined}>
              {t('rackPanel.pduLoad', { name: p.label, used: load.used, outlets: load.outlets, watts: load.watts })}{p.powerW ? ` / ${p.powerW} W` : ''}{load.twice.length ? ` — ${t('rackPanel.pduTwiceShort')}` : ''}
            </span>
          );
        })}
      </footer>
      {advice.length > 0 && (
        <ul className="cv-rack-advice" data-region="rack-advice" aria-label={t('rackPanel.advice')}>
          {advice.map((a, i) => (
            <li key={`${a.kind}-${i}`} className={`is-${a.severity}`} data-kind={a.kind}>
              <button type="button" className="cv-rack-advice-line" title={t('rackPanel.adviceHint')} onClick={(e) => { e.stopPropagation(); if (a.items[0]) onSelect(a.items[0]); }}>
                {a.text}
              </button>
            </li>
          ))}
        </ul>
      )}
      {cables.length > 0 && (
        <div className="cv-rack-legend" data-region="rack-legend">
          {cables.map((c) => (
            <span key={c.stack.id}>
              <i className="cv-racks-stack-swatch" style={{ background: c.colour }} aria-hidden="true" /> {c.stack.name} · {c.preset?.name ?? c.stack.technology} · {c.stack.topology}
              {c.preset && <em className="cv-help"> · {t('rackPanel.fromGuide')}</em>}
            </span>
          ))}
        </div>
      )}
      {linksOut.size > 0 && (
        <div className="cv-rack-linksout" data-region="rack-links-out">
          {[...linksOut.values()].map((o) => (
            <span key={o.label}><strong>{o.label}</strong> {t('rackPanel.linksOut', { count: o.lines.length })}: {o.lines.join(' · ')}</span>
          ))}
        </div>
      )}
      {(elev.zeroU.length > 0 || elev.unplaced.length > 0) && (
        <footer className="cv-rack-foot">
          {elev.zeroU.length > 0 && <div>Zero-U: {elev.zeroU.map((d) => d.label).join(', ')}</div>}
          {elev.unplaced.length > 0 && <div>Not placed: {elev.unplaced.map((d) => d.label).join(', ')}</div>}
        </footer>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ a faceplate */

/** What the elevation draws for one placed box. */
function Faceplate({ item, top, face, ground, selected, also, out, onPort, onSelect, onDragStart, onDragEnd }: {
  item: RackItem;
  top: number;
  face: RackFace;
  ground: 'light' | 'dark';
  selected: boolean;
  /** Links from this box to devices in no rack. */
  out?: { label: string; lines: string[] };
  /** A click on port cell `n`; true when a link was selected by it. */
  onPort?: (n: number) => boolean;
  /** Chosen with Shift along with the selected one. */
  also?: boolean;
  onSelect: (additive: boolean) => void;
  onDragStart: React.DragEventHandler<HTMLButtonElement>;
  onDragEnd: () => void;
}) {
  const d = item.device;
  const height = (item.top - item.bottom + 1) * UNIT_PX;
  const isFurniture = d.kind === 'furniture';
  const reserved = d.furniture === 'reserved';
  const colour = d.colour ?? (isFurniture ? undefined : deviceColor(d.deviceType ?? 'generic', ground));
  const air = airOn(d.airflow, face);
  const title = [
    `${d.label} — U${item.bottom}${item.top > item.bottom ? `–${item.top}` : ''}`,
    isFurniture ? furnitureSpec(d.furniture!).label : DEVICE_LABEL[(d.deviceType ?? 'generic') as DeviceType],
    d.airflow ? `airflow ${d.airflow}` : '',
    d.stack ? `${d.stack.name} member ${d.stack.member} (${d.stack.role})` : '',
    d.note ?? '',
    item.seen === 'behind' ? 'mounted on the other face' : '',
    item.clash ? 'shares space with another device' : '',
  ].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      draggable={item.seen === 'face'}
      data-device={d.id}
      data-kind={isFurniture ? d.furniture : 'device'}
      data-class={d.deviceType ?? undefined}
      className={`cv-rack-item is-${item.seen}${item.clash ? ' is-clash' : ''}${selected ? ' is-selected' : ''}${also ? ' is-also' : ''}${isFurniture ? ` is-furniture is-${d.furniture}` : ' is-device'}${height <= UNIT_PX ? ' is-1u' : ''}${colour ? ' has-colour' : ''}`}
      style={{ top, height, ...(colour ? { ['--rack-item-colour' as string]: colour } : {}) }}
      title={title}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        e.stopPropagation();
        // A port cell under the pointer selects what is plugged into it.
        const cell = (e.target as HTMLElement).closest<HTMLElement>('.cv-fascia.is-ports i, .cv-fascia.is-jacks i, .cv-fascia.is-fibre i');
        if (cell && onPort) {
          const cells = [...(e.currentTarget as HTMLElement).querySelectorAll('.cv-fascia.is-ports i, .cv-fascia.is-jacks i, .cv-fascia.is-fibre i')];
          if (onPort(cells.indexOf(cell) + 1)) return;
        }
        onSelect(e.shiftKey || e.ctrlKey || e.metaKey);
      }}
      data-bottom={item.bottom}
      data-top={item.top}
    >
      {colour && <span className="cv-rack-item-strip" aria-hidden="true" />}
      {!isFurniture && <i className={`cv-rack-led is-${d.status ?? 'unknown'}`} aria-hidden="true" title={d.status} />}
      {!isFurniture && (
        <DeviceGlyph type={(d.deviceType ?? 'generic') as DeviceType} className="cv-rack-item-glyph" style={{ color: colour }} />
      )}
      {isFurniture && <FurnitureGlyph kind={d.furniture!} className="cv-rack-item-glyph" />}
      <span className="cv-rack-item-label">{d.label}{reserved && d.note ? ` — ${d.note}` : ''}</span>
      {d.stack && (
        <span className="cv-rack-item-stack" title={`${d.stack.name}: member ${d.stack.member}, ${d.stack.role}`}>
          {d.stack.member}
        </span>
      )}
      {out && (
        <span className="cv-rack-item-out" data-region="links-out" title={`${t('rackPanel.linksOutTitle', { count: out.lines.length })}\n${out.lines.join('\n')}`}>
          {out.lines.length} ↗
        </span>
      )}
      {/* The back of a full-depth box is what the rear shows, even when it is mounted from the front. */}
      {!reserved && (item.seen === 'face' || face === 'rear') && <Fascia item={d} face={face} tall={height > UNIT_PX} />}
      {air && <span className={`cv-rack-air is-${air.kind}`} title={air.title} aria-label={air.title}>{air.glyph}</span>}
    </button>
  );
}

/** The arrow a faceplate shows for its airflow on this face. */
function airOn(airflow: Airflow | undefined, face: RackFace): { kind: 'in' | 'out' | 'side' | 'passive'; glyph: string; title: string } | null {
  if (!airflow) return null;
  if (airflow === 'passive') return { kind: 'passive', glyph: '○', title: 'passive, no fans' };
  if (airflow === 'side-to-side') return { kind: 'side', glyph: '⇆', title: 'side-to-side airflow' };
  const intakeHere = (airflow === 'front-to-back') === (face === 'front');
  return intakeHere
    ? { kind: 'in', glyph: '⇥', title: `${airflow}: this face breathes in` }
    : { kind: 'out', glyph: '⇤', title: `${airflow}: this face blows out` };
}

/**
 * The fascia — what the front of this kind of box is covered with,
 * and what its back carries. Ports in blocks of eight with the uplinks
 * apart on a switch, a few ports and LEDs on a router or firewall, drive
 * bays on a server, a grid of drives on storage, outlets on a PDU, jacks in
 * sixes on a patch panel, cassettes on a fibre enclosure, a battery on a
 * UPS, fingers on a cable manager, ribs on a blank; power supplies on the
 * rear of anything that has them.
 */
function Fascia({ item, face, tall }: { item: Rackable; face: RackFace; tall: boolean }) {
  const kind = item.kind === 'furniture' ? item.furniture! : (item.deviceType ?? 'generic');
  const spec = item.kind === 'furniture' ? furnitureSpec(item.furniture!) : undefined;
  const cells = (n: number, cls: string, group = 0) => (
    <span className={`cv-fascia ${cls}${tall ? ' is-tall' : ''}`} aria-hidden="true" data-count={n}>
      {Array.from({ length: n }, (_, i) => <i key={i} className={group && (i + 1) % group === 0 ? 'is-gap' : undefined} />)}
    </span>
  );
  if (face === 'rear') {
    if (item.kind === 'furniture') {
      if (kind === 'pdu') return cells(Math.min(item.outlets ?? spec?.ports ?? 8, 24), 'is-outlets');
      if (kind === 'ups') return <span className="cv-fascia is-psus" aria-hidden="true"><i /><i /><i /></span>;
      if (kind === 'console-server' || kind === 'kvm') return cells(Math.min(spec?.ports ?? 8, 16), 'is-ports');
      return null;
    }
    // A network device's back: fans, and one or two power supplies.
    return (
      <span className="cv-fascia is-rear" aria-hidden="true">
        <span className="cv-fascia is-fans"><i /><i /><i /></span>
        <span className="cv-fascia is-psus"><i /><i /></span>
      </span>
    );
  }
  switch (kind) {
    case 'core-switch': case 'distribution-switch': case 'access-switch': case 'l2-switch': case 'l3-switch':
      return (
        <span className="cv-fascia is-switch" aria-hidden="true">
          {cells(Math.min(item.portCount ?? 24, 48), 'is-ports', 8)}
          {cells(4, 'is-uplinks')}
        </span>
      );
    case 'router': case 'firewall': case 'waf': case 'load-balancer': case 'vpn': case 'wireless-controller':
      return (
        <span className="cv-fascia is-router" aria-hidden="true">
          {cells(Math.min(item.portCount ?? 8, 16), 'is-ports', 4)}
          {cells(3, 'is-leds')}
        </span>
      );
    case 'server': case 'vm-host': case 'database': case 'application':
      return cells(tall ? 8 : 4, 'is-bays');
    case 'storage':
      return cells(tall ? 12 : 6, 'is-drives');
    case 'blade-chassis':
      return cells(8, 'is-blades');
    case 'patch-panel':
      return cells(Math.min(item.portCount ?? spec?.ports ?? 24, 48), 'is-jacks', 6);
    case 'fibre-panel':
      return cells(Math.min(item.portCount ?? spec?.ports ?? 12, 24), 'is-fibre', 6);
    case 'pdu': case 'pdu-vertical':
      return cells(Math.min(item.outlets ?? spec?.ports ?? 8, 24), 'is-outlets');
    case 'ups':
      return <span className="cv-fascia is-battery" aria-hidden="true"><i style={{ width: '70%' }} /></span>;
    case 'kvm': case 'console-server':
      return cells(Math.min(spec?.ports ?? 8, 16), 'is-ports', 4);
    case 'cable-manager':
      return cells(10, 'is-fingers');
    case 'blank':
      return cells(14, 'is-ribs');
    case 'shelf':
      return <span className="cv-fascia is-plate" aria-hidden="true" />;
    case 'monitor-drawer':
      return <span className="cv-fascia is-screen" aria-hidden="true"><i /></span>;
    default:
      return item.portCount ? cells(Math.min(item.portCount, 24), 'is-ports', 8) : null;
  }
}

/** What the palette and a faceplate draw for a kind of furniture: strokes of our own. */
function FurnitureGlyph({ kind, className }: { kind: FurnitureKind; className?: string }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const body = (() => {
    switch (kind) {
      case 'patch-panel': case 'fibre-panel': return <><rect x="2" y="8" width="20" height="8" rx="1" /><path d="M5 12h1M8 12h1M11 12h1M14 12h1M17 12h1" /></>;
      case 'pdu': case 'pdu-vertical': return <><rect x="2" y="9" width="20" height="6" rx="1" /><path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01" strokeWidth="2.5" /></>;
      case 'ups': return <><rect x="3" y="6" width="18" height="12" rx="1.5" /><path d="M11 9l-2 4h3l-1 3 3-5h-3z" /></>;
      case 'shelf': return <><path d="M2 14h20M4 14v3M20 14v3" /></>;
      case 'blank': return <><rect x="2" y="9" width="20" height="6" rx="1" /></>;
      case 'cable-manager': return <><path d="M3 12c3-4 6-4 9 0s6 4 9 0M3 12h18" /></>;
      case 'kvm': return <><rect x="3" y="5" width="18" height="10" rx="1" /><path d="M8 19h8M12 15v4" /></>;
      case 'console-server': return <><rect x="2" y="8" width="20" height="8" rx="1" /><path d="M6 12l2 1-2 1M10 14h4" /></>;
      case 'monitor-drawer': return <><rect x="3" y="4" width="18" height="11" rx="1" /><path d="M3 18h18" /></>;
      case 'server': return <><rect x="3" y="5" width="18" height="6" rx="1" /><rect x="3" y="13" width="18" height="6" rx="1" /><path d="M7 8h.01M7 16h.01" strokeWidth="2.5" /></>;
      case 'storage': return <><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M6 8h12M6 12h12M6 16h12" /></>;
      case 'reserved': return <><rect x="3" y="6" width="18" height="12" rx="1.5" strokeDasharray="3 2" /><path d="M8 12h8" /></>;
      default: return <><rect x="3" y="6" width="18" height="12" rx="1.5" /></>;
    }
  })();
  return <svg viewBox="0 0 24 24" className={className} aria-hidden><g {...p}>{body}</g></svg>;
}

/* --------------------------------------------------------- stack cables */

function StackCablesOverlay({ rack, view, cables }: {
  rack: Rack;
  view: ReturnType<typeof elevation>;
  cables: { stack: Stack; colour: string; index: number; preset: ReturnType<typeof stackPreset>; lines: { fromId: string; toId: string; fromPort: string; toPort: string; kind: string; elsewhere?: string }[] }[];
}) {
  // Where each placed member's ports sit: the right edge of its faceplate,
  // port 1 in the upper half of the box and port 2 in the lower.
  const yOf = (id: string, port: string) => {
    const it = view.items.find((i) => i.device.id === id);
    if (!it) return null;
    const top = (rack.units - it.top) * UNIT_PX;
    const h = (it.top - it.bottom + 1) * UNIT_PX;
    const second = /2$|link 2|VCP 1/i.test(port);
    return top + (second ? h * 0.72 : h * 0.28);
  };
  const W = 72; // the margin to the right of the rack where the cables run
  const height = rack.units * UNIT_PX;
  return (
    <svg className="cv-rack-cables" width={W} height={height + 8} viewBox={`0 0 ${W} ${height + 8}`} aria-hidden="true" data-region="rack-cables">
      {cables.map((c) =>
        c.lines.map((l, n) => {
          const y1 = yOf(l.fromId, l.fromPort);
          const y2 = yOf(l.toId, l.toPort);
          const dash = l.kind.toLowerCase().includes('keepalive') || l.kind.toLowerCase().includes('dad') || l.kind.toLowerCase().includes('dual') || l.kind.toLowerCase().includes('backup') ? '4 3' : undefined;
          const bulge = 26 + (n % 4) * 9 + c.index * 3;
          if (y1 !== null && y2 !== null) {
            return (
              <g key={`${c.stack.id}-${n}`} className="cv-rack-cable" data-stack={c.stack.id} data-kind={l.kind}>
                <path d={`M0 ${y1} C ${bulge} ${y1}, ${bulge} ${y2}, 0 ${y2}`} stroke={c.colour} strokeWidth={2} fill="none" strokeDasharray={dash} />
                <circle cx={0} cy={y1} r={2.4} fill={c.colour} />
                <circle cx={0} cy={y2} r={2.4} fill={c.colour} />
              </g>
            );
          }
          const y = y1 ?? y2;
          if (y === null) return null;
          // The other member is in another rack, or not racked: a stub and where to.
          return (
            <g key={`${c.stack.id}-${n}`} className="cv-rack-cable is-elsewhere" data-stack={c.stack.id} data-kind={l.kind}>
              <path d={`M0 ${y} L ${bulge + 8} ${y}`} stroke={c.colour} strokeWidth={2} fill="none" strokeDasharray="3 3" />
              <circle cx={0} cy={y} r={2.4} fill={c.colour} />
              <text x={bulge + 10} y={y + 3} fontSize={8} fill={c.colour}>→ {l.elsewhere}</text>
            </g>
          );
        }),
      )}
    </svg>
  );
}

/* ------------------------------------------------------------ the chosen */

function ChosenBar({ chosen, rack, pdus, stack, say, onEditStack, onRemoved, chosenIds }: {
  chosen: Rackable;
  rack: Rack | undefined;
  pdus: Rackable[];
  stack: Stack | undefined;
  say: (problem: string | null, done: string) => void;
  onEditStack: (s: Stack) => void;
  onRemoved: () => void;
  /** Everything chosen, the anchor first. */
  chosenIds: string[];
}) {
  const store = useStore.getState;
  const isFurniture = chosen.kind === 'furniture';
  const setDevice = (patch: Parameters<ReturnType<typeof useStore.getState>['setRackDetails']>[1], done: string) =>
    say(store().setRackDetails(chosen.id, patch), done);
  const setItem = (patch: Parameters<ReturnType<typeof useStore.getState>['updateFurniture']>[2], done: string) =>
    rack ? say(store().updateFurniture(rack.id, chosen.id, patch), done) : undefined;
  const setColour = (c: string | undefined) => {
    if (isFurniture) setItem({ colour: c }, c ? 'Coloured.' : 'Colour cleared.');
    else setDevice({ rackColour: c }, c ? 'Coloured.' : 'Colour cleared.');
  };
  // Which outlet feeds each supply. Two supplies, A and B; an empty
  // PDU clears the feed.
  const feeds = chosen.powerFeeds ?? [];
  const setFeed = (supply: number, pduId: string, outlet: number) => {
    const next = [...feeds];
    while (next.length <= supply) next.push({ pduId: '', outlet: 1 });
    next[supply] = { pduId, outlet: Math.max(1, Math.floor(outlet) || 1) };
    const trimmed = next.filter((f, i) => f.pduId || i < next.length - 1 && next.slice(i + 1).some((g) => g.pduId));
    const clean = trimmed.map((f) => (f.pduId ? f : { pduId: '', outlet: 1 }));
    const done = `${chosen.label}: supply ${supply === 0 ? 'A' : 'B'} ${pduId ? `on ${pdus.find((p) => p.id === pduId)?.label ?? pduId} outlet ${next[supply]!.outlet}` : 'unplugged'}.`;
    if (isFurniture) setItem({ powerFeeds: clean.length ? clean : undefined }, done);
    else setDevice({ powerFeeds: clean.length ? clean : undefined }, done);
  };
  // Several chosen — what can be done to them together.
  if (chosenIds.length > 1) {
    return (
      <div className="cv-racks-chosen is-many" data-region="rack-chosen">
        <strong>{t('rackPanel.manyChosen', { count: chosenIds.length })}</strong>
        <span className="cv-help">{t('rackPanel.manyChosenHint')}</span>
        <button type="button" className="cv-btn cv-btn-small" disabled={!rack} title={t('rackPanel.closeGapsHint')}
          onClick={() => rack && say(store().closeGapsInRack(rack.id, chosenIds), t('rackPanel.closedGaps', { count: chosenIds.length }))}>
          {t('rackPanel.closeGaps')}
        </button>
        <button type="button" className="cv-btn cv-btn-small" onClick={() => { store().takeOut(chosenIds); onRemoved(); say(null, t('rackPanel.tookOut', { count: chosenIds.length })); }}>
          {t('rackPanel.takeOutAll')}
        </button>
      </div>
    );
  }
  return (
    <div className="cv-racks-chosen" data-region="rack-chosen">
      <strong>{chosen.label}</strong>
      <span>
        {chosen.rackU !== undefined
          ? (rack?.numbering === 'top'
            ? `U${uLabel(rack, chosen.rackU + chosen.rackUnits! - 1)}${chosen.rackUnits! > 1 ? `–${uLabel(rack, chosen.rackU)}` : ''} (${t('rackPanel.fromTop')})`
            : `U${chosen.rackU}${chosen.rackUnits! > 1 ? `–${chosen.rackU + chosen.rackUnits! - 1}` : ''}`)
          : chosen.rackUnits === 0 ? 'zero-U' : 'not placed'} ·{' '}
        {chosen.rackUnits}U · mounted {chosen.rackFace === 'rear' ? 'rear' : 'front'} · {chosen.rackDepth === 'half' ? 'half' : 'full'} depth
        {isFurniture ? ` · ${furnitureSpec(chosen.furniture!).label}` : ''}
      </span>
      <button
        type="button"
        className="cv-btn cv-btn-small"
        onClick={() => {
          const next = chosen.rackFace === 'rear' ? 'front' : 'rear';
          if (isFurniture) setItem({ face: next }, `${chosen.label} is now mounted ${next}.`);
          else setDevice({ rackFace: next }, `${chosen.label} is now mounted ${next}.`);
        }}
      >
        Mount {chosen.rackFace === 'rear' ? 'front' : 'rear'}
      </button>
      <button
        type="button"
        className="cv-btn cv-btn-small"
        onClick={() => {
          const next = chosen.rackDepth === 'half' ? 'full' : 'half';
          if (isFurniture) setItem({ depth: next }, `${chosen.label} is now ${next} depth.`);
          else setDevice({ rackDepth: next }, `${chosen.label} is now ${next} depth.`);
        }}
      >
        Make {chosen.rackDepth === 'half' ? 'full' : 'half'} depth
      </button>
      {/* A colour of its own. */}
      <span className="cv-racks-swatches" role="group" aria-label={t('rackPanel.colourOf', { name: chosen.label })} data-region="rack-colour">
        {SWATCHES.map((c) => (
          <button key={c} type="button" className={`cv-swatch${chosen.colour === c ? ' is-on' : ''}`} style={{ background: c }} aria-label={`${t('rackPanel.colour')} ${c}`} aria-pressed={chosen.colour === c} onClick={() => setColour(c)} />
        ))}
        <button type="button" className={`cv-swatch is-none${!chosen.colour ? ' is-on' : ''}`} aria-label={t('rackPanel.noColour')} aria-pressed={!chosen.colour} title={t('rackPanel.noColour')} onClick={() => setColour(undefined)}>×</button>
      </span>
      {/* Which way it breathes. */}
      <label className="cv-field cv-field-inline">
        <span>{t('rackPanel.airflow')}</span>
        <select
          className="cv-input"
          aria-label={t('rackPanel.airflowOf', { name: chosen.label })}
          value={chosen.airflow ?? ''}
          onChange={(e) => {
            const v = (e.target.value || undefined) as Airflow | undefined;
            if (isFurniture) setItem({ airflow: v }, `${chosen.label}: airflow ${v ?? 'unset'}.`);
            else setDevice({ airflow: v }, `${chosen.label}: airflow ${v ?? 'unset'}.`);
          }}
        >
          <option value="">{t('rackPanel.airflowUnset')}</option>
          {AIRFLOWS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      {/* What it draws and weighs, and how deep it is. */}
      <label className="cv-field cv-field-inline">
        <span>W</span>
        <input className="cv-input cv-input-narrow" type="number" min={0} aria-label={t('rackPanel.powerOf', { name: chosen.label })} defaultValue={chosen.powerW ?? ''}
          onBlur={(e) => { const v = Number(e.target.value) || undefined; if (isFurniture) setItem({ powerW: v }, 'Power noted.'); else setDevice({ powerW: v }, 'Power noted.'); }} />
      </label>
      <label className="cv-field cv-field-inline">
        <span>kg</span>
        <input className="cv-input cv-input-narrow" type="number" min={0} step="0.1" aria-label={t('rackPanel.weightOf', { name: chosen.label })} defaultValue={chosen.weightKg ?? ''}
          onBlur={(e) => { const v = Number(e.target.value) || undefined; if (isFurniture) setItem({ weightKg: v }, 'Weight noted.'); else setDevice({ weightKg: v }, 'Weight noted.'); }} />
      </label>
      <label className="cv-field cv-field-inline">
        <span>{t('rackPanel.depth')}</span>
        <input className="cv-input cv-input-narrow" type="number" min={0} step="10" aria-label={t('rackPanel.depthOf', { name: chosen.label })} defaultValue={chosen.depthMm ?? ''}
          onBlur={(e) => { const v = Number(e.target.value) || undefined; if (isFurniture) setItem({ depthMm: v }, 'Depth noted.'); else setDevice({ depthMm: v }, 'Depth noted.'); }} />
      </label>
      {/* A PDU says how many outlets it has; anything else says which outlet feeds it. */}
      {isPdu(chosen) && isFurniture && (
        <label className="cv-field cv-field-inline">
          <span>{t('rackPanel.outlets')}</span>
          <input className="cv-input cv-input-narrow" type="number" min={1} max={64} aria-label={t('rackPanel.outletsOf', { name: chosen.label })} defaultValue={chosen.outlets ?? furnitureSpec(chosen.furniture!).ports ?? 8}
            onBlur={(e) => { const v = Number(e.target.value) || undefined; if (v !== chosen.outlets) setItem({ outlets: v }, `${chosen.label}: ${v ?? 8} outlets.`); }} />
        </label>
      )}
      {!isPdu(chosen) && pdus.length > 0 && [0, 1].map((supply) => (
        <span key={supply} className="cv-racks-feed" data-region={`feed-${supply === 0 ? 'a' : 'b'}`}>
          <label className="cv-field cv-field-inline">
            <span>{t('rackPanel.feed', { supply: supply === 0 ? 'A' : 'B' })}</span>
            <select className="cv-input" aria-label={t('rackPanel.feedOf', { supply: supply === 0 ? 'A' : 'B', name: chosen.label })} value={feeds[supply]?.pduId ?? ''}
              onChange={(e) => setFeed(supply, e.target.value, feeds[supply]?.outlet ?? 1)}>
              <option value="">{t('rackPanel.unplugged')}</option>
              {pdus.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          {feeds[supply]?.pduId && (
            <label className="cv-field cv-field-inline">
              <span>{t('rackPanel.outlet')}</span>
              <input className="cv-input cv-input-narrow" type="number" min={1} max={64} aria-label={t('rackPanel.outletOf', { supply: supply === 0 ? 'A' : 'B', name: chosen.label })} value={feeds[supply]!.outlet}
                onChange={(e) => setFeed(supply, feeds[supply]!.pduId, Number(e.target.value))} />
            </label>
          )}
        </span>
      ))}
      {isFurniture && (
        <>
          <label className="cv-field cv-field-inline">
            <span>{t('rackPanel.itemName')}</span>
            <input className="cv-input" aria-label={t('rackPanel.itemName')} defaultValue={chosen.label}
              onBlur={(e) => { if (e.target.value.trim() !== chosen.label) setItem({ label: e.target.value }, 'Renamed.'); }} />
          </label>
          <label className="cv-field cv-field-inline">
            <span>U</span>
            <input className="cv-input cv-input-narrow" type="number" min={0} max={MAX_RACK_UNITS} aria-label={t('rackPanel.itemUnits')} defaultValue={chosen.rackUnits ?? 1}
              onBlur={(e) => { const v = Number(e.target.value); if (v !== chosen.rackUnits) setItem({ units: v }, `${chosen.label} is ${v}U.`); }} />
          </label>
          <label className="cv-field cv-field-inline cv-field-wide">
            <span>{chosen.furniture === 'reserved' ? t('rackPanel.reservedFor') : t('rackPanel.note')}</span>
            <input className="cv-input" aria-label={chosen.furniture === 'reserved' ? t('rackPanel.reservedFor') : t('rackPanel.note')} defaultValue={chosen.note ?? ''}
              placeholder={chosen.furniture === 'reserved' ? t('rackPanel.reservedPlaceholder') : ''}
              onBlur={(e) => { if ((e.target.value.trim() || undefined) !== chosen.note) setItem({ note: e.target.value.trim() || undefined }, 'Noted.'); }} />
          </label>
        </>
      )}
      {chosen.stack && stack && (
        <button type="button" className="cv-btn cv-btn-small" onClick={() => onEditStack(stack)}>
          {t('rackPanel.inStack', { name: chosen.stack.name, member: chosen.stack.member, role: chosen.stack.role ?? '' })}
        </button>
      )}
      {chosen.rackU !== undefined && !isFurniture && (
        <button
          type="button"
          className="cv-btn cv-btn-small"
          onClick={() => {
            store().takeOutOfRack(chosen.id);
            say(null, `${chosen.label} is out of the rack.`);
          }}
        >
          {t('rackPanel.takeOut')}
        </button>
      )}
      {isFurniture && rack && (
        <button type="button" className="cv-btn cv-btn-small is-danger" onClick={() => { store().removeFurniture(rack.id, chosen.id); onRemoved(); say(null, `${chosen.label} removed.`); }}>
          {t('rackPanel.removeItem')}
        </button>
      )}
      <span className="cv-help">{t('rackPanel.moveAU')}</span>
    </div>
  );
}

/* ----------------------------------------------------------- the stacks */

function StackEditor({ draft, devices, onChange, onClose, say }: {
  draft: { id?: string; name: string; technology: string; topology: StackTopology; members: string[] };
  devices: Rackable[];
  onChange: (d: typeof draft) => void;
  onClose: () => void;
  say: (problem: string | null, done: string) => void;
}) {
  const store = useStore.getState;
  const preset = stackPreset(draft.technology);
  const candidates = devices.filter((d) => !draft.members.includes(d.id));
  const members = draft.members.map((id) => devices.find((d) => d.id === id)).filter((d): d is Rackable => !!d);
  const toStack = (): Omit<Stack, 'id'> => ({
    name: draft.name,
    technology: draft.technology,
    topology: draft.topology,
    members: draft.members.map((nodeId, i) => ({ nodeId, number: i + 1 })),
  });
  return (
    <div className="cv-racks-stackeditor" data-region="stack-editor">
      <div className="cv-racks-stackeditor-row">
        <label className="cv-field">
          <span>{t('rackPanel.stackName')}</span>
          <input className="cv-input" aria-label={t('rackPanel.stackName')} value={draft.name} placeholder="CORE-STACK" onChange={(e) => onChange({ ...draft, name: e.target.value })} />
        </label>
        <label className="cv-field">
          <span>{t('rackPanel.technology')}</span>
          <select className="cv-input" aria-label={t('rackPanel.technology')} value={draft.technology}
            onChange={(e) => {
              const p = stackPreset(e.target.value);
              onChange({ ...draft, technology: e.target.value, topology: p?.topologies[0] ?? draft.topology });
            }}>
            {STACK_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.vendor} — {p.name}</option>)}
            <option value="custom">{t('rackPanel.customStack')}</option>
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>{t('rackPanel.topology')}</span>
          <select className="cv-input" aria-label={t('rackPanel.topology')} value={draft.topology} onChange={(e) => onChange({ ...draft, topology: e.target.value as StackTopology })}>
            {(preset?.topologies ?? ['ring', 'chain', 'pair']).map((tp) => <option key={tp} value={tp}>{tp}</option>)}
          </select>
        </label>
        <label className="cv-field">
          <span>{t('rackPanel.addMember')}</span>
          <select className="cv-input" aria-label={t('rackPanel.addMember')} value=""
            onChange={(e) => { if (e.target.value) onChange({ ...draft, members: [...draft.members, e.target.value] }); }}>
            <option value="">{t('rackPanel.addMember')}</option>
            {candidates.map((d) => <option key={d.id} value={d.id}>{d.label}{d.rack ? ` · ${d.rack}` : ''}</option>)}
          </select>
        </label>
      </div>
      <ol className="cv-racks-stackmembers" aria-label={t('rackPanel.members')}>
        {members.map((m, i) => (
          <li key={m.id}>
            <span className="cv-rack-item-stack">{i + 1}</span> {m.label} <span className="cv-help">{roleOf(i, preset)}</span>
            <button type="button" className="cv-layer-remove" aria-label={`Move ${m.label} up`} disabled={i === 0}
              onClick={() => { const a = [...draft.members]; [a[i - 1], a[i]] = [a[i]!, a[i - 1]!]; onChange({ ...draft, members: a }); }}>↑</button>
            <button type="button" className="cv-layer-remove" aria-label={`Remove ${m.label} from the stack`}
              onClick={() => onChange({ ...draft, members: draft.members.filter((x) => x !== m.id) })}>×</button>
          </li>
        ))}
        {members.length === 0 && <li className="cv-help">{t('rackPanel.members')}: —</li>}
      </ol>
      {preset && (
        <p className="cv-help cv-racks-stacknote">
          {preset.note} <em>{t('rackPanel.fromGuideLong', { source: preset.source })}</em>
        </p>
      )}
      <div className="cv-row cv-row-tight">
        <button type="button" className="cv-btn cv-btn-small cv-btn-start"
          onClick={() => {
            const problem = draft.id ? store().updateStack(draft.id, toStack()) : store().addStack(toStack());
            say(problem, `${draft.name.trim()} ${draft.id ? 'changed' : 'added'}: ${t('plural.member', { count: draft.members.length })}.`);
            if (!problem) onClose();
          }}>
          {draft.id ? t('rackPanel.saveStack') : t('rackPanel.addStack')}
        </button>
        {draft.id && (
          <button type="button" className="cv-btn cv-btn-small is-danger" onClick={() => { store().removeStack(draft.id!); say(null, `${draft.name} removed.`); onClose(); }}>
            {t('rackPanel.removeStack')}
          </button>
        )}
        <button type="button" className="cv-btn cv-btn-small" onClick={onClose}>{t('rackPanel.cancel')}</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- cables and cords */

/** A PDU: furniture of either PDU kind, or a device drawn as one. */
function isPdu(d: Rackable): boolean {
  return d.furniture === 'pdu' || d.furniture === 'pdu-vertical' || d.deviceType === 'pdu';
}

type Pt = { x: number; y: number };

/**
 * Where a port, jack, outlet or power supply sits on a faceplate, measured
 * from what was drawn rather than computed twice: the fascia's cells are the
 * truth, and a port beyond them lands at the faceplate's right edge.
 */
/** A port's point, and the top and bottom of the box it is on — the gaps a
 *  cable runs along to get out of the rack. */
interface PortPt extends Pt {
  top: number;
  bottom: number;
}

function portPoint(slots: HTMLElement, zoom: number, itemId: string, kind: 'port' | 'psu' | 'outlet', n: number | null): PortPt | null {
  const item = slots.querySelector<HTMLElement>(`.cv-rack-item[data-device="${CSS.escape(itemId)}"]`);
  const strip = slots.querySelector<HTMLElement>(`.cv-rack-zerou-item[data-device="${CSS.escape(itemId)}"]`);
  const box = slots.getBoundingClientRect();
  const edges = (r: DOMRect) => ({ top: (r.top - box.top) / zoom, bottom: (r.bottom - box.top) / zoom });
  const rel = (r: DOMRect, host: DOMRect): PortPt => ({ x: (r.left + r.width / 2 - box.left) / zoom, y: (r.top + r.height / 2 - box.top) / zoom, ...edges(host) });
  if (strip) {
    // A vertical PDU: outlets run down the strip.
    const r = strip.getBoundingClientRect();
    const outlets = Number(strip.getAttribute('data-outlets') ?? 8);
    const at = n ? Math.min(1, Math.max(0, (n - 0.5) / outlets)) : 0.5;
    const y = (r.top + r.height * at - box.top) / zoom;
    return { x: (r.left + r.width / 2 - box.left) / zoom, y, top: y - 2, bottom: y + 2 };
  }
  if (!item) return null;
  const host = item.getBoundingClientRect();
  const sel = kind === 'port' ? '.cv-fascia.is-ports i, .cv-fascia.is-jacks i, .cv-fascia.is-fibre i' : kind === 'psu' ? '.cv-fascia.is-psus i' : '.cv-fascia.is-outlets i';
  const cells = item.querySelectorAll<HTMLElement>(sel);
  if (n && cells.length >= n) return rel(cells[n - 1]!.getBoundingClientRect(), host);
  if (cells.length && n === null && kind !== 'port') return rel(cells[0]!.getBoundingClientRect(), host);
  // No cell for it: the faceplate's right edge, mid-height.
  return { x: (host.right - 6 - box.left) / zoom, y: (host.top + host.height / 2 - box.top) / zoom, ...edges(host) };
}

/**
 * A cable out of the rack and back. From the port straight to the
 * gap under its own box (over, when the other end is above), along the gap
 * out past the post and the numbers to a bundle beside the rack — a lane
 * per cable, 2.5 px apart — down (or up) the bundle, back in along the gap
 * by the target's box, and into its port. Right angles, rounded a little,
 * and never across a box. `outer` is where the rack's frame ends on each
 * side, measured from the slots; the bundle sits 6 px beyond it.
 */
function bundlePath(a: PortPt, b: PortPt, lane: number, side: 'left' | 'right', outer: { left: number; right: number }): string {
  const down = b.y > a.y;
  const r = 2.5;
  // Along the gap just outside each box: below when heading down, above when heading up.
  const ay = down ? a.bottom + 1 : a.top - 1;
  const by = down ? b.top - 1 : b.bottom + 1;
  const x = side === 'left' ? outer.left - 6 - lane * 2.5 : outer.right + 6 + lane * 2.5;
  if (Math.abs(a.y - b.y) < 4) return `M${a.x} ${a.y} L${b.x} ${b.y}`;
  // Both gaps are the same gap (boxes touching): one run along it is enough.
  if (Math.abs(ay - by) < 2) return `M${a.x} ${a.y} L${a.x} ${ay} L${b.x} ${by} L${b.x} ${b.y}`;
  const s = side === 'left' ? 1 : -1; // the bundle lies this way from the ends
  const d1 = down ? 1 : -1;
  return [
    `M${a.x} ${a.y}`,
    `L${a.x} ${ay - d1 * r}`, `Q${a.x} ${ay} ${a.x - s * r} ${ay}`,
    `L${x + s * r} ${ay}`, `Q${x} ${ay} ${x} ${ay + d1 * r}`,
    `L${x} ${by - d1 * r}`, `Q${x} ${by} ${x + s * r} ${by}`,
    `L${b.x - s * r} ${by}`, `Q${b.x} ${by} ${b.x} ${by + d1 * r}`,
    `L${b.x} ${b.y}`,
  ].join(' ');
}

/** A cable from one point to another down a channel at the rack's side —
 *  the left one, or the right when both ends sit in the right half (a cord
 *  to a PDU down the right post) — with a lane per cable so they do not lie
 *  on one another. */
function channelPath(a: Pt, b: Pt, lane: number, width: number): string {
  const right = a.x > width / 2 && b.x > width / 2;
  const x = right ? width - 3 - lane * 2.2 : 3 + lane * 2.2;
  const dy = 4;
  const r = 3;
  const down = b.y > a.y;
  const ay = a.y + (down ? dy : -dy);
  const by = b.y + (down ? -dy : dy);
  if (Math.abs(a.y - b.y) < 2 * dy + 2) return `M${a.x} ${a.y} L${a.x} ${a.y + dy} L${b.x} ${b.y + dy} L${b.x} ${b.y}`;
  const s = right ? -1 : 1; // which way the channel lies from the ends
  return `M${a.x} ${a.y} L${a.x} ${ay} Q${a.x} ${ay + (down ? r : -r)} ${a.x - s * r} ${ay + (down ? r : -r)} L${x + s * r} ${ay + (down ? r : -r)} Q${x} ${ay + (down ? r : -r)} ${x} ${ay + (down ? 2 * r : -2 * r)} L${x} ${by - (down ? 2 * r : -2 * r)} Q${x} ${by - (down ? r : -r)} ${x + s * r} ${by - (down ? r : -r)} L${b.x - s * r} ${by - (down ? r : -r)} Q${b.x} ${by - (down ? r : -r)} ${b.x} ${by} L${b.x} ${b.y}`;
}

/** The cables drawn over the slots, measured after the faceplates have laid out. */
function CableOverlay({ slotsRef, zoom, patch, cords, items, face, onPick, lit }: {
  slotsRef: React.RefObject<HTMLDivElement>;
  zoom: number;
  patch: PatchCable[];
  cords: PowerCord[];
  items: Rackable[];
  face: RackFace;
  onPick: (edgeId: string) => void;
  /** The selected link and the chosen box, whose cables light up. */
  lit: { edgeId: string | null; itemId: string | null };
}) {
  const [lines, setLines] = useState<{ key: string; d: string; colour: string; dashed: boolean; title: string; edgeId?: string; ends?: string[]; stub?: { x: number; y: number; text: string }; problem?: boolean }[]>([]);
  const byId = useMemo(() => new Map(items.map((d) => [d.id, d])), [items]);
  useLayoutEffect(() => {
    const slots = slotsRef.current;
    if (!slots) return;
    const width = slots.clientWidth;
    // Where the rack's frame ends, so the bundle sits outside it.
    const frame = slots.closest<HTMLElement>('.cv-rack-frame')?.getBoundingClientRect();
    const box = slots.getBoundingClientRect();
    const outer = frame ? { left: (frame.left - box.left) / zoom, right: (frame.right - box.left) / zoom } : { left: -8, right: width + 8 };
    const lanes = { left: 0, right: 0 };
    const out: typeof lines = [];
    patch.forEach((c) => {
      const a = portPoint(slots, zoom, c.from.itemId, 'port', c.from.port);
      if (!a) return;
      const colour = cableColour(c);
      const dashed = c.status === 'down' || c.status === 'warning';
      if ('elsewhere' in c.to) {
        // A device in no rack is nowhere on an elevation — the
        // faceplate's count and the list under the rack carry those.
        if (isUnracked(c.to)) return;
        // Out through the right post into the gap beside the rack, where the
        // text can sit; the stubs are spread apart below, so none overprints.
        out.push({ key: c.edgeId, d: `M${a.x} ${a.y} L${a.x} ${a.y + 4} L${width + 14} ${a.y + 4}`, colour, dashed, edgeId: c.edgeId, ends: [c.from.itemId],
          title: `${c.from.label} ${c.from.portLabel} → ${c.to.label} ${c.to.portLabel} (${c.to.elsewhere})${c.cableLength ? ` · ${c.cableLength}` : ''}`,
          stub: { x: width + 16, y: a.y + 7, text: `→ ${c.to.rack ?? c.to.elsewhere}` } });
        return;
      }
      const b = portPoint(slots, zoom, c.to.itemId, 'port', c.to.port);
      if (!b) return;
      // The bundle on the side nearer both ports; a lane per cable on that side.
      const side = a.x > width / 2 && b.x > width / 2 ? 'right' : 'left';
      const lane = lanes[side]++;
      out.push({ key: c.edgeId, d: bundlePath(a, b, lane % 8, side, outer), colour, dashed, edgeId: c.edgeId, ends: [c.from.itemId, c.to.itemId],
        title: `${c.from.label} ${c.from.portLabel} ↔ ${c.to.label} ${c.to.portLabel}${c.cableType ? ` · ${c.cableType}` : ''}${c.cableLength ? ` · ${c.cableLength}` : ''}${c.status ? ` · ${c.status}` : ''}` });
    });
    cords.forEach((c, i) => {
      const a = portPoint(slots, zoom, c.itemId, 'psu', c.supply + 1);
      const pdu = byId.get(c.pduId);
      const b = pdu && !c.problem ? portPoint(slots, zoom, c.pduId, 'outlet', c.outlet) : null;
      if (!a) return;
      const title = `${c.label} supply ${c.supply === 0 ? 'A' : 'B'} → ${c.pduLabel} outlet ${c.outlet}${c.problem ? ` — ${c.problem}` : ''}`;
      if (!b) {
        out.push({ key: `${c.itemId}-${c.supply}`, d: `M${a.x} ${a.y} L${a.x} ${a.y + 4} L${width + 14} ${a.y + 4}`, colour: '#e4564a', dashed: true, title, problem: true, stub: { x: width + 16, y: a.y + 7, text: c.problem ?? '' } });
        return;
      }
      out.push({ key: `${c.itemId}-${c.supply}`, d: channelPath(a, b, 8 + (i % 6), width), colour: c.supply === 0 ? '#e4564a' : '#5ea1ff', dashed: false, title });
    });
    setLines(out);
  }, [slotsRef, zoom, patch, cords, byId, face]);
  if (lines.length === 0) return null;
  // Stubs that would print over each other, spread apart; the line
  // follows its text so each still points at its own port.
  const stubbed = lines.filter((l) => l.stub && !l.problem);
  const ys = spreadStubs(stubbed.map((l) => l.stub!.y), 9);
  stubbed.forEach((l, i) => {
    const y = ys[i]!;
    if (y === l.stub!.y) return;
    const [, ax, ay] = /^M([\d.]+) ([\d.]+)/.exec(l.d) ?? [];
    l.stub = { ...l.stub!, y };
    if (ax && ay) l.d = `M${ax} ${ay} L${ax} ${y - 3} L${l.stub.x - 2} ${y - 3}`;
  });
  // The cables of the selected link or the chosen box are lit; while
  // any is, the rest fade back.
  const isLit = (l: (typeof lines)[number]) => Boolean((lit.edgeId && l.edgeId === lit.edgeId) || (lit.itemId && l.ends?.includes(lit.itemId)));
  const anyLit = lines.some(isLit);
  return (
    <svg className={`cv-rack-patch${anyLit ? ' has-lit' : ''}`} data-region={face === 'front' ? 'rack-patch' : 'rack-power'} aria-hidden="true">
      {lines.map((l) => (
        <g key={l.key} className={`cv-rack-patch-cable${l.stub ? ' is-elsewhere' : ''}${l.problem ? ' is-problem' : ''}${isLit(l) ? ' is-lit' : anyLit ? ' is-dim' : ''}`} data-edge={l.edgeId} onClick={l.edgeId ? (e) => { e.stopPropagation(); onPick(l.edgeId!); } : undefined} style={{ color: l.colour, ...(l.edgeId ? { pointerEvents: 'auto', cursor: 'pointer' } : {}) }}>
          <title>{l.title}</title>
          <path d={l.d} stroke={l.colour} strokeWidth={1.6} fill="none" strokeDasharray={l.dashed ? '3 2' : undefined} strokeLinecap="round" strokeLinejoin="round" />
          {l.stub && <text x={l.stub.x} y={l.stub.y} fontSize={7} fill={l.colour}>{l.stub.text}</text>}
        </g>
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------- helpers */

/** The SVG export rasterised, for a PNG beside it. */
async function svgToPng(svg: string): Promise<Blob | null> {
  try {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('could not load'));
      img.src = url;
    });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null;
  }
}
