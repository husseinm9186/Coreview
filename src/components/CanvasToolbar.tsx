/**
 * The canvas toolbar: a row docked above the pane, so what
 * acts on the canvas sits beside it rather than in the top bar. Fit, zoom,
 * snap, the ground, the overview and the filter came down from the top bar;
 * Save, Undo and Redo keep a button here beside their shortcuts. The ink
 * tools keep their own strip, floating on the pane itself.
 */
import { useReactFlow, useViewport } from '@xyflow/react';

import { t } from '../i18n';
import { activePage } from '../lib/pages';
import { effectivePage, pageForContent } from '../lib/pageRect';
import { PAGE_SIZES, pageRectFor, type Orientation, type PageSizeId } from '../lib/pageSize';
import { useStore } from '../state/store';
import { CanvasFilterMenu } from './CanvasFilterMenu';

export function CanvasToolbar() {
  const rf = useReactFlow();
  const gridSnap = useStore((s) => Boolean(s.doc.gridSnap));
  const ground = useStore((s) => s.settings.ground);
  const minimap = useStore((s) => s.settings.minimap);
  const pg = useStore((s) => activePage(s.doc));
  const { zoom } = useViewport();
  const gridStyle = (pg.canvas.gridEnabled ?? true) ? (pg.canvas.gridStyle ?? 'lines') : 'none';
  const growPage = pg.canvas.growPage ?? true;
  const closeMenus = (e: React.MouseEvent) => (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
  const setGrid = (style: 'lines' | 'dots' | 'none') => useStore.getState().setCanvas({ gridEnabled: style !== 'none', gridStyle: style });
  // The sheet as a paper size. Choosing one fixes the sheet to it —
  // a page that grew past A4 would not be A4 — and "fit the diagram" lets it
  // grow again.
  const pageSize = pg.canvas.pageSize;
  const setPage = (id: PageSizeId | 'fit', orientation: Orientation) => {
    const s = useStore.getState();
    const sheet = effectivePage(pg.canvas.sheetRect, pg.nodes);
    if (id === 'fit') {
      s.setCanvas({ pageSize: undefined, growPage: true, sheetRect: pageForContent(pg.nodes) });
      s.setStatusMessage(t('canvasTools.pageFits'));
      return;
    }
    const rect = pageRectFor(id, orientation, { x: sheet.x, y: sheet.y });
    s.setCanvas({ pageSize: { id, orientation }, growPage: false, sheetRect: rect });
    s.setStatusMessage(t('canvasTools.pageSet', { name: PAGE_SIZES.find((x) => x.id === id)?.name ?? id, orientation: t(`canvasTools.${orientation}`) }));
  };

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
      <button type="button" className="cv-btn cv-btn-small" aria-label={t('canvasTools.zoomOut')} title={`${t('canvasTools.zoomOut')} (Ctrl+−)`} onClick={() => void rf.zoomOut()}>−</button>
      {/* The zoom as a number, and the presets behind it. */}
      <details className="cv-dropdown cv-zoom-menu">
        <summary className="cv-btn cv-btn-small cv-zoom-level" aria-label={t('canvasTools.zoomLevel')} title={t('canvasTools.zoomLevelHint')} data-region="zoom-level">
          {Math.round(zoom * 100)} %
        </summary>
        <div className="cv-dropdown-menu" role="menu">
          {[25, 50, 100, 200, 400].map((pc) => (
            <button key={pc} type="button" role="menuitem" className={Math.round(zoom * 100) === pc ? 'is-on' : ''} onClick={(e) => { closeMenus(e); void rf.zoomTo(pc / 100, { duration: 150 }); }}>
              {pc} %{pc === 100 ? <kbd>Ctrl+0</kbd> : null}
            </button>
          ))}
          <button type="button" role="menuitem" onClick={(e) => { closeMenus(e); fit(); }}>{t('canvasTools.fitView')}</button>
          <button type="button" role="menuitem" onClick={(e) => { closeMenus(e); void rf.zoomTo(1, { duration: 150 }); }}>{t('canvasTools.actualSize')}</button>
          <p className="cv-help">{t('canvasTools.zoomHelp')}</p>
        </div>
      </details>
      <button type="button" className="cv-btn cv-btn-small" aria-label={t('canvasTools.zoomIn')} title={`${t('canvasTools.zoomIn')} (Ctrl+=)`} onClick={() => void rf.zoomIn()}>+</button>
      <span className="cv-divider" />
      {/* The grid — lines, dots or none — and whether the page grows. */}
      <details className="cv-dropdown cv-grid-menu">
        <summary className="cv-btn cv-btn-small" aria-label={t('canvasTools.grid')} title={t('canvasTools.gridHint')} data-region="grid-menu">
          {t('canvasTools.grid')}: {t(`canvasTools.grid.${gridStyle}`)}
        </summary>
        <div className="cv-dropdown-menu" role="menu">
          {(['lines', 'dots', 'none'] as const).map((style) => (
            <button key={style} type="button" role="menuitem" className={gridStyle === style ? 'is-on' : ''} onClick={(e) => { closeMenus(e); setGrid(style); }}>
              {t(`canvasTools.grid.${style}`)}
            </button>
          ))}
          <label className="cv-check" title={t('canvasTools.growPageHint')}>
            <input type="checkbox" checked={growPage} onChange={(e) => useStore.getState().setCanvas({ growPage: e.target.checked })} />
            {t('canvasTools.growPage')}
          </label>
          <button type="button" role="menuitem" onClick={(e) => { closeMenus(e); useStore.getState().setCanvas({ sheetRect: pageForContent(pg.nodes) }); useStore.getState().setStatusMessage(t('canvasTools.pageFitted')); }}>
            {t('canvasTools.fitPage')}
          </button>
          <p className="cv-help">{t('canvasTools.gridHelp')}</p>
        </div>
      </details>
      {/* The page as paper — size, way round, margins, rulers. */}
      <details className="cv-dropdown cv-page-menu">
        <summary className="cv-btn cv-btn-small" aria-label={t('canvasTools.page')} title={t('canvasTools.pageHint')} data-region="page-menu">
          {t('canvasTools.page')}: {pageSize ? `${PAGE_SIZES.find((x) => x.id === pageSize.id)?.name ?? pageSize.id} ${t(`canvasTools.${pageSize.orientation}`)}` : t('canvasTools.pageFit')}
        </summary>
        <div className="cv-dropdown-menu" role="menu">
          <button type="button" role="menuitem" className={pageSize ? '' : 'is-on'} onClick={(e) => { closeMenus(e); setPage('fit', 'landscape'); }}>{t('canvasTools.pageFit')}</button>
          {PAGE_SIZES.map((s) => (
            <button key={s.id} type="button" role="menuitem" className={pageSize?.id === s.id ? 'is-on' : ''} onClick={(e) => { closeMenus(e); setPage(s.id, pageSize?.orientation ?? 'landscape'); }}>
              {s.name}
            </button>
          ))}
          <div className="cv-seg cv-seg-small" role="group" aria-label={t('canvasTools.orientation')}>
            {(['landscape', 'portrait'] as const).map((o) => (
              <button key={o} type="button" className={(pageSize?.orientation ?? 'landscape') === o ? 'is-on' : ''} aria-pressed={(pageSize?.orientation ?? 'landscape') === o} disabled={!pageSize}
                onClick={() => pageSize && setPage(pageSize.id, o)}>
                {t(`canvasTools.${o}`)}
              </button>
            ))}
          </div>
          <label className="cv-check" title={t('canvasTools.marginsHint')}>
            <input type="checkbox" checked={pg.canvas.showMargins ?? false} onChange={(e) => useStore.getState().setCanvas({ showMargins: e.target.checked })} />
            {t('canvasTools.margins')}
          </label>
          <label className="cv-check" title={t('canvasTools.rulersHint')}>
            <input type="checkbox" checked={pg.canvas.rulers ?? false} onChange={(e) => useStore.getState().setCanvas({ rulers: e.target.checked })} />
            {t('canvasTools.rulers')}
          </label>
          <div className="cv-seg cv-seg-small" role="group" aria-label={t('canvasTools.rulerUnits')}>
            {(['mm', 'in'] as const).map((u) => (
              <button key={u} type="button" className={(pg.canvas.rulerUnits ?? 'mm') === u ? 'is-on' : ''} aria-pressed={(pg.canvas.rulerUnits ?? 'mm') === u} onClick={() => useStore.getState().setCanvas({ rulerUnits: u })}>
                {u === 'mm' ? t('canvasTools.mm') : t('canvasTools.inches')}
              </button>
            ))}
          </div>
          <p className="cv-help">{t('canvasTools.pageHelp')}</p>
        </div>
      </details>
      {/* Whether dragging snaps to the grid, always in sight. */}
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
      <CanvasFilterMenu />
    </div>
  );
}
