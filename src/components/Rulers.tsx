/**
 * Rulers along the top and left of the canvas, counting from the
 * page's corner in millimetres or inches at whatever the zoom is. Drawn
 * over the pane's edge and taking no pointer events, so nothing underneath
 * moves to make room for them. The steps come from `rulerScale`, which
 * keeps labelled ticks far enough apart to read.
 */
import { useViewport } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { effectivePage } from '../lib/pageRect';
import { rulerScale, rulerTicks, type RulerUnits } from '../lib/pageSize';
import { activePage } from '../lib/pages';
import { useStore } from '../state/store';

export const RULER_PX = 18;

export function Rulers({ units }: { units: RulerUnits }) {
  const { x: vx, y: vy, zoom } = useViewport();
  const sheetRect = useStore((s) => activePage(s.doc).canvas.sheetRect);
  const nodes = useStore((s) => activePage(s.doc).nodes);
  const sheet = useMemo(() => effectivePage(sheetRect, nodes), [sheetRect, nodes]);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const scale = useMemo(() => rulerScale(zoom, units), [zoom, units]);
  // The flow range on screen, then the ticks across it.
  const left = (RULER_PX - vx) / zoom;
  const right = (size.w - vx) / zoom;
  const top = (RULER_PX - vy) / zoom;
  const bottom = (size.h - vy) / zoom;
  const xs = size.w ? rulerTicks(left, right, sheet.x, scale) : [];
  const ys = size.h ? rulerTicks(top, bottom, sheet.y, scale) : [];
  const sx = (fx: number) => fx * zoom + vx;
  const sy = (fy: number) => fy * zoom + vy;

  return (
    <div className="cv-rulers" ref={ref} aria-hidden data-units={units} data-major={Math.round(scale.major * 100) / 100}>
      <svg className="cv-ruler is-top" width={size.w} height={RULER_PX}>
        {xs.map((t) => {
          const x = sx(t.at);
          if (x < RULER_PX) return null;
          return (
            <g key={t.at}>
              <line x1={x} x2={x} y1={t.major ? 4 : 11} y2={RULER_PX} />
              {t.major && <text x={x + 2} y={9}>{t.label}</text>}
            </g>
          );
        })}
      </svg>
      <svg className="cv-ruler is-left" width={RULER_PX} height={size.h}>
        {ys.map((t) => {
          const y = sy(t.at);
          if (y < RULER_PX) return null;
          return (
            <g key={t.at}>
              <line y1={y} y2={y} x1={t.major ? 4 : 11} x2={RULER_PX} />
              {t.major && <text transform={`translate(8 ${y - 2}) rotate(-90)`}>{t.label}</text>}
            </g>
          );
        })}
      </svg>
      <div className="cv-ruler-corner">{units}</div>
    </div>
  );
}
