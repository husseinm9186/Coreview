/**
 * Freehand ink on the canvas (LT-238): the strokes, drawn in diagram
 * coordinates so they move with the view; the pen and eraser; and the
 * show/hide toggle.
 *
 * With a tool in hand a transparent sheet lies over the canvas and takes the
 * pointer, so a stroke never drags a device by accident. Escape puts the tool
 * down.
 */
import { useEffect, useRef, useState } from 'react';
import { useReactFlow, ViewportPortal } from '@xyflow/react';

import { uid } from '../lib/id';
import { hitsStroke, safeStroke, simplifyStroke, strokePath, type InkStroke } from '../lib/ink';
import { activePage } from '../lib/pages';
import { useStore } from '../state/store';

const COLOURS: [string, string][] = [
  ['#e4564a', 'Red'],
  ['#f59e0b', 'Amber'],
  ['#2fbf6b', 'Green'],
  ['#4ea8f0', 'Blue'],
  ['#1f2933', 'Black'],
];

export function InkStrokes() {
  const canvas = useStore((s) => activePage(s.doc).canvas);
  const drawing = useStore((s) => s.inkDraft);
  if (canvas.inkHidden) return null;
  const strokes = (canvas.ink ?? []).map(safeStroke).filter((s): s is InkStroke => s !== null);
  if (strokes.length === 0 && !drawing) return null;
  return (
    <ViewportPortal>
      <svg className="cv-ink" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }} width={1} height={1} aria-hidden="true">
        {strokes.map((s) => (
          <path key={s.id} data-stroke={s.id} d={strokePath(s.points)} fill="none" stroke={s.color} strokeWidth={s.width} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {drawing && (
          <path d={strokePath(drawing.points)} fill="none" stroke={drawing.color} strokeWidth={drawing.width} strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </ViewportPortal>
  );
}

export function InkTools() {
  const rf = useReactFlow();
  const tool = useStore((s) => s.inkTool);
  const setTool = useStore((s) => s.setInkTool);
  const hidden = useStore((s) => activePage(s.doc).canvas.inkHidden ?? false);
  const count = useStore((s) => (activePage(s.doc).canvas.ink ?? []).length);
  const [color, setColor] = useState(COLOURS[0]![0]);
  const [width, setWidth] = useState(3);
  const draft = useRef<InkStroke | null>(null);

  useEffect(() => {
    if (!tool) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTool(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, setTool]);

  const at = (e: React.PointerEvent) => rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
  const eraseAt = (e: React.PointerEvent) => {
    const p = at(e);
    const zoom = rf.getZoom();
    const hit = [...(activePage(useStore.getState().doc).canvas.ink ?? [])].reverse().find((s) => hitsStroke(s, p.x, p.y, 6 / zoom));
    if (hit) useStore.getState().removeInkStroke(hit.id);
  };
  const pick = (mode: 'pen' | 'eraser') => setTool(tool?.mode === mode ? null : { mode, color, width });

  return (
    <>
      <div className="cv-ink-bar" role="toolbar" aria-label="Ink">
        <button type="button" className={`cv-btn cv-btn-small${tool?.mode === 'pen' ? ' is-on' : ''}`} aria-pressed={tool?.mode === 'pen'} onClick={() => pick('pen')} title="Draw freehand (Escape to stop)">
          ✎ Pen
        </button>
        <button type="button" className={`cv-btn cv-btn-small${tool?.mode === 'eraser' ? ' is-on' : ''}`} aria-pressed={tool?.mode === 'eraser'} onClick={() => pick('eraser')} disabled={count === 0} title="Click or drag over a stroke to remove it">
          ⌫ Eraser
        </button>
        {tool?.mode === 'pen' && (
          <>
            {COLOURS.map(([c, name]) => (
              <button key={c} type="button" className={`cv-ink-swatch${color === c ? ' is-on' : ''}`} style={{ background: c }} aria-label={`${name} ink`} aria-pressed={color === c}
                onClick={() => { setColor(c); setTool({ mode: 'pen', color: c, width }); }} />
            ))}
            <select className="cv-input cv-ink-width" aria-label="Pen width" value={width} onChange={(e) => { const w = Number(e.target.value); setWidth(w); setTool({ mode: 'pen', color, width: w }); }}>
              {[2, 3, 5, 8].map((w) => <option key={w} value={w}>{w}px</option>)}
            </select>
          </>
        )}
        {count > 0 && (
          <button type="button" className="cv-btn cv-btn-small" aria-pressed={!hidden}
            onClick={() => useStore.getState().setCanvas({ inkHidden: !hidden })} title="Ink that is hidden is also left out of exports">
            {hidden ? `Show ink (${count})` : `Hide ink`}
          </button>
        )}
      </div>
      {tool && (
        <div
          className={`cv-ink-sheet is-${tool.mode}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            if (tool.mode === 'eraser') {
              eraseAt(e);
              return;
            }
            if (hidden) useStore.getState().setCanvas({ inkHidden: false });
            const p = at(e);
            draft.current = { id: uid(), points: [p.x, p.y], color: tool.color, width: tool.width };
            useStore.setState({ inkDraft: draft.current });
          }}
          onPointerMove={(e) => {
            if (e.buttons !== 1) return;
            if (tool.mode === 'eraser') {
              eraseAt(e);
              return;
            }
            const d = draft.current;
            if (!d) return;
            const p = at(e);
            const [lx, ly] = [d.points[d.points.length - 2]!, d.points[d.points.length - 1]!];
            if (Math.hypot(p.x - lx, p.y - ly) * rf.getZoom() < 2) return;
            d.points = [...d.points, p.x, p.y];
            useStore.setState({ inkDraft: { ...d } });
          }}
          onPointerUp={() => {
            const d = draft.current;
            draft.current = null;
            useStore.setState({ inkDraft: null });
            if (!d) return;
            useStore.getState().addInkStroke({ ...d, points: simplifyStroke(d.points, 1 / rf.getZoom()) });
          }}
        />
      )}
    </>
  );
}
