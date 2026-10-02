/**
 * The canvas toolbar (LT-675, D-064): a row docked above the pane, so what
 * acts on the canvas sits beside it rather than in the top bar. Fit, zoom,
 * snap, the ground, the overview and the filter came down from the top bar;
 * Save, Undo and Redo keep a button here beside their shortcuts. The ink
 * tools keep their own strip, floating on the pane itself.
 */
import { useReactFlow } from '@xyflow/react';

import { t } from '../i18n';
import { activePage } from '../lib/pages';
import { effectivePage } from '../lib/pageRect';
import { useStore } from '../state/store';
import { CanvasFilterMenu } from './CanvasFilterMenu';

export function CanvasToolbar() {
  const rf = useReactFlow();
  const gridSnap = useStore((s) => Boolean(s.doc.gridSnap));
  const ground = useStore((s) => s.settings.ground);
  const minimap = useStore((s) => s.settings.minimap);
  const pg = useStore((s) => activePage(s.doc));

  const fit = () => {
    // Fits the sheet, not only what is on it: fitting to the devices alone
    // puts the page edge off-screen, and the edge is what says where the
    // drawing surface is.
    if (pg.canvas.sheet ?? true) {
      const sheet = effectivePage(pg.canvas.sheetRect, pg.nodes);
      rf.fitBounds({ x: sheet.x, y: sheet.y, width: sheet.w, height: sheet.h }, { padding: 0.08 });
      if (rf.getZoom() > 2) rf.zoomTo(2);
    } else {
      rf.fitView({ padding: 0.2, maxZoom: 2 });
    }
  };

  return (
    <div className="cv-canvas-tools" role="toolbar" aria-label={t('canvasTools.title')} data-region="canvas-tools">
      <button type="button" className="cv-btn cv-btn-small" onClick={() => void useStore.getState().saveProject()}>Save</button>
      <button type="button" className="cv-btn cv-btn-small" onClick={useStore.getState().undo} title="Ctrl+Z">Undo</button>
      <button type="button" className="cv-btn cv-btn-small" onClick={useStore.getState().redo} title="Ctrl+Y">Redo</button>
      <span className="cv-divider" />
      <button type="button" className="cv-btn cv-btn-small" onClick={fit}>Fit view</button>
      <button type="button" className="cv-btn cv-btn-small" aria-label={t('canvasTools.zoomOut')} title={t('canvasTools.zoomOut')} onClick={() => void rf.zoomOut()}>−</button>
      <button type="button" className="cv-btn cv-btn-small" aria-label={t('canvasTools.zoomIn')} title={t('canvasTools.zoomIn')} onClick={() => void rf.zoomIn()}>+</button>
      <span className="cv-divider" />
      {/* LT-175: whether dragging snaps to the grid, always in sight. */}
      <button
        type="button"
        className={`cv-btn cv-btn-small${gridSnap ? ' is-active' : ''}`}
        aria-pressed={gridSnap}
        title="Snap dragged objects to the grid where no alignment guide applies (Ctrl+Shift+G; Alt while dragging does the opposite)"
        onClick={() => useStore.getState().setGridSnap(!gridSnap)}
      >
        Grid snap {gridSnap ? 'on' : 'off'}
      </button>
      <button
        type="button"
        className="cv-btn cv-btn-small"
        title="Draw on white — for a document, a projector, or daylight. Every colour is chosen against the ground it is on, not inverted."
        onClick={() => useStore.getState().setSettings({ ground: ground === 'light' ? 'dark' : 'light' })}
      >
        {ground === 'light' ? 'Dark background' : 'White background'}
      </button>
      <label className="cv-check cv-check-inline" title="The overview box, bottom-right">
        <input type="checkbox" checked={minimap} onChange={(e) => useStore.getState().setSettings({ minimap: e.target.checked })} />
        Overview
      </label>
      {/* LT-232. */}
      <CanvasFilterMenu />
    </div>
  );
}
