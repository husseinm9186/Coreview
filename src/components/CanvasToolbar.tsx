/**
 * The canvas strip: one row docked above the pane holding everything that
 * acts on the canvas — zoom, the grid and the page, snapping, the ground,
 * the drawing tools, arranging, the filter and the overview — as icon
 * buttons grouped by dividers. A toggle shows its state by its fill, never
 * by rewriting its label. Save, Undo and Redo act on the document and live
 * in the top bar; the ink tools used to float on the pane in a bar of
 * their own, which took the top-left band away from lassos and drops.
 */
import { useEffect, useRef, useState } from 'react';
import { useReactFlow, useViewport } from '@xyflow/react';

import { t } from '../i18n';
import { activePage } from '../lib/pages';
import { effectivePage, pageForContent } from '../lib/pageRect';
import { PAGE_SIZES, pageRectFor, type Orientation, type PageSizeId } from '../lib/pageSize';
import { useStore } from '../state/store';
import { CanvasFilterMenu } from './CanvasFilterMenu';
import { CanvasTypeFilter } from './CanvasTypeFilter';
import { ChromeIcon, IconButton } from './chromeIcons';
import { arrangeByLayerMessage, layoutMessage } from './arrangeMessages';
import { foldableRoles, holdersBelow, holdersOfRole, ROLE_WORD, siteKeys } from '../lib/clusters';

/** The pen's inks. Chosen to read on both grounds. */
const COLOURS: [string, string][] = [
  ['#ff6259', 'Red'],
  ['#f2b544', 'Amber'],
  ['#35c26f', 'Green'],
  ['#5aa7f5', 'Blue'],
  ['#1f2933', 'Black'],
];

export function CanvasToolbar() {
  const rf = useReactFlow();
  const gridSnap = useStore((s) => Boolean(s.doc.gridSnap));
  const ground = useStore((s) => s.settings.ground);
  const minimap = useStore((s) => s.settings.minimap);
  const pg = useStore((s) => activePage(s.doc));
  const tool = useStore((s) => s.inkTool);
  const setTool = useStore((s) => s.setInkTool);
  const inkHidden = pg.canvas.inkHidden ?? false;
  const inkCount = (pg.canvas.ink ?? []).length;
  const selected = pg.nodes.filter((n) => n.selected).length;
  const pinnedCount = pg.nodes.filter((n) => (n.data as { placedBy?: string }).placedBy === 'hand').length;
  const foldFans = useStore((s) => s.settings.foldFans);
  // What there is to fold, read when the menu opens rather than on every
  // change: every device's branch is walked to find the fans.
  const [folds, setFolds] = useState<{ sites: string[]; roles: ReturnType<typeof foldableRoles>; holders: Map<string, Set<string>> } | null>(null);
  const readFolds = () => {
    const holders = holdersBelow(pg.nodes, pg.edges);
    setFolds({ sites: siteKeys(pg.nodes), roles: foldableRoles(pg.nodes, holders), holders });
  };
  const [color, setColor] = useState(COLOURS[0]![0]);
  const [width, setWidth] = useState(3);
  const { zoom } = useViewport();
  const gridStyle = (pg.canvas.gridEnabled ?? true) ? (pg.canvas.gridStyle ?? 'lines') : 'none';
  const growPage = pg.canvas.growPage ?? true;
  const closeMenus = (e: React.MouseEvent) => (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
  // A bare <details> opens and then stays open: neither Escape nor a click
  // elsewhere closes it, so a menu sat over the canvas until its own summary
  // was clicked again — and the next click on the summary closed rather
  // than opened it. Every menu in the strip gets the dismissal the top bar's
  // export menu has.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const openMenus = () => [...(strip.current?.querySelectorAll<HTMLDetailsElement>('details[open]') ?? [])];
    const away = (e: Event) => {
      for (const el of openMenus()) if (!el.contains(e.target as Node)) el.open = false;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const open = openMenus();
      if (open.length === 0) return;
      for (const el of open) el.open = false;
      // Focus goes back to the control that opened it, or it lands on <body>
      // and the next Tab restarts from the top of the page.
      open[0]?.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, []);
  const setGrid = (style: 'lines' | 'dots' | 'none') => useStore.getState().setCanvas({ gridEnabled: style !== 'none', gridStyle: style });
  // The sheet as a paper size. Choosing one fixes the sheet to it —
  // a page that grew past A4 would not be A4 — and "fit the diagram" lets it
  // grow again.
  const pageSize = pg.canvas.pageSize;
  const pageName = pageSize ? `${PAGE_SIZES.find((x) => x.id === pageSize.id)?.name ?? pageSize.id} ${t(`canvasTools.${pageSize.orientation}`)}` : t('canvasTools.pageFit');
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

  const pick = (mode: 'pen' | 'eraser') => setTool(tool?.mode === mode ? null : { mode, color, width });
  const arrangeByLayer = () => useStore.getState().setStatusMessage(arrangeByLayerMessage(useStore.getState().flowLayout()));
  const arrangeSelected = (how: 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom' | 'across' | 'down') => {
    const ids = pg.nodes.filter((n) => n.selected).map((n) => n.id);
    const moved = useStore.getState().arrange(ids, how);
    useStore.getState().setStatusMessage(moved === 0 ? t('canvasTools.alreadyArranged') : t('canvasTools.moved', { count: moved }));
  };

  return (
    <div className="cv-canvas-tools" role="toolbar" aria-label={t('canvasTools.title')} data-region="canvas-tools" ref={strip}>
      {/* The view. */}
      <div className="cv-strip-group" role="group" aria-label={t('canvasTools.zoomLevel')}>
        {/* First in the row, and first in the DOM: the zoom menu behind it
            lists "Fit view" too, and a hidden item must not come first. */}
        <IconButton icon="fit" label={t('canvasTools.fitView')} region="fit-view" onClick={fit} />
        {/* Beside Fit, because a crawl's first two moves are "arrange it"
            and "show me all of it". */}
        <IconButton icon="layers" label={t('canvasTools.arrangeLayers')} region="arrange-layers" onClick={arrangeByLayer} className="cv-arrange-layers" />
        <IconButton icon="zoom-out" label={t('canvasTools.zoomOut')} shortcut="Ctrl+−" region="zoom-out" onClick={() => void rf.zoomOut()} />
        {/* The zoom as a number, and the presets behind it. */}
        <details className="cv-dropdown cv-zoom-menu">
          <summary className="cv-icon-btn cv-zoom-level" aria-label={t('canvasTools.zoomLevel')} title={t('canvasTools.zoomLevelHint')} data-region="zoom-level">
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
        <IconButton icon="zoom-in" label={t('canvasTools.zoomIn')} shortcut="Ctrl+=" region="zoom-in" onClick={() => void rf.zoomIn()} />
      </div>
      <span className="cv-strip-sep" />

      {/* The sheet. */}
      <div className="cv-strip-group" role="group" aria-label={t('canvasTools.page')}>
        {/* The grid — lines, dots or none — and whether the page grows. */}
        <details className="cv-dropdown cv-grid-menu">
          <summary className="cv-icon-btn is-menu" aria-label={t('canvasTools.grid')} title={t('canvasTools.gridHint')} data-region="grid-menu">
            <ChromeIcon name="grid" />
            <span className="cv-sr">{t('canvasTools.grid')}: {t(`canvasTools.grid.${gridStyle}`)}</span>
            <ChromeIcon name="chevron-down" className="cv-icon-caret" />
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
        {/* The page as paper — size, way round, margins, rulers. A chosen
            size shows as its name; the diagram's own size shows nothing. */}
        <details className="cv-dropdown cv-page-menu">
          <summary className="cv-icon-btn is-menu" aria-label={t('canvasTools.page')} title={t('canvasTools.pageHint')} data-region="page-menu">
            <ChromeIcon name="page" />
            {pageSize ? <span className="cv-icon-word">{PAGE_SIZES.find((x) => x.id === pageSize.id)?.name ?? pageSize.id}</span> : null}
            <span className="cv-sr">{t('canvasTools.page')}: {pageName}</span>
            <ChromeIcon name="chevron-down" className="cv-icon-caret" />
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
        <IconButton icon="snap" label={t('canvasTools.snap')} shortcut="Ctrl+Shift+G" pressed={gridSnap} region="snap-toggle"
          onClick={() => useStore.getState().setGridSnap(!gridSnap)} />
        <IconButton icon="ground" label={ground === 'light' ? t('canvasTools.groundDark') : t('canvasTools.groundLight')} pressed={ground === 'light'} region="ground-toggle"
          onClick={() => useStore.getState().setSettings({ ground: ground === 'light' ? 'dark' : 'light' })} />
      </div>
      <span className="cv-strip-sep" />

      {/* Drawing and filtering by type. */}
      <div className="cv-strip-group" role="group" aria-label={t('inkLayer.drawingAndFiltering')} data-region="ink-tools">
        <CanvasTypeFilter />
        <IconButton icon="pen" label={t('inkLayer.pen')} shortcut="Esc stops" pressed={tool?.mode === 'pen'} region="pen" onClick={() => pick('pen')} />
        <IconButton icon="eraser" label={t('inkLayer.eraser')} pressed={tool?.mode === 'eraser'} disabled={inkCount === 0} region="eraser" onClick={() => pick('eraser')} />
        {tool?.mode === 'pen' && (
          <span className="cv-ink-options">
            {COLOURS.map(([c, name]) => (
              <button key={c} type="button" className={`cv-ink-swatch${color === c ? ' is-on' : ''}`} style={{ background: c }} aria-label={`${name} ink`} aria-pressed={color === c}
                onClick={() => { setColor(c); setTool({ mode: 'pen', color: c, width }); }} />
            ))}
            <select className="cv-input cv-ink-width" aria-label={t('inkLayer.penWidth')} value={width} onChange={(e) => { const w = Number(e.target.value); setWidth(w); setTool({ mode: 'pen', color, width: w }); }}>
              {[2, 3, 5, 8].map((w) => <option key={w} value={w}>{w}px</option>)}
            </select>
          </span>
        )}
        {inkCount > 0 && (
          <IconButton icon={inkHidden ? 'eye-off' : 'eye'} label={inkHidden ? t('inkLayer.showInk', { count: inkCount }) : t('inkLayer.hideInk')} pressed={!inkHidden} region="ink-visible"
            onClick={() => useStore.getState().setCanvas({ inkHidden: !inkHidden })} />
        )}
      </div>
      <span className="cv-strip-sep" />

      {/* Arranging, filtering, the overview. */}
      <div className="cv-strip-group" role="group" aria-label={t('canvasTools.arrange')}>
        <details className="cv-dropdown cv-arrange-menu" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) readFolds(); }}>
          <summary className="cv-icon-btn is-menu" title={t('canvasTools.arrangeHint')} data-region="arrange-menu">
            <ChromeIcon name="arrange" />
            <span className="cv-icon-word">{t('canvasTools.arrange')}</span>
            <ChromeIcon name="chevron-down" className="cv-icon-caret" />
          </summary>
          <div className="cv-dropdown-menu" role="menu">
            <button type="button" role="menuitem" title={t('canvasTools.arrangeLayersHint')} onClick={(e) => { closeMenus(e); arrangeByLayer(); }}>{t('canvasTools.arrangeLayers')}</button>
            <button type="button" role="menuitem" title={t('canvasTools.layoutRadialHint')} onClick={(e) => { closeMenus(e); useStore.getState().setStatusMessage(layoutMessage(useStore.getState().autoLayout('radial'))); }}>{t('canvasTools.layoutRadial')}</button>
            <button type="button" role="menuitem" title={t('canvasTools.unpinMovedHint')} disabled={pinnedCount === 0} data-region="unpin-moved"
              onClick={(e) => { closeMenus(e); const n = useStore.getState().unpinMoved(); useStore.getState().setStatusMessage(t('canvasTools.unpinned', { devices: t('plural.device', { count: n }) })); }}>
              {t('canvasTools.unpinMoved')}{pinnedCount ? ` (${pinnedCount})` : ''}
            </button>
            {/* Folding: sites into boxes, fans into chips, and everything back. */}
            <button type="button" role="menuitem" data-region="collapse-by-site" disabled={!folds || folds.sites.length === 0}
              onClick={(e) => {
                closeMenus(e);
                if (!folds) return;
                useStore.getState().setFoldedGroups(folds.sites);
                useStore.getState().setStatusMessage(t('canvasTools.collapsedSites', { sites: t('plural.siteFolded', { count: folds.sites.length }) }));
              }}>
              {t('canvasTools.collapseBySite', { count: folds?.sites.length ?? 0 })}
            </button>
            {(folds?.roles ?? []).map((r) => (
              <button key={r.role} type="button" role="menuitem" data-region={`collapse-below-${r.role}`}
                onClick={(e) => {
                  closeMenus(e);
                  if (!folds) return;
                  useStore.getState().collapseMany(holdersOfRole(pg.nodes, folds.holders, r.role));
                  useStore.getState().setStatusMessage(t('canvasTools.collapsedBelow', { role: ROLE_WORD[r.role].title, fans: t('plural.fan', { count: r.holders }), devices: t('plural.device', { count: r.devices }) }));
                }}>
                {t('canvasTools.collapseBelow', { role: ROLE_WORD[r.role].title, fans: t('plural.fan', { count: r.holders }), devices: t('plural.device', { count: r.devices }) })}
              </button>
            ))}
            <button type="button" role="menuitem" data-region="expand-everything"
              onClick={(e) => { closeMenus(e); useStore.getState().expandAll(); useStore.getState().setStatusMessage(t('canvasTools.expandedAll')); }}>
              {t('canvasTools.expandEverything')}
            </button>
            <label className="cv-check" title={t('canvasTools.foldFansHint')}>
              <input type="checkbox" data-region="fold-fans" checked={foldFans} onChange={(e) => useStore.getState().setSettings({ foldFans: e.target.checked })} />
              {t('canvasTools.foldFans')}
            </label>
            <p className="cv-help">{selected < 2 ? t('canvasTools.arrangeSelectHint') : t('canvasTools.arrangeSelected', { count: selected })}</p>
            {([
              ['left', t('canvasTools.alignLeft')], ['centre', t('canvasTools.alignCentre')], ['right', t('canvasTools.alignRight')],
              ['top', t('canvasTools.alignTop')], ['middle', t('canvasTools.alignMiddle')], ['bottom', t('canvasTools.alignBottom')],
              ['across', t('canvasTools.evenAcross')], ['down', t('canvasTools.evenDown')],
            ] as const).map(([how, label]) => (
              <button key={how} type="button" role="menuitem" disabled={selected < 2} onClick={(e) => { closeMenus(e); arrangeSelected(how); }}>{label}</button>
            ))}
          </div>
        </details>
        <CanvasFilterMenu />
        <IconButton icon="overview" label={t('canvasTools.overview')} pressed={minimap} region="overview-toggle"
          onClick={() => useStore.getState().setSettings({ minimap: !minimap })} />
      </div>
    </div>
  );
}
