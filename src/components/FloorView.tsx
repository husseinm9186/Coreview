/**
 * The floor: one room's racks as footprints on a metre grid,
 * drawn at a pixel per centimetre and scaled by the stage's zoom. A rack
 * is dragged into place and snaps to 100 mm; double-clicking opens its
 * elevation; the air in front of and behind each rack is shaded from what
 * its boxes do; "number as they stand" reads rows and positions back off
 * the floor.
 */
import { useRef, useState } from 'react';

import { t } from '../i18n';
import { airBands, floorBounds, footprintBox, footprintsFor, numberAsTheyStand, snapFloor, type Facing, type Footprint } from '../lib/floorPlan';
import type { Rack } from '../lib/rack';
import { useStore } from '../state/store';

const S = 0.1;
const NEXT_FACING: Record<Facing, Facing> = { s: 'w', w: 'n', n: 'e', e: 's' };

export function FloorView({ heading, racks, zoom, airOf, target, onPick, onOpen, say }: {
  heading: string;
  racks: Rack[];
  zoom: number;
  airOf: (rack: Rack) => { frontToBack: number; backToFront: number };
  target: string | null;
  onPick: (rackId: string) => void;
  onOpen: (rackId: string) => void;
  say: (problem: string | null, done: string) => void;
}) {
  const store = useStore.getState;
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const fps = footprintsFor(racks).map((fp) => (drag && drag.id === fp.rack.id ? { ...fp, x: drag.x, y: drag.y, placed: true } : fp));
  const b = floorBounds(fps);
  const W = b.w * S;
  const H = b.h * S;
  const X = (mm: number) => (mm - b.x) * S;
  const Y = (mm: number) => (mm - b.y) * S;

  const startDrag = (fp: Footprint) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onPick(fp.rack.id);
    const origin = { px: e.clientX, py: e.clientY, x: fp.x, y: fp.y };
    const move = (ev: PointerEvent) => {
      const next = { id: fp.rack.id, x: snapFloor(origin.x + (ev.clientX - origin.px) / (S * zoom)), y: snapFloor(origin.y + (ev.clientY - origin.py) / (S * zoom)) };
      dragRef.current = next;
      setDrag(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const final = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (final && (final.x !== fp.x || final.y !== fp.y)) {
        say(store().updateRack(fp.rack.id, { floorX: final.x, floorY: final.y }), t('rackPanel.floorMoved', { name: fp.rack.name, x: (final.x / 1000).toFixed(1), y: (final.y / 1000).toFixed(1) }));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const targetRack = racks.find((r) => r.id === target);
  const gx0 = Math.ceil(b.x / 1000) * 1000;
  const gy0 = Math.ceil(b.y / 1000) * 1000;
  const gridX: number[] = [];
  for (let mm = gx0; mm <= b.x + b.w; mm += 1000) gridX.push(mm);
  const gridY: number[] = [];
  for (let mm = gy0; mm <= b.y + b.h; mm += 1000) gridY.push(mm);

  return (
    <div className="cv-floor" data-region="floor" data-heading={heading}>
      <svg className="cv-floor-plan" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('rackPanel.floorOf', { heading: heading || t('rackPanel.noPlace') })}>
        <rect className="cv-floor-ground" width={W} height={H} />
        {gridX.map((mm) => <line key={`x${mm}`} className="cv-floor-grid" x1={X(mm)} x2={X(mm)} y1={0} y2={H} />)}
        {gridY.map((mm) => <line key={`y${mm}`} className="cv-floor-grid" x1={0} x2={W} y1={Y(mm)} y2={Y(mm)} />)}
        {fps.flatMap((fp) => airBands(fp, airOf(fp.rack)).map((band, i) => (
          <rect key={`${fp.rack.id}-air-${i}`} className={`cv-floor-air is-${band.kind}`} data-kind={band.kind} x={X(band.x)} y={Y(band.y)} width={band.w * S} height={band.h * S} />
        )))}
        {fps.map((fp) => {
          const box = footprintBox(fp);
          const x = X(box.x);
          const y = Y(box.y);
          const w = box.w * S;
          const h = box.h * S;
          const front =
            fp.facing === 's' ? `M${x},${y + h} L${x + w},${y + h}`
            : fp.facing === 'n' ? `M${x},${y} L${x + w},${y}`
            : fp.facing === 'e' ? `M${x + w},${y} L${x + w},${y + h}`
            : `M${x},${y} L${x},${y + h}`;
          return (
            <g
              key={fp.rack.id}
              className={`cv-floor-rack${fp.rack.id === target ? ' is-target' : ''}${fp.placed ? ' is-placed' : ''}${drag?.id === fp.rack.id ? ' is-dragging' : ''}`}
              data-rack={fp.rack.name}
              data-x={fp.x}
              data-y={fp.y}
              data-facing={fp.facing}
              onPointerDown={startDrag(fp)}
              onDoubleClick={(e) => { e.stopPropagation(); onOpen(fp.rack.id); }}
            >
              <title>{`${fp.rack.name}${fp.rack.row ? ` · Row ${fp.rack.row}` : ''}${fp.rack.position ? ` · ${fp.rack.position}` : ''} — ${t('rackPanel.floorRackHint')}`}</title>
              <rect className="cv-floor-body" x={x} y={y} width={w} height={h} rx={1.5} />
              <path className="cv-floor-front" d={front} />
              <text className="cv-floor-name" x={x + w / 2} y={y + h / 2 - 1} textAnchor="middle">{fp.rack.name}</text>
              {(fp.rack.row || fp.rack.position) && (
                <text className="cv-floor-place" x={x + w / 2} y={y + h / 2 + 9} textAnchor="middle">
                  {[fp.rack.row ? `Row ${fp.rack.row}` : '', fp.rack.position ?? ''].filter(Boolean).join(' · ')}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="cv-floor-bar">
        <span className="cv-floor-legend" data-region="floor-legend">
          <i className="is-cold" /> {t('rackPanel.coldAisle')} <i className="is-hot" /> {t('rackPanel.hotAisle')} <i className="is-mixed" /> {t('rackPanel.mixedAisle')} · {t('rackPanel.floorScale')}
        </span>
        <button type="button" className="cv-btn cv-btn-small" title={t('rackPanel.numberAsTheyStandHint')} onClick={() => { store().renumberRacks(numberAsTheyStand(footprintsFor(racks))); say(null, t('rackPanel.numbered', { count: racks.length })); }}>
          {t('rackPanel.numberAsTheyStand')}
        </button>
        {targetRack && (
          <button type="button" className="cv-btn cv-btn-small" title={t('rackPanel.turnHint')} onClick={() => {
            const fp = fps.find((f) => f.rack.id === targetRack.id)!;
            say(store().updateRack(targetRack.id, { facing: NEXT_FACING[fp.facing] }), t('rackPanel.turned', { name: targetRack.name }));
          }}>
            {t('rackPanel.turn', { name: targetRack.name })}
          </button>
        )}
        {targetRack && typeof targetRack.floorX === 'number' && (
          <button type="button" className="cv-btn cv-btn-small" title={t('rackPanel.backToRowHint')} onClick={() => say(store().updateRack(targetRack.id, { floorX: NaN, floorY: NaN }), t('rackPanel.backToRow', { name: targetRack.name }))}>
            {t('rackPanel.backToRowBtn')}
          </button>
        )}
      </div>
    </div>
  );
}
