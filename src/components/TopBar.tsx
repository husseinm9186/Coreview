import { useEffect, useRef, useState } from 'react';

import { useStore } from '../state/store';
import { ipc } from '../lib/ipc';
import { IconButton } from './chromeIcons';
import { buildMarkdownReport, saveExport, slug, svgToPng } from '../lib/exports';
import { cableSchedule, cableScheduleCsv } from '../lib/cableSchedule';
import { renderDiagramSvg } from '../lib/diagram';
import { allPrinted, isPrinted, layersOf } from '../lib/layers';
import { PAPERS, describePage, paperById, sheetSize, sheetsFor, tileRects } from '../lib/paper';
import { eventsToCsv, linksToCsv, nodesToCsv } from '../lib/csv';
import type { DeviceNodeData, HealthStatus, LinkData, NodeAddress } from '../types/domain';
import { STATUS_LABEL } from '../types/domain';
import { activePage, allEdges, allNodes } from '../lib/pages';
import { effectivePage } from '../lib/pageRect';
import { PAGE_SIZES, PRINT_ACTUAL_ZOOM } from '../lib/pageSize';
import { SAVE_ACK_MS, saveIndicator } from '../lib/saveIndicator';
import { drawioFile } from '../lib/drawio';
import { netboxJson, netboxYaml } from '../lib/netboxExport';
import { JobsBar } from './JobsBar';
import { interactiveHtml } from '../lib/htmlExport';
import { projectFolderFiles } from '../lib/projectFolder';
import { reportPages, type ReportSection, type ReportTemplate } from '../lib/reportPdf';
import { reportInput } from '../lib/reportData';
import { diffCrawls, diffSessions, type DiffRow } from '../lib/runDiff';
import { ReportDialog } from './ReportDialog';
import { DEVICE_LABEL } from './icons';
import { ipamCsv, portsCsv, probeResultsCsv, vlansCsv } from '../lib/tableCsv';
import { t } from '../i18n';
import type { ProjectPage } from '../state/store';
import { artworkSummary, vendorSafeDocument, vendorSafeNodes } from '../lib/thirdPartyArt';

const SESSION_LABEL: Record<string, string> = {
  stopped: 'Validation stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  error: 'Error',
};

export function TopBar({ onExit }: { onExit: () => void }) {
  const meta = useStore((s) => s.meta);
  const dirty = useStore((s) => s.dirty);
  const recovery = useStore((s) => s.recovery);
  const lastSavedAt = useStore((s) => s.lastSavedAt);
  const savedAck = useStore((s) => s.savedAck);
  const session = useStore((s) => s.session);
  const settings = useStore((s) => s.settings);
  // The dock's strip shows every job; this line stands in only while
  // a screen covers the dock and the strip is off-screen with it.
  const dockCovered = useStore((s) => s.registerOpen || s.toolsOpen || s.helpOpen);
  const doc = useStore((s) => s.doc);
  const events = useStore((s) => s.events);
  const linkStatus = useStore((s) => s.linkStatus);
  const nodeStatus = useStore((s) => s.nodeStatus);
  const recentSamples = useStore((s) => s.recentSamples);
  const runtime = useStore((s) => s.runtime);
  const exportMenu = useRef<HTMLDetailsElement>(null);
  const [about, setAbout] = useState(false);
  const updateWaiting = useStore((s) => (s.update.state === 'available' ? s.update.version : null));
  const [busy, setBusy] = useState<string | null>(null);
  // Replace imported stencils with built-in shapes in what is exported.
  const [vendorSafe, setVendorSafe] = useState(false);
  // Greys on white, for paper.
  const [printFriendly, setPrintFriendly] = useState(false);
  // Whether drawing exports cover the page in view or every page.
  const [pageScope, setPageScope] = useState<'page' | 'all'>('page');
  // The report dialog.
  const [reporting, setReporting] = useState(false);

  // Autosave. Runs only while a project is open and unsaved edits exist.
  // `auto` keeps it from claiming the green acknowledgement, which
  // belongs to a save somebody pressed for.
  useEffect(() => {
    if (!meta || !dirty) return;
    const t = setTimeout(() => void useStore.getState().saveProject({ auto: true }), 2500);
    return () => clearTimeout(t);
  }, [meta, dirty]);

  // The acknowledgement goes stale on a clock rather than on an
  // event, so something has to come back and repaint when it does. One timer
  // per save, cleared if another save lands first.
  const [, setAckTick] = useState(0);
  useEffect(() => {
    if (savedAck === null) return;
    const t = setTimeout(() => setAckTick((n) => n + 1), SAVE_ACK_MS + 50);
    return () => clearTimeout(t);
  }, [savedAck]);

  const save = saveIndicator({ dirty, lastSavedAt, savedAck, now: Date.now() });

  // A bare <details> opens and then stays open: neither Escape nor a click
  // elsewhere closes it, so the export menu sat over the canvas until someone
  // clicked "Export" a second time. Give it the dismissal every other menu has.
  useEffect(() => {
    const away = (e: Event) => {
      const el = exportMenu.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    };
    const key = (e: KeyboardEvent) => {
      const el = exportMenu.current;
      if (e.key !== 'Escape' || !el?.open) return;
      el.open = false;
      // Focus goes back to the control that opened it, or it lands on <body>
      // and the next Tab restarts from the top of the page.
      el.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, []);

  if (!meta) return null;

  const counts = statusCounts();

  /** Runs an export and reports where it landed, or that it failed. */
  const paper = paperById(settings.paper);
  const sheet = sheetSize(paper, settings.orientation);
  // Named `pg` rather than `page` — this file already uses "page" to mean
  // the paper an export is sized to, a different thing from a Pages
  // ProjectPage, and the two must not be confused inside this one file.
  const pg = activePage(doc);
  /** Said in the menu, because "A3 landscape" does not tell anyone whether
   *  their diagram will still be readable on it. */
  const pageNote = (() => {
    if (paper.width === 0) return 'The file is sized to the diagram.';
    const bounds = pg.nodes.reduce(
      (acc, n) => ({
        w: Math.max(acc.w, n.position.x + (n.width ?? 176)),
        h: Math.max(acc.h, n.position.y + (n.height ?? 96)),
      }),
      { w: 1, h: 1 },
    );
    const tiles = sheetsFor({ width: bounds.w, height: bounds.h }, sheet);
    return tiles.total > 1
      ? `${describePage(paper, settings.orientation)} — shrunk to fit one sheet, ` +
        `or ${tiles.total} sheets at full size when printed.`
      : `${describePage(paper, settings.orientation)} — the diagram fits at full size.`;
  })();

  /** A page as it prints: hidden views and views set not to print
   *  left out. The active page is what is being looked at; Exports
   *  every page the same way. */
  const printedOf = (page: ProjectPage) => {
    const layers = layersOf(page.canvas.layers);
    if (allPrinted(layers)) {
      return { nodes: page.nodes, edges: page.edges };
    }
    const nodes = page.nodes.filter((n) =>
      isPrinted((n.data as { layers?: string[] }).layers, layers),
    );
    const alive = new Set(nodes.map((n) => n.id));
    const edges = page.edges.filter(
      (e) =>
        isPrinted((e.data as { layers?: string[] } | undefined)?.layers, layers) &&
        alive.has(e.source) &&
        alive.has(e.target),
    );
    return { nodes, edges };
  };
  const shown = printedOf(pg);
  /** The pages a drawing export covers. */
  const exportPages = () => (pageScope === 'all' ? doc.pages : [pg]);
  /** A file name for one page of several. */
  const pageFile = (page: ProjectPage, ext: string) =>
    exportPages().length > 1 ? `${slug(meta.name)}-${slug(page.name) || 'page'}.${ext}` : `${slug(meta.name)}-diagram.${ext}`;

  // What the project holds of other people's artwork. Every page: a
  // package carries them all.
  const artwork = artworkSummary(allNodes(doc));
  const exportNodes = vendorSafe ? vendorSafeNodes(shown.nodes) : shown.nodes;
  const exportNodesOf = (page: ProjectPage) => (vendorSafe ? vendorSafeNodes(printedOf(page).nodes) : printedOf(page).nodes);

  const runExport = async (
    filename: string,
    build: () => string | Uint8Array | null,
    mime: string,
    carriesArtwork = false,
  ) => {
    try {
      const content = build();
      if (content === null) return;
      const path = await saveExport(filename, content, mime, settings.exportFolder);
      const warn =
        path && carriesArtwork && artwork.devices > 0 && !vendorSafe
          ? ' — it includes artwork from imported stencils; check you may share it, or use a vendor-safe export'
          : '';
      useStore.getState().setStatusMessage(path ? `Saved ${path}${warn}` : null);
    } catch (err) {
      useStore.getState().setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  };

  /** The diagram is drawn from the document, not from what is on screen, so a
   *  device scrolled out of view is still in the file. */
  const svgFor = (page: ProjectPage, options: { interactive?: boolean } = {}) => {
    const printed = printedOf(page);
    return renderDiagramSvg({
      meta,
      // What is on screen, not what is in the file: a view hidden to prepare a
      // document must not reappear in the document.
      nodes: exportNodesOf(page),
      edges: printed.edges,
      nodeStatus: (id) => nodeStatus(id),
      linkStatus: (id) => linkStatus(id),
      includeTitleBlock: true,
      nodeStyle: page.canvas.nodeStyle ?? 'glyph',
      lineJumps: page.canvas.lineJumps ?? true,
      glyphVariant: page.canvas.glyphVariant ?? 'outline',
      ink: page.canvas.inkHidden ? [] : page.canvas.ink,
      print: printFriendly,
      // What you are looking at is what comes out. Exporting dark from a
      // white screen put a black rectangle in the middle of a white page.
      ground: settings.ground,
      // A page on screen has no paper, and its devices can be clicked.
      page: sheet.w > 0 && !options.interactive ? { width: sheet.w, height: sheet.h } : undefined,
      tagNodes: options.interactive,
      // The on-screen sheet, computed from the same function the canvas
      // draws it with, and from the same visible nodes — hidden views do
      // not hold the exported sheet open either.
      sheetRect:
        (page.canvas.sheet ?? true)
          ? effectivePage(page.canvas.sheetRect, printed.nodes)
          : undefined,
    });
  };

  /** One file per page when every page is asked for — each through
   *  the save dialog unless an export folder is set. */
  const exportSvg = async () => {
    for (const page of exportPages()) {
      await runExport(pageFile(page, 'svg'), () => svgFor(page), 'image/svg+xml', true);
    }
  };

  // How many sheets the diagram spans at full size on the chosen paper.
  const contentBounds = () => {
    if (pg.canvas.sheet ?? true) {
      const p = effectivePage(pg.canvas.sheetRect, shown.nodes);
      return { x: p.x, y: p.y, width: p.w, height: p.h };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of shown.nodes) {
      minX = Math.min(minX, n.position.x); minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + (n.width ?? 176));
      maxY = Math.max(maxY, n.position.y + (n.height ?? 96));
    }
    if (!shown.nodes.length) return { x: 0, y: 0, width: 800, height: 600 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  };
  const sheetTiles = () => tileRects(contentBounds(), sheet, 36);

  /** One SVG per sheet, each a full-size slice of the diagram. Needs
   *  an export folder so the files land somewhere without one dialog per
   *  sheet; when none is set, the single-sheet SVG is written instead. */
  const exportSheets = async () => {
    const tiles = sheetTiles();
    if (tiles.length <= 1 || !settings.exportFolder) {
      exportSvg();
      if (tiles.length > 1) {
        useStore.getState().setStatusMessage('Set an export folder to write one file per sheet.');
      }
      return;
    }
    setBusy('sheets');
    try {
      let last: string | null = null;
      for (const t of tiles) {
        const svg = renderDiagramSvg({
          meta,
          nodes: exportNodes,
          edges: shown.edges,
          nodeStatus: (id) => nodeStatus(id),
          linkStatus: (id) => linkStatus(id),
          includeTitleBlock: true,
          nodeStyle: pg.canvas.nodeStyle ?? 'glyph',
          lineJumps: pg.canvas.lineJumps ?? true,
          glyphVariant: pg.canvas.glyphVariant ?? 'outline',
          ink: pg.canvas.inkHidden ? [] : pg.canvas.ink,
          print: printFriendly,
          ground: settings.ground,
          page: { width: sheet.w, height: sheet.h },
          tile: { x: t.x, y: t.y, w: t.w, h: t.h },
        });
        last = await saveExport(
          `${slug(meta.name)}-sheet-r${t.row + 1}c${t.col + 1}.svg`,
          svg,
          'image/svg+xml',
          settings.exportFolder,
        );
      }
      useStore.getState().setStatusMessage(last ? `Saved ${tiles.length} sheets to ${settings.exportFolder}` : null);
    } catch (err) {
      useStore.getState().setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** The same drawing the screen and the SVG export use, as a
   *  vector PDF — the format a change record or an approval wants. */
  const exportPdf = async () => {
    setBusy('pdf');
    try {
      // Every page asked for goes into one PDF, a page each.
      const pages = exportPages();
      const bytes = pages.length > 1 ? await ipc.diagramPdfPages(pages.map((p) => svgFor(p))) : await ipc.diagramPdf(svgFor(pg));
      await runExport(`${slug(meta.name)}-diagram.pdf`, () => bytes, 'application/pdf', true);
    } catch (err) {
      useStore.getState().setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** The drawing as Visio shapes and connectors — what a colleague
   *  who does not have Coreview can actually open and edit. */
  const exportVisio = async () => {
    setBusy('vsdx');
    try {
      // Every page asked for, each with its links' bends.
      const drawing = {
        title: meta.name,
        pages: exportPages().map((page) => {
          const printed = printedOf(page);
          const sheet = (page.canvas.sheet ?? true) ? effectivePage(page.canvas.sheetRect, printed.nodes) : null;
          const originX = sheet ? sheet.x : 0;
          const originY = sheet ? sheet.y : 0;
          const devices = printed.nodes.filter((n) => n.type === 'device');
          return {
            name: page.name,
            width: sheet ? sheet.w : 1584,
            height: sheet ? sheet.h : 1224,
            shapes: devices.map((n) => ({
              id: n.id,
              name: String((n.data as DeviceNodeData).label ?? ''),
              x: n.position.x - originX,
              y: n.position.y - originY,
              width: n.width ?? 76,
              height: n.height ?? 76,
            })),
            links: printed.edges.map((e) => {
              const d = (e.data ?? {}) as LinkData;
              const ports = [d.sourcePortLabel, d.targetPortLabel].filter(Boolean).join(' \u2194 ');
              return {
                from: e.source,
                to: e.target,
                label: d.label || ports,
                points: (d.waypoints ?? []).map((p) => [p.x - originX, p.y - originY] as [number, number]),
              };
            }),
          };
        }),
      };
      const bytes = await ipc.diagramVsdx(drawing);
      await runExport(
        `${slug(meta.name)}-diagram.vsdx`,
        () => bytes,
        'application/vnd.ms-visio.drawing',
      );
    } catch (err) {
      useStore.getState().setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const exportPng = async () => {
    setBusy('png');
    try {
      for (const page of exportPages()) {
        // svgToPng returns a data: URL; the payload after the comma is the PNG.
        const dataUrl = await svgToPng(svgFor(page));
        const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) =>
          c.charCodeAt(0),
        );
        await runExport(pageFile(page, 'png'), () => bytes, 'image/png', true);
      }
    } catch (err) {
      useStore.getState().setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** A PDF report from a template. Changes compare the last
   *  two validation sessions and the last two crawls, where there are two. */
  const makeReport = async (template: ReportTemplate, sections: ReportSection[]) => {
    setBusy('report');
    try {
      const diffs: { title: string; rows: DiffRow[] }[] = [];
      if (sections.includes('diffs')) {
        const sessions = (await ipc.listSessions(meta.id)).slice().sort((a, b) => b.startedAt - a.startedAt);
        if (sessions.length >= 2) {
          const [after, before] = [await ipc.sessionSummary(sessions[0]!.id), await ipc.sessionSummary(sessions[1]!.id)];
          const probeName = (id: string) => {
            const p = doc.probes.find((x) => x.id === id);
            const owner = p ? (allNodes(doc).find((n) => n.id === p.objectId)?.data as DeviceNodeData | undefined)?.label : undefined;
            return p ? `${owner ?? 'Link'} — ${p.name}` : id;
          };
          diffs.push({ title: 'Validation sessions', rows: diffSessions(before, after, probeName) });
        }
        const crawls = (await ipc.listCrawlRuns(meta.id)).slice().sort((a, b) => b.takenAt - a.takenAt);
        if (crawls.length >= 2) {
          const [after, before] = [await ipc.crawlRunResult(crawls[0]!.id), await ipc.crawlRunResult(crawls[1]!.id)];
          diffs.push({ title: 'Crawls', rows: diffCrawls(before.devices, after.devices) });
        }
      }
      const svgs = reportPages(
        reportInput({
          meta, doc: doc, template, sections, generatedAt: new Date(),
          runtime: runtime, samples: recentSamples, events: events,
          nodeStatus: (id) => nodeStatus(id),
          typeLabel: (t) => DEVICE_LABEL[t as keyof typeof DEVICE_LABEL] ?? t,
          diagrams: sections.includes('diagrams') ? exportPages().map((page) => ({ name: page.name, svg: svgFor(page) })) : [],
          diffs,
        }),
      );
      const bytes = await ipc.diagramPdfPages(svgs);
      await runExport(`${slug(meta.name)}-${template.id}-report.pdf`, () => bytes, 'application/pdf', sections.includes('diagrams'));
      useStore.getState().noteGuide('report');
      setReporting(false);
    } catch (err) {
      useStore.getState().setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** The pages asked for as one HTML file that works offline. */
  const exportHtml = () => {
    const facts = (d: DeviceNodeData): [string, string][] => [
      ['Vendor', d.vendor ?? ''], ['Model', d.model ?? ''], ['Serial', d.serial ?? ''], ['Asset tag', d.assetTag ?? ''],
      ['Role', d.role ?? ''], ['Site', d.site ?? ''], ['Rack', [d.rack, d.rackU !== undefined ? `U${d.rackU}` : ''].filter(Boolean).join(' ')],
      ['Hostname', d.hostname ?? ''], ['MAC', d.mac ?? ''], ['Software', d.osVersion ?? ''], ['Tags', (d.tags ?? []).join(', ')], ['Notes', d.notes ?? ''],
    ];
    void runExport(
      `${slug(meta.name)}-diagram.html`,
      () =>
        interactiveHtml(
          meta.name,
          [meta.customer, meta.site, meta.ticket].filter(Boolean).join(' · '),
          exportPages().map((page) => ({
            name: page.name,
            svg: svgFor(page, { interactive: true }),
            devices: exportNodesOf(page)
              .filter((n) => n.type === 'device')
              .map((n) => {
                const d = n.data as DeviceNodeData;
                return {
                  id: n.id,
                  label: d.label,
                  type: DEVICE_LABEL[d.deviceType] ?? d.deviceType,
                  status: STATUS_LABEL[nodeStatus(n.id)],
                  addresses: (d.addresses ?? []).map((a) => a.address).filter(Boolean),
                  facts: facts(d),
                };
              }),
          })),
        ),
      'text/html',
      true,
    );
  };

  /** The pages asked for as one draw.io file. */
  const exportDrawio = () => {
    void runExport(
      `${slug(meta.name)}-diagram.drawio`,
      () => drawioFile(exportPages().map((page) => ({ name: page.name, nodes: exportNodesOf(page), edges: printedOf(page).edges }))),
      'application/vnd.jgraph.mxfile',
      true,
    );
  };

  const exportCsv = () => {
    void runExport(`${slug(meta.name)}-events.csv`, () => eventsToCsv(events), 'text/csv');
  };

  /** The diagram as the two files the importer reads back. Every page:
   *  this is an inventory, not a drawing, and a device missing
   *  from it because the wrong tab was open would be a real surprise. */
  /** Every cable between devices, on every page. */
  const exportCableSchedule = () => {
    const rows = cableSchedule(doc);
    if (rows.length === 0) {
      useStore.getState().setStatusMessage('There are no links between devices to list.');
      return;
    }
    void runExport(`${slug(meta.name)}-cable-schedule.csv`, () => cableScheduleCsv(rows), 'text/csv');
  };

  const exportTopologyCsv = () => {
    const devices = allNodes(doc).filter((n) => n.type === 'device');
    const nameOf = new Map(
      devices.map((n) => [n.id, String((n.data as DeviceNodeData).label ?? '')]),
    );
    const probeFor = (nodeId: string) =>
      doc.probes.find((p) => p.objectKind === 'node' && p.objectId === nodeId);

    const rows = devices.map((n) => {
      const d = n.data as DeviceNodeData;
      const probe = probeFor(n.id);
      return {
        label: d.label,
        type: d.deviceType,
        address:
          d.addresses?.find((a: NodeAddress) => a.isPrimary)?.address ??
          d.addresses?.[0]?.address ??
          '',
        probeType: probe?.kind ?? 'manual',
        port: probe?.kind === 'tcp' ? (probe.tcpPort ?? undefined) : undefined,
        notes: d.notes ?? '',
        tags: d.tags ?? [],
        vendor: d.vendor,
        model: d.model,
        serial: d.serial,
        assetTag: d.assetTag,
        // Everything discovery learned, not only what the importer
        // needs to rebuild a diagram. This file is read for profiling.
        hostname: d.hostname,
        mac: d.mac,
        vlan: d.vlan,
        osVersion: d.osVersion,
        switchPort: d.switchPort,
        openPorts: d.openPorts,
        discoveredVia: d.discoveredVia,
        site: d.site,
        rack: d.rack,
        role: d.role,
        // A stack profiles like anything else.
        stackKind: d.stackKind,
        stackMembers: d.stackMembers,
      };
    });
    void runExport(`${slug(meta.name)}-devices.csv`, () => nodesToCsv(rows), 'text/csv');

    // Links reference devices by name, because that is what the importer
    // matches on and what a person reading the file can follow.
    const links = allEdges(doc)
      .filter((e) => nameOf.has(e.source) && nameOf.has(e.target))
      .map((e) => {
        const d = (e.data ?? {}) as LinkData;
        return {
          source: nameOf.get(e.source) ?? '',
          target: nameOf.get(e.target) ?? '',
          sourcePort: d.sourcePortLabel ?? '',
          targetPort: d.targetPortLabel ?? '',
          label: d.label ?? '',
          healthRule: d.healthRule?.type ?? 'both-endpoints',
        };
      });
    void runExport(`${slug(meta.name)}-links.csv`, () => linksToCsv(links), 'text/csv');
  };

  /**
   * Print on paper, which is white.
   *
   * The colours on the canvas are chosen against the ground they are drawn on
   * and half of them are set from script, so a diagram printed straight from
   * the dark ground comes out as pale grey lines on a white page. Switching
   * the ground first is the only way the printed sheet is the one that was
   * designed; it is put back afterwards, so nothing about the session changes.
   */
  const printOnPaper = async () => {
    // The page choice has to reach the print job, and only `@page` can carry
    // it — a stylesheet cannot be told a paper size any other way.
    const style = document.createElement('style');
    // A page drawn as a paper size prints on that paper; at 1:1 the
    // canvas is given the sheet's size on paper and the viewport is set by
    // the canvas (PRINT_ACTUAL_ZOOM) while `printing` is on.
    const drawn = pg.canvas.pageSize;
    const sheetName = drawn ? `${PAGE_SIZES.find((x) => x.id === drawn.id)?.name ?? 'A4'} ${drawn.orientation}` : paper.width === 0 ? '' : `${paper.name} ${settings.orientation}`;
    const actual = settings.printScale === 'actual';
    const sheet = effectivePage(pg.canvas.sheetRect, pg.nodes);
    style.textContent =
      `@page { ${sheetName ? `size: ${sheetName}; ` : ''}margin: ${actual ? 0 : 10}mm; }` +
      (actual
        ? ` @media print { .cv-canvas { width: ${Math.round(sheet.w * PRINT_ACTUAL_ZOOM)}px !important; height: ${Math.round(sheet.h * PRINT_ACTUAL_ZOOM)}px !important; overflow: hidden !important; } }`
        : '');
    document.head.appendChild(style);

    const was = settings.ground;
    if (was !== 'light') useStore.getState().setSettings({ ground: 'light' });
    // Views set not to print come off the canvas for the print job.
    useStore.getState().setPrinting(true);
    // Two frames: one for React to render the new ground, one for the
    // browser to paint it. Printing before the paint captures the old one.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      window.print();
    } finally {
      useStore.getState().setPrinting(false);
      if (was !== 'light') useStore.getState().setSettings({ ground: was });
      style.remove();
    }
  };

  const exportReport = () => {
    const md = buildMarkdownReport({
      meta,
      events: events,
      counts,
      // Every page: a validation report is a record, not a drawing.
      nodeCount: allNodes(doc).filter((n) => n.type === 'device').length,
      linkCount: allEdges(doc).length,
      sessionStart: session.startedAt,
      sessionEnd: session.state === 'stopped' ? Date.now() : null,
      cables: cableSchedule(doc),
      // The pages asked for, drawn into the report.
      diagrams: exportPages().map((page) => ({ name: page.name, svg: svgFor(page) })),
    });
    void runExport(`${slug(meta.name)}-report.md`, () => md, 'text/markdown');
  };

  /** The project as a folder of JSON and YAML, for version control. */
  const exportFolder = async () => {
    try {
      // The chosen export folder, or the folder dialog Rust shows.
      const folder = settings.exportFolder || null;
      // What is on screen, not what was last saved.
      if (dirty) await useStore.getState().saveProject();
      const pkg = await ipc.loadProject(meta.id);
      if (!pkg) return;
      const project = vendorSafe ? { ...pkg, document: vendorSafeDocument(pkg.document) } : pkg;
      const { json, yaml } = projectFolderFiles(project as unknown as Record<string, unknown>);
      // The folder is a token a dialog (or the chosen export folder) gave.
      const target = await ipc.pickExportFolder(folder);
      if (!target) return;
      const dir = await ipc.saveProjectFolder(target.token, slug(meta.name) || 'project', json, yaml);
      useStore.getState().setStatusMessage(`Saved ${dir} — project.coreview opens in Coreview; project.yaml is the readable copy`);
    } catch (err) {
      useStore.getState().setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const exportPackage = async (withCredentials = false) => {
    const pkg = await ipc.loadProject(meta.id);
    if (!pkg) return;
    // Credentials are app-wide rather than part of a project, so they are
    // never in an export unless asked for. A project package is the thing
    // people send to each other, and quietly including every saved password
    // in it is how they escape.
    // A vendor-safe package holds no imported artwork on any page.
    const project = vendorSafe ? { ...pkg, document: vendorSafeDocument(pkg.document) } : pkg;
    const payload = withCredentials
      ? { ...project, vault: await ipc.exportVault() }
      : project;
    await runExport(
      withCredentials ? `${slug(meta.name)}-with-credentials.coreview` : `${slug(meta.name)}.coreview`,
      () => JSON.stringify(payload, null, 2),
      'application/json',
      true,
    );
  };

  return (
    <div className="cv-topbar-wrap">
      {recovery && (
        <div className="cv-recovery" role="alert">
          <span>
            Unsaved work from {new Date(recovery.savedAt).toLocaleTimeString()} was found —
            this session ended before it could be saved.
          </span>
          <button type="button" className="cv-btn cv-btn-small" onClick={() => useStore.getState().restoreRecovery()}>
            Restore it
          </button>
          <button type="button" className="cv-btn cv-btn-small" onClick={() => useStore.getState().discardRecovery()}>
            Keep what was saved
          </button>
        </div>
      )}
    <header className="cv-topbar">
      <div className="cv-topbar-left">
        {/* The mark, drawn rather than imported, beside the name. */}
        <span className="cv-brand" title="Coreview — © 2026 Almoola">
          <svg className="cv-brand-mark" viewBox="0 0 512 512" aria-hidden focusable="false">
            <g stroke="currentColor" strokeWidth="26" strokeLinecap="round" fill="none">
              <path d="M256 196V150M256 316v46M196 256h-46M316 256h46" />
            </g>
            <path d="M256 168 332 212v88l-76 44-76-44v-88z" fill="none" stroke="currentColor"
              strokeWidth="26" strokeLinejoin="round" />
            <path d="M256 214 296 237v46l-40 23-40-23v-46z" fill="currentColor" />
            <g fill="currentColor" opacity="0.75">
              <rect x="206" y="66" width="100" height="84" rx="18" />
              <rect x="362" y="206" width="100" height="84" rx="18" />
              <rect x="206" y="362" width="100" height="84" rx="18" />
              <rect x="50" y="206" width="100" height="84" rx="18" />
            </g>
          </svg>
          Coreview
        </span>
        <span className="cv-project-name" title={meta.description}>
          {meta.name}
        </span>
        {meta.customer && <span className="cv-project-sub">{meta.customer}</span>}
        {meta.ticket && <span className="cv-ticket">{meta.ticket}</span>}
        {/* What is running, beside the save state, one line each —
            Only while a screen hides the dock and its strip. */}
        {dockCovered && <JobsBar compact />}
        <span
          className={`cv-save-state is-${save.tone}`}
          data-tone={save.tone}
          /* Spoken aloud when it changes, so the confirmation is not only a
             colour: a colour alone is no confirmation to a screen reader, nor
             to anybody who cannot tell this green from this grey. */
          role="status"
          aria-live="polite"
        >
          {save.tone === 'acknowledged' && <span className="cv-save-tick" aria-hidden="true">✓</span>}
          {save.at === null ? save.label : `${save.label} ${new Date(save.at).toLocaleTimeString()}`}
        </span>
        {/* The document's own verbs, beside its save state. */}
        <span className="cv-doc-verbs" role="group" aria-label={t('topbar.document')}>
          <IconButton icon="save" label={t('topbar.save')} shortcut="Ctrl+S" region="save" onClick={() => void useStore.getState().saveProject()} />
          <IconButton icon="undo" label={t('topbar.undo')} shortcut="Ctrl+Z" region="undo" onClick={() => useStore.getState().undo()} />
          <IconButton icon="redo" label={t('topbar.redo')} shortcut="Ctrl+Y" region="redo" onClick={() => useStore.getState().redo()} />
        </span>
      </div>

      {/* One row. The centre is validation and the four
          numbers you look at all day; the right is search, export, help and
          the rest behind More. What acts on the canvas is on the canvas
          (CanvasToolbar); the machine preferences are in Settings. */}
      <div className="cv-topbar-centre">

        {session.state === 'running' || session.state === 'stopping' ? (
          <button
            type="button"
            className="cv-btn cv-btn-stop"
            onClick={() => void useStore.getState().stopValidation()}
          >
            Stop validation
          </button>
        ) : (
          <button
            type="button"
            className="cv-btn cv-btn-start"
            onClick={() => void useStore.getState().startValidation()}
            disabled={session.state === 'starting'}
          >
            Start validation
          </button>
        )}

        <span className={`cv-session-state is-${session.state}`}>
          <span className="cv-dot" aria-hidden />
          {SESSION_LABEL[session.state]}
        </span>

        <div className="cv-counts">
          {(['healthy', 'warning', 'down', 'unknown'] as HealthStatus[]).map((s) => (
            <span key={s} className={`cv-count is-${s}`} title={STATUS_LABEL[s]}>
              {STATUS_LABEL[s]} {counts[s]}
            </span>
          ))}
        </div>

      </div>

      <div className="cv-topbar-actions">
        {/* Said once a check has found a newer release — by the button, or
            at start under the setting. Never shown otherwise. */}
        {updateWaiting && (
          <button type="button" className="cv-btn cv-btn-start cv-btn-update" data-action="update-available"
            title={t('topbar.updateAvailableTitle')}
            onClick={() => useStore.getState().setToolsOpen(true, 'settings')}>
            {t('topbar.updateAvailable', { version: updateWaiting })}
          </button>
        )}
        <button type="button" className="cv-btn cv-btn-search" title={t('topbar.searchTitle')}
          onClick={() => useStore.getState().requestCommandPalette(true)}>
          <span aria-hidden>⌕</span> {t('topbar.search')}
        </button>

        <details className="cv-dropdown" ref={exportMenu}>
          <summary className="cv-btn">Export</summary>
          <div
            className="cv-dropdown-menu"
            onClick={() => {
              if (exportMenu.current) exportMenu.current.open = false;
            }}
          >
            {/* The operator is responsible for imported artwork
                leaving the organisation, so the menu says it is there. */}
            {artwork.devices > 0 && (
              <div className="cv-dropdown-field cv-export-artwork" onClick={(e) => e.stopPropagation()}>
                <p className="cv-help" role="note">
                  ⚠ {t('plural.deviceUses', { count: artwork.devices })} imported stencils —
                  exports may include third-party artwork.
                  {artwork.licences.length > 0 && <> Licences: {artwork.licences.join('; ')}.</>}
                  {artwork.undescribed > 0 && <> {artwork.undescribed} with no licence statement.</>}
                </p>
                <label className="cv-check">
                  <input
                    type="checkbox"
                    checked={vendorSafe}
                    onChange={(e) => setVendorSafe(e.target.checked)}
                  />
                  Vendor-safe export — built-in shapes instead
                </label>
                {vendorSafe && (
                  <span className="cv-help">Applies to the diagram files and the project package. Printing shows the canvas as it is.</span>
                )}
              </div>
            )}
            <label className="cv-check cv-dropdown-field" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={printFriendly}
                onChange={(e) => setPrintFriendly(e.target.checked)}
              />
              Print-friendly — greys on white, less ink
            </label>
            {doc.pages.length > 1 && (
              <label className="cv-dropdown-field" onClick={(e) => e.stopPropagation()}>
                Pages
                <select className="cv-input" aria-label="Pages to export" value={pageScope} onChange={(e) => setPageScope(e.target.value as 'page' | 'all')}>
                  <option value="page">This page</option>
                  <option value="all">All {doc.pages.length} pages</option>
                </select>
              </label>
            )}
            <button type="button" onClick={exportPng} disabled={busy === 'png'}>
              Diagram as PNG
            </button>
            <button type="button" onClick={() => void exportSvg()}>
              Diagram as SVG
            </button>
            <button type="button" onClick={() => void exportPdf()} disabled={busy === 'pdf'}>
              Diagram as PDF
            </button>
            <button type="button" onClick={() => void exportVisio()} disabled={busy === 'vsdx'}>
              Diagram for Visio
            </button>
            <button type="button" onClick={exportDrawio}>
              Diagram for draw.io
            </button>
            <button type="button" onClick={exportHtml} title="One file that opens in any browser, offline: pan, zoom, search and device details">
              Interactive HTML page
            </button>
            <button type="button" onClick={() => void exportSheets()} disabled={busy === 'sheets'}>
              {sheetTiles().length > 1 ? `SVG sheets (${sheetTiles().length})` : 'SVG sheets'}
            </button>
            <div className="cv-dropdown-field" onClick={(e) => e.stopPropagation()}>
              <label>
                Page
                <select
                  className="cv-input"
                  value={settings.paper}
                  onChange={(e) => useStore.getState().setSettings({ paper: e.target.value })}
                >
                  {PAPERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {paper.width > 0 && (
                <label>
                  Way round
                  <select
                    className="cv-input"
                    value={settings.orientation}
                    onChange={(e) =>
                      useStore.getState().setSettings({
                        orientation: e.target.value as 'portrait' | 'landscape',
                      })
                    }
                  >
                    <option value="landscape">Landscape</option>
                    <option value="portrait">Portrait</option>
                  </select>
                </label>
              )}
              {/* Scaled to the paper, or 1:1. */}
              <label>
                Print scale
                <select
                  className="cv-input"
                  aria-label="Print scale"
                  value={settings.printScale}
                  onChange={(e) => useStore.getState().setSettings({ printScale: e.target.value === 'actual' ? 'actual' : 'fit' })}
                >
                  <option value="fit">Fit the paper</option>
                  <option value="actual">1:1 — the page's own size</option>
                </select>
              </label>
              <span className="cv-help">{pageNote}</span>
            </div>

            <button type="button" onClick={() => void printOnPaper()}>
              Print / save as PDF
            </button>
            <button type="button" onClick={exportCsv}>
              Events as CSV
            </button>
            <button
              type="button"
              onClick={exportTopologyCsv}
              title="Two files — devices and links — in the same columns the CSV import reads"
            >
              Devices and links as CSV
            </button>
            <button type="button" onClick={exportCableSchedule}>
              Cable schedule as CSV
            </button>
            {/* The rest of the project's tables. */}
            <button type="button" onClick={() => void runExport(`${slug(meta.name)}-ports.csv`, () => portsCsv(doc), 'text/csv')}>
              Ports as CSV
            </button>
            <button type="button" onClick={() => void runExport(`${slug(meta.name)}-vlans.csv`, () => vlansCsv(doc), 'text/csv')}>
              VLANs as CSV
            </button>
            <button type="button" onClick={() => void runExport(`${slug(meta.name)}-probe-results.csv`, () => probeResultsCsv(doc, runtime, recentSamples), 'text/csv')}>
              Probe results as CSV
            </button>
            {/* The address register. */}
            <button type="button" onClick={() => void runExport(`${slug(meta.name)}-addresses.csv`, () => ipamCsv(doc), 'text/csv')}>
              Addresses as CSV
            </button>
            {/* Devices, interfaces, addresses, cables and VLANs the
                way NetBox and Nautobot read them, which is also what the NetBox import
                reads back in. */}
            <button type="button" onClick={() => void runExport(`${slug(meta.name)}-netbox.json`, () => netboxJson(doc, meta), 'application/json')}>
              For NetBox (JSON)
            </button>
            <button type="button" onClick={() => void runExport(`${slug(meta.name)}-netbox.yaml`, () => netboxYaml(doc, meta), 'application/yaml')}>
              For NetBox (YAML)
            </button>
            <button type="button" onClick={exportReport}>
              Validation report (Markdown)
            </button>
            <button type="button" onClick={() => setReporting(true)}>
              Report as PDF…
            </button>
            <button type="button" onClick={() => void exportFolder()} title="project.coreview and a readable project.yaml, in a folder of their own — for Git. Never includes saved credentials.">
              Project as a folder (for version control)
            </button>
            <button type="button" onClick={() => void exportPackage(false)}>
              Project package (.coreview)
            </button>
            <button
              type="button"
              className="cv-menu-danger"
              title="Includes every saved credential, still encrypted. Whoever opens it needs your vault passphrase."
              onClick={() => void exportPackage(true)}
            >
              Project package with saved credentials
            </button>
          </div>
        </details>

        {/* The guide is in the app, not only in the repository. */}
        <button type="button" className="cv-btn cv-btn-help"
          title="How to use Coreview — the whole user guide, searchable"
          onClick={() => useStore.getState().setHelpOpen(true)}>
          {t('help.open')}
        </button>
        <details className="cv-dropdown cv-more">
          <summary className="cv-btn" title={t('topbar.more')} aria-label={t('topbar.more')}>⋯</summary>
          <div className="cv-dropdown-menu" onClick={(e) => { (e.currentTarget.parentElement as HTMLDetailsElement).open = false; }}>
            <button type="button" onClick={() => void useStore.getState().saveProject()}>Save <kbd>Ctrl+S</kbd></button>
            <button type="button" onClick={useStore.getState().undo}>Undo <kbd>Ctrl+Z</kbd></button>
            <button type="button" onClick={useStore.getState().redo}>Redo <kbd>Ctrl+Y</kbd></button>
            <button type="button" onClick={() => setAbout(true)}>About</button>
            <button
              type="button"
              onClick={() => {
                // Leave only when it closed — a failed save keeps it open
                // and the status line says why.
                void useStore.getState().closeProject().then(() => {
                  if (!useStore.getState().meta) onExit();
                });
              }}
            >
              Close project
            </button>
          </div>
        </details>
      </div>

      {about && <AboutDialog onClose={() => setAbout(false)} />}
      {reporting && (
        <ReportDialog pages={exportPages().length} busy={busy === 'report'} onMake={(t, sections) => void makeReport(t, sections)} onClose={() => setReporting(false)} />
      )}
    </header>
    </div>
  );
}

function statusCounts(): Record<HealthStatus, number> {
  const s = useStore.getState();
  const counts: Record<HealthStatus, number> = {
    unknown: 0,
    healthy: 0,
    warning: 0,
    down: 0,
    disabled: 0,
    maintenance: 0,
  };
  // Every page: these counts are monitoring, not a drawing.
  for (const n of allNodes(s.doc)) {
    if (n.type !== 'device') continue;
    counts[s.nodeStatus(n.id)] += 1;
  }
  return counts;
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null);
  useEffect(() => {
    void ipc.appInfo().then(setInfo);
  }, []);

  return (
    <div className="cv-modal-backdrop" onClick={onClose} role="presentation">
      <div className="cv-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="About Coreview">
        <h2>About Coreview</h2>
        <p className="cv-mono cv-help">
          Version {info?.version ?? '…'} · built {__BUILT_ON__}
        </p>
        <h3>Author</h3>
        <p>
          Mohammed Almoola ·{' '}
          <a href="https://www.linkedin.com/in/malmoola" target="_blank" rel="noreferrer noopener">
            linkedin.com/in/malmoola
          </a>
        </p>
        <h3>Licence</h3>
        <p>
          <strong>Coreview is free.</strong> Use it for anything lawful, at work or at home, on as
          many machines as you like. No licence key, no activation, no registration. What you make
          with it is yours.
        </p>
        <p>
          <strong>Pass it on.</strong> Give the installer to whoever you like — unchanged, with its
          licence and notices, and never for a fee.
        </p>
        <p className="cv-help">
          Not to be sold, modified, rebranded or reverse engineered without written permission.
          © 2026 Mohammed Almoola. All rights reserved. The full terms are in LICENSE.txt, beside
          the application.
        </p>
        <h3>Open-source components</h3>
        <p className="cv-help">
          Coreview is built on open-source components that keep their own licences, reproduced in
          full in <code>THIRD-PARTY-NOTICES.md</code>, which is installed beside the application.
          None of them is under a licence that restricts how Coreview itself may be used.
        </p>
        <h3>Where your data lives</h3>
        <p className="cv-mono cv-help">{info?.dataDir ?? '…'}</p>
        <h3>Privacy</h3>
        <p>
          Diagrams, notes, probe configuration and results stay on this machine. Coreview has no
          account, no cloud sync and no telemetry. It never contacts a server of its own. The one
          request it can make that you did not point at your own network is a check for a newer
          release on GitHub, and only when you press the button under Tools → Settings or switch
          on the automatic check there, which is off until you do.
        </p>
        <h3>What a green link actually means</h3>
        <p>
          Every check runs from this machine. A passing check proves this host reached the
          configured target with the configured method at that moment. It does not prove that each
          drawn line in the path is healthy, and it does not prove end-to-end application traffic.
          Each link shows status according to the health rule you selected for it.
        </p>
        <button type="button" className="cv-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
