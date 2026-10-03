/**
 * Rack elevations (LT-195–197, and LT-681–LT-689): the project's racks drawn
 * U by U on a canvas of their own, from the front or the rear, with the
 * devices on the diagram placed in them and the furniture a rack holds that
 * is not on the diagram — patch panels, PDUs, UPSs, shelves, blanks, and
 * reservations (D-065) — beside them.
 *
 * A device or a piece of furniture is dragged into a rack, or moved within or
 * between racks, and always lands on a whole U — there is no free placement
 * to turn off (the D-013 amendment). A move into space something else holds
 * is refused with what is in the way. The selected box moves a U at a time
 * with the arrow keys. Each box is drawn as what it is: the class glyph and
 * colour, a port row, an airflow arrow, its stack member number; a stack's
 * cables run down the side of the rack the way the vendor's guide draws them
 * (LT-683). Racks stand where they are — building, floor, room, row — and
 * the page groups them so (LT-685). Zoom with Ctrl+wheel or the buttons.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { saveExport, slug } from '../lib/exports';
import { allNodes } from '../lib/pages';
import {
  AIRFLOWS,
  DEFAULT_RACK_UNITS,
  MAX_RACK_UNITS,
  airflowOf,
  elevation,
  firstFreeU,
  furnitureRackables,
  groupRacks,
  placeOf,
  placementProblem,
  rackableOf,
  takesSpace,
  uAt,
  usageOf,
  type Airflow,
  type Rack,
  type RackFace,
  type RackItem,
  type Rackable,
} from '../lib/rack';
import { FURNITURE, furnitureSpec, type FurnitureKind } from '../lib/rackFurniture';
import { rackElevationSvg } from '../lib/rackSvg';
import { STACK_PRESETS, roleOf, stackCables, stackPreset, type Stack, type StackTopology } from '../lib/stacking';
import { useStore } from '../state/store';
import { GROUP_WHEEL_DARK, deviceColor } from '../theme';
import type { DeviceNodeData, DeviceType } from '../types/domain';
import { t } from '../i18n';
import { DeviceGlyph, DEVICE_LABEL } from './icons';

export const UNIT_PX = 14;
const DRAG_TYPE = 'application/x-coreview-device';
const DRAG_FURNITURE = 'application/x-coreview-furniture';
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];

/** Which device or item is being dragged. `dataTransfer` cannot be read
 *  during dragover, only on drop, so the preview needs its own note of it. */
let dragging: { id: string; units: number; label: string; kind: 'device' | 'furniture' | 'new'; furniture?: FurnitureKind; rackId?: string } | null = null;

const sameRack = (a: string | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/** The colour a stack's cables are drawn in: one per stack, from the wheel. */
const stackColour = (index: number) => GROUP_WHEEL_DARK[index % GROUP_WHEEL_DARK.length]!;

export function RackPanel() {
  // LT-452: the racks and the pages, not the whole document.
  const pages = useStore((s) => s.doc.pages);
  const docRacks = useStore((s) => s.doc.racks);
  const docStacks = useStore((s) => s.doc.stacks);
  const meta = useStore((s) => s.meta);
  const exportFolder = useStore((s) => s.settings.exportFolder);
  const ground = useStore((s) => s.settings.ground);
  const nodeStatus = useStore((s) => s.nodeStatus);
  const store = useStore.getState;
  const [face, setFace] = useState<RackFace>('front');
  const [selected, setSelected] = useState<string | null>(null);
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
  const chosenRack = chosen ? racks.find((r) => sameRack(chosen.rack, r.name)) : undefined;
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

  const exportSvg = async () => {
    const svg = rackElevationSvg(racks, devices, face, { stacks });
    const path = await saveExport(`${slug(meta?.name ?? 'project')}-racks-${face}.svg`, svg, 'image/svg+xml', exportFolder);
    if (path) setMessage(`Saved the ${face} elevations to ${path}.`);
  };

  const exportPng = async () => {
    const svg = rackElevationSvg(racks, devices, face, { stacks });
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
    // device built into a rack; a zero-U item has no U.
    if (u === undefined && spec.units > 0) {
      const probe: Rackable = { id: '\u0000new', label, rack: rack.name, rackUnits: spec.units, rackFace: spec.face, rackDepth: spec.depth, kind: 'furniture', furniture: kind };
      const free = firstFreeU(rack, allFor(rack), probe);
      if (free === null) {
        setMessage(`No room in ${rack.name} for ${label}.`);
        return;
      }
      u = free;
    }
    const problem = store().addFurniture(rack.id, kind, label, undefined, u);
    say(problem, `${label} added to ${rack.name}${u !== undefined ? ` at U${u}` : ''}.`);
    if (!problem) {
      const added = (store().doc.racks ?? []).find((r) => r.id === rack.id)?.items?.at(-1);
      if (added) setSelected(added.id);
    }
  };

  const stackOf = (id: string) => stacks.find((s) => s.id === id);

  return (
    <div
      className="cv-racks"
      onKeyDown={(e) => {
        if (!chosen || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        const rack = chosenRack;
        if (!rack || chosen.rackU === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        const u = chosen.rackU + (e.key === 'ArrowUp' ? 1 : -1);
        const problem = chosen.kind === 'furniture' ? store().placeFurniture(rack.id, chosen.id, u) : store().placeInRack(chosen.id, rack.id, u);
        say(problem, `${chosen.label} moved to U${u}.`);
      }}
    >
      <div className="cv-racks-bar">
        <div className="cv-seg" role="group" aria-label={t('rackPanel.rackFace')}>
          {(['front', 'rear'] as const).map((f) => (
            <button key={f} type="button" className={face === f ? 'is-on' : ''} aria-pressed={face === f} onClick={() => setFace(f)}>
              {f === 'front' ? 'Front' : 'Rear'}
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
          Export {face} as SVG
        </button>
        <button type="button" className="cv-btn cv-btn-small" disabled={racks.length === 0} onClick={() => void exportPng()}>
          {t('rackPanel.exportPng', { face })}
        </button>
        {/* LT-688: the zoom. */}
        <div className="cv-racks-zoomctl" role="group" aria-label={t('rackPanel.zoom')}>
          <button type="button" className="cv-btn cv-btn-small" aria-label={t('rackPanel.zoomOut')} onClick={() => zoomStep(-1)}>−</button>
          <button type="button" className="cv-btn cv-btn-small cv-racks-zoomvalue" title={t('rackPanel.zoomReset')} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" className="cv-btn cv-btn-small" aria-label={t('rackPanel.zoomIn')} onClick={() => zoomStep(1)}>+</button>
          <button type="button" className="cv-btn cv-btn-small" onClick={fit}>{t('rackPanel.fit')}</button>
        </div>
        {racks.length > 1 && (
          <input className="cv-input cv-racks-place-filter" aria-label={t('rackPanel.placeFilter')} placeholder={t('rackPanel.placeFilter')} value={placeFilter} onChange={(e) => setPlaceFilter(e.target.value)} />
        )}
        {message && (
          <span className="cv-racks-message" role="status">
            {message}
          </span>
        )}
      </div>

      {chosen && (
        <ChosenBar
          chosen={chosen}
          rack={chosenRack}
          stack={chosen.stack ? stackOf(chosen.stack.id) : undefined}
          say={say}
          onEditStack={(s) => setStackEditor({ id: s.id, name: s.name, technology: s.technology, topology: s.topology, members: s.members.map((m) => m.nodeId) })}
          onRemoved={() => setSelected(null)}
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
                  <DeviceGlyph type={(d.deviceType ?? 'generic') as DeviceType} className="cv-racks-device-glyph" style={{ color: deviceColor(d.deviceType ?? 'generic', 'unknown', ground) }} />
                  {d.label}
                </span>
                <span className="cv-racks-units">
                  {d.rackUnits}U{d.rack ? ` · ${d.rack}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {waiting.length > 200 && <p className="cv-help">{waiting.length - 200} more — filter to find them.</p>}

          {/* LT-682, LT-686: what a rack holds that is not on the diagram. */}
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

          {/* LT-683: the stacks. */}
          <h4 className="cv-racks-side-head">{t('rackPanel.stacks')}</h4>
          <ul className="cv-racks-stacks" data-region="rack-stacks">
            {stacks.map((s, i) => {
              const preset = stackPreset(s.technology);
              return (
                <li key={s.id} className="cv-racks-stack">
                  <i className="cv-racks-stack-swatch" style={{ background: stackColour(i) }} aria-hidden="true" />
                  <button type="button" className="cv-link-button" onClick={() => setStackEditor({ id: s.id, name: s.name, technology: s.technology, topology: s.topology, members: s.members.map((m) => m.nodeId) })}>
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
          {stackEditor && (
            <StackEditor
              draft={stackEditor}
              devices={devices}
              onChange={setStackEditor}
              onClose={() => setStackEditor(null)}
              say={say}
            />
          )}
        </aside>

        <div className="cv-racks-stage" ref={stageRef} data-region="rack-stage" onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
          {racks.length === 0 && (
            <p className="cv-help cv-racks-empty">
              No racks yet. Add one, or give devices a rack name in the inspector (Rack / room) and build racks from them.
            </p>
          )}
          <div className="cv-racks-zoom" style={{ transform: `scale(${zoom})` }}>
            {groups.map((g) => (
              <section key={g.heading || '\u0000here'} className="cv-racks-place" aria-label={g.heading || t('rackPanel.noPlace')}>
                {g.heading && <h3 className="cv-racks-place-head">{g.heading}</h3>}
                <div className="cv-racks-row">
                  {g.racks.map((rack) => (
                    <RackView
                      key={rack.id}
                      rack={rack}
                      face={face}
                      items={allFor(rack)}
                      stacks={stacks}
                      ground={ground}
                      selected={selected}
                      hover={hover?.rackId === rack.id ? hover : null}
                      isTarget={target?.id === rack.id}
                      onSelect={(id) => { setSelected(id); setTargetRack(rack.id); }}
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
                            const problem = store().addFurniture(rack.id, f.kind, f.label, f.units, u);
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
  rack, face, items, stacks, ground, selected, hover, isTarget, onSelect, say, onDragOver, onDragLeave, onDrop, onItemDragStart, onItemDragEnd,
}: {
  rack: Rack;
  face: RackFace;
  items: Rackable[];
  stacks: Stack[];
  ground: 'light' | 'dark';
  selected: string | null;
  hover: { u: number; units: number; problem: string | null } | null;
  isTarget: boolean;
  onSelect: (id: string | null) => void;
  say: (problem: string | null, done: string) => void;
  onDragOver: React.DragEventHandler<HTMLDivElement>;
  onDragLeave: () => void;
  onDrop: React.DragEventHandler<HTMLDivElement>;
  onItemDragStart: (item: Rackable) => void;
  onItemDragEnd: () => void;
}) {
  const store = useStore.getState;
  const view = elevation(rack, items, face);
  const members = items.filter((d) => sameRack(d.rack, rack.name));
  const usage = usageOf(rack, members);
  const air = airflowOf(members.filter((d) => d.rackU !== undefined && takesSpace(d)));
  const [where, setWhere] = useState(false);
  const place = placeOf(rack);

  // LT-683: the cables of every stack with a member placed in this rack, on
  // the face its ports are on.
  const cables = useMemo(() => {
    const out: { stack: Stack; colour: string; index: number; preset: ReturnType<typeof stackPreset>; lines: { fromId: string; toId: string; fromPort: string; toPort: string; kind: string; elsewhere?: string }[] }[] = [];
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
  }, [stacks, items, rack.name, face]);

  return (
    <section className={`cv-rack${isTarget ? ' is-target' : ''}`} aria-label={`Rack ${rack.name}`} data-rack-id={rack.id} onClick={() => onSelect(selected)}>
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
        <button type="button" className="cv-layer-remove" aria-label={`Remove rack ${rack.name}`} title={t('rackPanel.removeThisRackDevices')} onClick={() => store().removeRack(rack.id)}>
          ×
        </button>
      </header>
      {place && !where && <div className="cv-rack-place" data-region="rack-place">{place}</div>}
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
        <ol className="cv-rack-numbers is-left" aria-hidden="true">
          {Array.from({ length: rack.units }, (_, i) => (
            <li key={i} style={{ height: UNIT_PX }} className={(rack.units - i) % 5 === 0 ? 'is-fifth' : ''}>
              {rack.units - i}
            </li>
          ))}
        </ol>
        <div className="cv-rack-post is-left" aria-hidden="true" style={{ height: rack.units * UNIT_PX }} />
        <div
          className="cv-rack-slots"
          data-rack={rack.name}
          style={{ height: rack.units * UNIT_PX }}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
        >
          {view.items.map((item) => (
            <Faceplate
              key={item.device.id}
              item={item}
              top={(rack.units - item.top) * UNIT_PX}
              face={face}
              ground={ground}
              selected={selected === item.device.id}
              onSelect={() => onSelect(item.device.id)}
              onDragStart={(e) => {
                onItemDragStart(item.device);
                e.dataTransfer.setData(DRAG_TYPE, item.device.id);
              }}
              onDragEnd={onItemDragEnd}
            />
          ))}
          {hover && (
            <div
              className={`cv-rack-ghost${hover.problem ? ' is-refused' : ''}`}
              style={{ top: (rack.units - (hover.u + hover.units - 1)) * UNIT_PX, height: hover.units * UNIT_PX }}
              title={hover.problem ?? `U${hover.u}`}
            />
          )}
        </div>
        <div className="cv-rack-post is-right" aria-hidden="true" style={{ height: rack.units * UNIT_PX }} />
        <ol className="cv-rack-numbers is-right" aria-hidden="true">
          {Array.from({ length: rack.units }, (_, i) => (
            <li key={i} style={{ height: UNIT_PX }} className={(rack.units - i) % 5 === 0 ? 'is-fifth' : ''}>
              {rack.units - i}
            </li>
          ))}
        </ol>
        {cables.length > 0 && <StackCablesOverlay rack={rack} view={view} cables={cables} />}
      </div>
      <div className="cv-rack-base" aria-hidden="true" />
      {/* LT-689: what the rack carries. */}
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
      </footer>
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
      {(view.zeroU.length > 0 || view.unplaced.length > 0) && (
        <footer className="cv-rack-foot">
          {view.zeroU.length > 0 && <div>Zero-U: {view.zeroU.map((d) => d.label).join(', ')}</div>}
          {view.unplaced.length > 0 && <div>Not placed: {view.unplaced.map((d) => d.label).join(', ')}</div>}
        </footer>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ a faceplate */

/** What the elevation draws for one placed box (LT-687). */
function Faceplate({ item, top, face, ground, selected, onSelect, onDragStart, onDragEnd }: {
  item: RackItem;
  top: number;
  face: RackFace;
  ground: 'light' | 'dark';
  selected: boolean;
  onSelect: () => void;
  onDragStart: React.DragEventHandler<HTMLButtonElement>;
  onDragEnd: () => void;
}) {
  const d = item.device;
  const height = (item.top - item.bottom + 1) * UNIT_PX;
  const isFurniture = d.kind === 'furniture';
  const reserved = d.furniture === 'reserved';
  const colour = isFurniture ? undefined : deviceColor(d.deviceType ?? 'generic', d.status ?? 'unknown', ground);
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
      className={`cv-rack-item is-${item.seen}${item.clash ? ' is-clash' : ''}${selected ? ' is-selected' : ''}${isFurniture ? ` is-furniture is-${d.furniture}` : ' is-device'}${height <= UNIT_PX ? ' is-1u' : ''}`}
      style={{ top, height, ...(colour ? { ['--rack-item-colour' as string]: colour } : {}) }}
      title={title}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      data-bottom={item.bottom}
      data-top={item.top}
    >
      {!isFurniture && <span className="cv-rack-item-strip" aria-hidden="true" />}
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
      {!reserved && <Ports item={d} face={face} />}
      {air && <span className={`cv-rack-air is-${air.kind}`} title={air.title} aria-label={air.title}>{air.glyph}</span>}
    </button>
  );
}

/** The arrow a faceplate shows for its airflow on this face (LT-684). */
function airOn(airflow: Airflow | undefined, face: RackFace): { kind: 'in' | 'out' | 'side' | 'passive'; glyph: string; title: string } | null {
  if (!airflow) return null;
  if (airflow === 'passive') return { kind: 'passive', glyph: '○', title: 'passive, no fans' };
  if (airflow === 'side-to-side') return { kind: 'side', glyph: '⇆', title: 'side-to-side airflow' };
  const intakeHere = (airflow === 'front-to-back') === (face === 'front');
  return intakeHere
    ? { kind: 'in', glyph: '⇥', title: `${airflow}: this face breathes in` }
    : { kind: 'out', glyph: '⇤', title: `${airflow}: this face blows out` };
}

/** A row of ports, jacks or outlets, for what has them (LT-687). */
function Ports({ item, face }: { item: Rackable; face: RackFace }) {
  const spec = item.kind === 'furniture' ? furnitureSpec(item.furniture!) : undefined;
  const count = item.kind === 'furniture' ? (spec?.ports ?? 0) : (item.portCount ?? 0);
  // PSUs are on the rear of a network device; its ports on the front.
  if (item.kind !== 'furniture' && face === 'rear') {
    return (
      <span className="cv-rack-psus" aria-hidden="true">
        <i /><i />
      </span>
    );
  }
  if (!count) return null;
  const shown = Math.min(count, 48);
  return (
    <span className={`cv-rack-ports${count > 24 ? ' is-dense' : ''}`} aria-hidden="true" data-ports={count}>
      {Array.from({ length: shown }, (_, i) => <i key={i} />)}
    </span>
  );
}

/** What the palette and a faceplate draw for a kind of furniture: strokes of our own (D-019). */
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

function ChosenBar({ chosen, rack, stack, say, onEditStack, onRemoved }: {
  chosen: Rackable;
  rack: Rack | undefined;
  stack: Stack | undefined;
  say: (problem: string | null, done: string) => void;
  onEditStack: (s: Stack) => void;
  onRemoved: () => void;
}) {
  const store = useStore.getState;
  const isFurniture = chosen.kind === 'furniture';
  const setDevice = (patch: Parameters<ReturnType<typeof useStore.getState>['setRackDetails']>[1], done: string) =>
    say(store().setRackDetails(chosen.id, patch), done);
  const setItem = (patch: Parameters<ReturnType<typeof useStore.getState>['updateFurniture']>[2], done: string) =>
    rack ? say(store().updateFurniture(rack.id, chosen.id, patch), done) : undefined;
  return (
    <div className="cv-racks-chosen" data-region="rack-chosen">
      <strong>{chosen.label}</strong>
      <span>
        {chosen.rackU !== undefined ? `U${chosen.rackU}${chosen.rackUnits! > 1 ? `–${chosen.rackU + chosen.rackUnits! - 1}` : ''}` : 'not placed'} ·{' '}
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
      {/* LT-684: which way it breathes. */}
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
      {/* LT-689: what it draws and weighs. */}
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
      {preset && (
        <p className="cv-help cv-racks-stacknote">
          {preset.note} <em>{t('rackPanel.fromGuideLong', { source: preset.source })}</em>
        </p>
      )}
      <label className="cv-field">
        <span>{t('rackPanel.topology')}</span>
        <select className="cv-input" aria-label={t('rackPanel.topology')} value={draft.topology} onChange={(e) => onChange({ ...draft, topology: e.target.value as StackTopology })}>
          {(preset?.topologies ?? ['ring', 'chain', 'pair']).map((tp) => <option key={tp} value={tp}>{tp}</option>)}
        </select>
      </label>
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
      </ol>
      <select className="cv-input" aria-label={t('rackPanel.addMember')} value=""
        onChange={(e) => { if (e.target.value) onChange({ ...draft, members: [...draft.members, e.target.value] }); }}>
        <option value="">{t('rackPanel.addMember')}</option>
        {candidates.map((d) => <option key={d.id} value={d.id}>{d.label}{d.rack ? ` · ${d.rack}` : ''}</option>)}
      </select>
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

/* ------------------------------------------------------------- helpers */

/** The SVG export rasterised, for a PNG beside it (LT-689). */
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
