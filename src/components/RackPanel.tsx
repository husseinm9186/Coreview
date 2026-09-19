/**
 * Rack elevations (LT-195–197): the project's racks drawn U by U, from the
 * front or the rear, with the devices on the diagram placed in them.
 *
 * A device is dragged into a rack from the list beside it, or moved within or
 * between racks, and always lands on a whole U — there is no free placement to
 * turn off (the D-013 amendment). A move into space something else holds is
 * refused with what is in the way. The selected box moves a U at a time with
 * the arrow keys.
 */
import { useMemo, useState } from 'react';

import { saveExport, slug } from '../lib/exports';
import { allNodes } from '../lib/pages';
import {
  DEFAULT_RACK_UNITS,
  MAX_RACK_UNITS,
  elevation,
  placementProblem,
  rackableOf,
  takesSpace,
  uAt,
  type Rack,
  type RackFace,
  type Rackable,
} from '../lib/rack';
import { rackElevationSvg } from '../lib/rackSvg';
import { useStore } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

export const UNIT_PX = 14;
const DRAG_TYPE = 'application/x-coreview-device';

export function RackPanel() {
  const doc = useStore((s) => s.doc);
  const meta = useStore((s) => s.meta);
  const exportFolder = useStore((s) => s.settings.exportFolder);
  const store = useStore.getState;
  const [face, setFace] = useState<RackFace>('front');
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newUnits, setNewUnits] = useState(String(DEFAULT_RACK_UNITS));
  const [filter, setFilter] = useState('');
  const [hover, setHover] = useState<{ rackId: string; u: number; units: number; problem: string | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const racks = useMemo(() => doc.racks ?? [], [doc.racks]);
  const devices = useMemo(
    () => allNodes(doc).filter((n) => n.type === 'device').map((n) => rackableOf(n.id, n.data as DeviceNodeData)),
    [doc],
  );
  const byId = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  const rackNames = new Set(racks.map((r) => r.name.trim().toLowerCase()));
  // Everything with a height that is not yet in a U of a rack that exists.
  const waiting = devices.filter(
    (d) =>
      takesSpace(d) &&
      !(d.rackU !== undefined && rackNames.has((d.rack ?? '').trim().toLowerCase())) &&
      (!filter.trim() || `${d.label} ${d.rack ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())),
  );
  const chosen = selected ? byId.get(selected) : undefined;

  const say = (problem: string | null, done: string) => setMessage(problem ?? done);

  const dropAt = (rack: Rack, e: React.DragEvent<HTMLElement>, device: Rackable) => {
    // Measured from inside the rail's border, where the first U starts.
    const slots = e.currentTarget.getBoundingClientRect();
    const u = uAt(e.clientY - slots.top - e.currentTarget.clientTop, UNIT_PX, rack.units, device.rackUnits!);
    return { u, problem: placementProblem(rack, devices, device, u, face) };
  };

  const exportSvg = async () => {
    const svg = rackElevationSvg(racks, devices, face);
    const path = await saveExport(`${slug(meta?.name ?? 'project')}-racks-${face}.svg`, svg, 'image/svg+xml', exportFolder);
    if (path) setMessage(`Saved the ${face} elevations to ${path}.`);
  };

  return (
    <div
      className="cv-racks"
      onKeyDown={(e) => {
        if (!chosen || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        const rack = racks.find((r) => r.name.trim().toLowerCase() === (chosen.rack ?? '').trim().toLowerCase());
        if (!rack || chosen.rackU === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        const u = chosen.rackU + (e.key === 'ArrowUp' ? 1 : -1);
        say(store().placeInRack(chosen.id, rack.id, u), `${chosen.label} moved to U${u}.`);
      }}
    >
      <div className="cv-racks-bar">
        <div className="cv-seg" role="group" aria-label="Rack face">
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
          <input className="cv-input" aria-label="New rack name" placeholder="Rack name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input
            className="cv-input cv-input-narrow"
            aria-label="New rack height in U"
            type="number"
            min={1}
            max={MAX_RACK_UNITS}
            value={newUnits}
            onChange={(e) => setNewUnits(e.target.value)}
          />
          <button type="submit" className="cv-btn cv-btn-small">
            Add rack
          </button>
        </form>
        <button
          type="button"
          className="cv-btn cv-btn-small"
          title="A rack for every rack name the devices carry, and a U for every device in one"
          onClick={() => {
            const got = store().buildRacksFromDevices();
            setMessage(
              got.racks === 0 && got.placed === 0
                ? got.full.length
                  ? `No room for ${got.full.join(', ')}.`
                  : 'Nothing to add: every device that names a rack is already in it.'
                : `Added ${got.racks} rack${got.racks === 1 ? '' : 's'} and placed ${got.placed} device${got.placed === 1 ? '' : 's'}.` +
                    (got.full.length ? ` No room for ${got.full.join(', ')}.` : ''),
            );
          }}
        >
          Build racks from devices
        </button>
        <button type="button" className="cv-btn cv-btn-small" disabled={racks.length === 0} onClick={() => void exportSvg()}>
          Export {face} as SVG
        </button>
        {message && (
          <span className="cv-racks-message" role="status">
            {message}
          </span>
        )}
      </div>

      {chosen && (
        <div className="cv-racks-chosen">
          <strong>{chosen.label}</strong>
          <span>
            {chosen.rackU !== undefined ? `U${chosen.rackU}${chosen.rackUnits! > 1 ? `–${chosen.rackU + chosen.rackUnits! - 1}` : ''}` : 'not placed'} ·{' '}
            {chosen.rackUnits}U · mounted {chosen.rackFace === 'rear' ? 'rear' : 'front'} · {chosen.rackDepth === 'half' ? 'half' : 'full'} depth
          </span>
          <button
            type="button"
            className="cv-btn cv-btn-small"
            onClick={() =>
              say(
                store().setRackDetails(chosen.id, { rackFace: chosen.rackFace === 'rear' ? 'front' : 'rear' }),
                `${chosen.label} is now mounted ${chosen.rackFace === 'rear' ? 'front' : 'rear'}.`,
              )
            }
          >
            Mount {chosen.rackFace === 'rear' ? 'front' : 'rear'}
          </button>
          <button
            type="button"
            className="cv-btn cv-btn-small"
            onClick={() =>
              say(
                store().setRackDetails(chosen.id, { rackDepth: chosen.rackDepth === 'half' ? 'full' : 'half' }),
                `${chosen.label} is now ${chosen.rackDepth === 'half' ? 'full' : 'half'} depth.`,
              )
            }
          >
            Make {chosen.rackDepth === 'half' ? 'full' : 'half'} depth
          </button>
          {chosen.rackU !== undefined && (
            <button
              type="button"
              className="cv-btn cv-btn-small"
              onClick={() => {
                store().takeOutOfRack(chosen.id);
                setMessage(`${chosen.label} is out of the rack.`);
              }}
            >
              Take out
            </button>
          )}
          <span className="cv-help">↑↓ move a U</span>
        </div>
      )}

      <div className="cv-racks-body">
        <aside className="cv-racks-waiting">
          <input className="cv-input" aria-label="Filter devices" placeholder="Filter devices" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <p className="cv-help">Drag a device into a rack. Only devices with a height in U are listed.</p>
          <ul>
            {waiting.slice(0, 200).map((d) => (
              <li
                key={d.id}
                draggable
                className={`cv-racks-device${selected === d.id ? ' is-selected' : ''}`}
                onDragStart={(e) => {
                  dragging = d.id;
                  e.dataTransfer.setData(DRAG_TYPE, d.id);
                }}
                onDragEnd={() => {
                  dragging = null;
                }}
                onClick={() => setSelected(d.id)}
              >
                {d.label}
                <span className="cv-racks-units">
                  {d.rackUnits}U{d.rack ? ` · ${d.rack}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {waiting.length > 200 && <p className="cv-help">{waiting.length - 200} more — filter to find them.</p>}
        </aside>

        {racks.length === 0 && (
          <p className="cv-help cv-racks-empty">
            No racks yet. Add one, or give devices a rack name in the inspector (Rack / room) and build racks from them.
          </p>
        )}

        {racks.map((rack) => {
          const view = elevation(rack, devices, face);
          return (
            <section key={rack.id} className="cv-rack" aria-label={`Rack ${rack.name}`}>
              <header className="cv-rack-head">
                <input
                  className="cv-input cv-rack-name"
                  aria-label="Rack name"
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
                  aria-label="Rack height in U"
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
                <button type="button" className="cv-layer-remove" aria-label={`Remove rack ${rack.name}`} title="Remove this rack. Devices keep their rack name and U." onClick={() => store().removeRack(rack.id)}>
                  ×
                </button>
              </header>
              <div className="cv-rack-frame">
                <ol className="cv-rack-numbers" aria-hidden="true">
                  {Array.from({ length: rack.units }, (_, i) => (
                    <li key={i} style={{ height: UNIT_PX }}>
                      {rack.units - i}
                    </li>
                  ))}
                </ol>
                <div
                  className="cv-rack-slots"
                  data-rack={rack.name}
                  style={{ height: rack.units * UNIT_PX }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    const id = [...e.dataTransfer.types].includes(DRAG_TYPE) ? dragging : null;
                    const device = id ? byId.get(id) : undefined;
                    if (!device) return;
                    const { u, problem } = dropAt(rack, e, device);
                    if (hover?.rackId !== rack.id || hover.u !== u || hover.problem !== problem) {
                      setHover({ rackId: rack.id, u, units: device.rackUnits!, problem });
                    }
                  }}
                  onDragLeave={() => setHover(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setHover(null);
                    const device = byId.get(e.dataTransfer.getData(DRAG_TYPE));
                    if (!device) return;
                    const { u } = dropAt(rack, e, device);
                    const problem = store().placeInRack(device.id, rack.id, u, face);
                    say(problem, `${device.label} placed in ${rack.name} at U${u}.`);
                    if (!problem) setSelected(device.id);
                  }}
                >
                  {view.items.map((item) => (
                    <button
                      key={item.device.id}
                      type="button"
                      draggable={item.seen === 'face'}
                      data-device={item.device.id}
                      className={`cv-rack-item is-${item.seen}${item.clash ? ' is-clash' : ''}${selected === item.device.id ? ' is-selected' : ''}`}
                      style={{ top: (rack.units - item.top) * UNIT_PX, height: (item.top - item.bottom + 1) * UNIT_PX }}
                      title={`${item.device.label} — U${item.bottom}${item.top > item.bottom ? `–${item.top}` : ''}${item.seen === 'behind' ? ', mounted on the other face' : ''}${item.clash ? ' — shares space with another device' : ''}`}
                      onDragStart={(e) => {
                        dragging = item.device.id;
                        e.dataTransfer.setData(DRAG_TYPE, item.device.id);
                      }}
                      onDragEnd={() => {
                        dragging = null;
                      }}
                      onClick={() => setSelected(item.device.id)}
                    >
                      <span className="cv-rack-item-label">{item.device.label}</span>
                    </button>
                  ))}
                  {hover?.rackId === rack.id && (
                    <div
                      className={`cv-rack-ghost${hover.problem ? ' is-refused' : ''}`}
                      style={{ top: (rack.units - (hover.u + hover.units - 1)) * UNIT_PX, height: hover.units * UNIT_PX }}
                      title={hover.problem ?? `U${hover.u}`}
                    />
                  )}
                </div>
              </div>
              {(view.zeroU.length > 0 || view.unplaced.length > 0) && (
                <footer className="cv-rack-foot">
                  {view.zeroU.length > 0 && <div>Zero-U: {view.zeroU.map((d) => d.label).join(', ')}</div>}
                  {view.unplaced.length > 0 && <div>Not placed: {view.unplaced.map((d) => d.label).join(', ')}</div>}
                </footer>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Which device is being dragged. `dataTransfer` cannot be read during
 *  dragover, only on drop, so the preview needs its own note of it. */
let dragging: string | null = null;
