import { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';

import { useStore } from '../state/store';
import { ipc } from '../lib/ipc';
import { buildMarkdownReport, saveExport, slug, svgToPng } from '../lib/exports';
import { cableSchedule, cableScheduleCsv } from '../lib/cableSchedule';
import { CanvasFilterMenu } from './CanvasFilterMenu';
import { renderDiagramSvg } from '../lib/diagram';
import { allPrinted, isPrinted, layersOf } from '../lib/layers';
import { effectivePage } from '../lib/pageRect';
import { PAPERS, describePage, paperById, sheetSize, sheetsFor, tileRects } from '../lib/paper';
import { TIME_FORMATS, isLocalFormat, zoneLabel, type TimeFormat } from '../lib/timeFormat';
import { eventsToCsv, linksToCsv, nodesToCsv } from '../lib/csv';
import type { DeviceNodeData, HealthStatus, LinkData, NodeAddress } from '../types/domain';
import { STATUS_LABEL } from '../types/domain';
import { activePage, allEdges, allNodes } from '../lib/pages';
import { drawioFile } from '../lib/drawio';
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
  const session = useStore((s) => s.session);
  const settings = useStore((s) => s.settings);
  const store = useStore();
  const rf = useReactFlow();
  const exportMenu = useRef<HTMLDetailsElement>(null);
  const [about, setAbout] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // LT-170: replace imported stencils with built-in shapes in what is exported.
  const gridSnap = useStore((s) => Boolean(s.doc.gridSnap));
  const [vendorSafe, setVendorSafe] = useState(false);
  // LT-194: greys on white, for paper.
  const [printFriendly, setPrintFriendly] = useState(false);
  // LT-251: whether drawing exports cover the page in view or every page.
  const [pageScope, setPageScope] = useState<'page' | 'all'>('page');
  // LT-256: the report dialog.
  const [reporting, setReporting] = useState(false);

  // Autosave. Runs only while a project is open and unsaved edits exist.
  useEffect(() => {
    if (!meta || !dirty) return;
    const t = setTimeout(() => void store.saveProject(), 2500);
    return () => clearTimeout(t);
  }, [meta, dirty, store]);

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
  // the paper an export is sized to, a different thing from a Pages (LT-094)
  // ProjectPage, and the two must not be confused inside this one file.
  const pg = activePage(store.doc);
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

  /** A page as it prints: hidden views and views set not to print (LT-184)
   *  left out. The active page is what is being looked at; LT-251 exports
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
  /** LT-251: the pages a drawing export covers. */
  const exportPages = () => (pageScope === 'all' ? store.doc.pages : [pg]);
  /** A file name for one page of several. */
  const pageFile = (page: ProjectPage, ext: string) =>
    exportPages().length > 1 ? `${slug(meta.name)}-${slug(page.name) || 'page'}.${ext}` : `${slug(meta.name)}-diagram.${ext}`;

  // LT-170: what the project holds of other people's artwork. Every page: a
  // package carries them all.
  const artwork = artworkSummary(allNodes(store.doc));
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
      const path = await saveExport(filename, content, mime, store.settings.exportFolder);
      const warn =
        path && carriesArtwork && artwork.devices > 0 && !vendorSafe
          ? ' — it includes artwork from imported stencils; check you may share it, or use a vendor-safe export'
          : '';
      store.setStatusMessage(path ? `Saved ${path}${warn}` : null);
    } catch (err) {
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
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
      nodeStatus: (id) => store.nodeStatus(id),
      linkStatus: (id) => store.linkStatus(id),
      includeTitleBlock: true,
      nodeStyle: page.canvas.nodeStyle ?? 'glyph',
      lineJumps: page.canvas.lineJumps ?? true,
      glyphVariant: page.canvas.glyphVariant ?? 'outline',
      ink: page.canvas.inkHidden ? [] : page.canvas.ink,
      print: printFriendly,
      // What you are looking at is what comes out. Exporting dark from a
      // white screen put a black rectangle in the middle of a white page.
      ground: settings.ground,
      // LT-254: a page on screen has no paper, and its devices can be clicked.
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

  /** LT-251: one file per page when every page is asked for — each through
   *  the save dialog unless an export folder is set. */
  const exportSvg = async () => {
    for (const page of exportPages()) {
      await runExport(pageFile(page, 'svg'), () => svgFor(page), 'image/svg+xml', true);
    }
  };

  // LT-028: how many sheets the diagram spans at full size on the chosen paper.
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

  /** One SVG per sheet, each a full-size slice of the diagram (LT-028). Needs
   *  an export folder so the files land somewhere without one dialog per
   *  sheet; when none is set, the single-sheet SVG is written instead. */
  const exportSheets = async () => {
    const tiles = sheetTiles();
    if (tiles.length <= 1 || !store.settings.exportFolder) {
      exportSvg();
      if (tiles.length > 1) {
        store.setStatusMessage('Set an export folder to write one file per sheet.');
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
          nodeStatus: (id) => store.nodeStatus(id),
          linkStatus: (id) => store.linkStatus(id),
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
          store.settings.exportFolder,
        );
      }
      store.setStatusMessage(last ? `Saved ${tiles.length} sheets to ${store.settings.exportFolder}` : null);
    } catch (err) {
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** LT-077: the same drawing the screen and the SVG export use, as a
   *  vector PDF — the format a change record or an approval wants. */
  const exportPdf = async () => {
    setBusy('pdf');
    try {
      // LT-251: every page asked for goes into one PDF, a page each.
      const pages = exportPages();
      const bytes = pages.length > 1 ? await ipc.diagramPdfPages(pages.map((p) => svgFor(p))) : await ipc.diagramPdf(svgFor(pg));
      await runExport(`${slug(meta.name)}-diagram.pdf`, () => bytes, 'application/pdf', true);
    } catch (err) {
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** LT-078: the drawing as Visio shapes and connectors — what a colleague
   *  who does not have Coreview can actually open and edit. */
  const exportVisio = async () => {
    setBusy('vsdx');
    try {
      // LT-249: every page asked for, each with its links' bends.
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
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
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
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** LT-256, LT-257: a PDF report from a template. Changes compare the last
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
            const p = store.doc.probes.find((x) => x.id === id);
            const owner = p ? (allNodes(store.doc).find((n) => n.id === p.objectId)?.data as DeviceNodeData | undefined)?.label : undefined;
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
          meta, doc: store.doc, template, sections, generatedAt: new Date(),
          runtime: store.runtime, samples: store.recentSamples, events: store.events,
          nodeStatus: (id) => store.nodeStatus(id),
          typeLabel: (t) => DEVICE_LABEL[t as keyof typeof DEVICE_LABEL] ?? t,
          diagrams: sections.includes('diagrams') ? exportPages().map((page) => ({ name: page.name, svg: svgFor(page) })) : [],
          diffs,
        }),
      );
      const bytes = await ipc.diagramPdfPages(svgs);
      await runExport(`${slug(meta.name)}-${template.id}-report.pdf`, () => bytes, 'application/pdf', sections.includes('diagrams'));
      store.noteGuide('report');
      setReporting(false);
    } catch (err) {
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** LT-254: the pages asked for as one HTML file that works offline. */
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
                  status: STATUS_LABEL[store.nodeStatus(n.id)],
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

  /** LT-250: the pages asked for as one draw.io file. */
  const exportDrawio = () => {
    void runExport(
      `${slug(meta.name)}-diagram.drawio`,
      () => drawioFile(exportPages().map((page) => ({ name: page.name, nodes: exportNodesOf(page), edges: printedOf(page).edges }))),
      'application/vnd.jgraph.mxfile',
      true,
    );
  };

  const exportCsv = () => {
    void runExport(`${slug(meta.name)}-events.csv`, () => eventsToCsv(store.events), 'text/csv');
  };

  /** The diagram as the two files the importer reads back. Every page
   *  (LT-094): this is an inventory, not a drawing, and a device missing
   *  from it because the wrong tab was open would be a real surprise. */
  /** LT-198: every cable between devices, on every page. */
  const exportCableSchedule = () => {
    const rows = cableSchedule(store.doc);
    if (rows.length === 0) {
      store.setStatusMessage('There are no links between devices to list.');
      return;
    }
    void runExport(`${slug(meta.name)}-cable-schedule.csv`, () => cableScheduleCsv(rows), 'text/csv');
  };

  const exportTopologyCsv = () => {
    const devices = allNodes(store.doc).filter((n) => n.type === 'device');
    const nameOf = new Map(
      devices.map((n) => [n.id, String((n.data as DeviceNodeData).label ?? '')]),
    );
    const probeFor = (nodeId: string) =>
      store.doc.probes.find((p) => p.objectKind === 'node' && p.objectId === nodeId);

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
        // LT-147: everything discovery learned, not only what the importer
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
        // LT-148: a stack profiles like anything else.
        stackKind: d.stackKind,
        stackMembers: d.stackMembers,
      };
    });
    void runExport(`${slug(meta.name)}-devices.csv`, () => nodesToCsv(rows), 'text/csv');

    // Links reference devices by name, because that is what the importer
    // matches on and what a person reading the file can follow.
    const links = allEdges(store.doc)
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
    style.textContent =
      paper.width === 0
        ? '@page { margin: 10mm; }'
        : `@page { size: ${paper.name} ${settings.orientation}; margin: 10mm; }`;
    document.head.appendChild(style);

    const was = settings.ground;
    if (was !== 'light') store.setSettings({ ground: 'light' });
    // LT-184: views set not to print come off the canvas for the print job.
    store.setPrinting(true);
    // Two frames: one for React to render the new ground, one for the
    // browser to paint it. Printing before the paint captures the old one.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      window.print();
    } finally {
      store.setPrinting(false);
      if (was !== 'light') store.setSettings({ ground: was });
      style.remove();
    }
  };

  const exportReport = () => {
    const md = buildMarkdownReport({
      meta,
      events: store.events,
      counts,
      // Every page (LT-094): a validation report is a record, not a drawing.
      nodeCount: allNodes(store.doc).filter((n) => n.type === 'device').length,
      linkCount: allEdges(store.doc).length,
      sessionStart: session.startedAt,
      sessionEnd: session.state === 'stopped' ? Date.now() : null,
      cables: cableSchedule(store.doc),
      // LT-253: the pages asked for, drawn into the report.
      diagrams: exportPages().map((page) => ({ name: page.name, svg: svgFor(page) })),
    });
    void runExport(`${slug(meta.name)}-report.md`, () => md, 'text/markdown');
  };

  /** LT-255: the project as a folder of JSON and YAML, for version control. */
  const exportFolder = async () => {
    try {
      const folder = store.settings.exportFolder || (await ipc.pickFolder('Where should the project folder go?'));
      if (!folder) return;
      // What is on screen, not what was last saved.
      if (store.dirty) await store.saveProject();
      const pkg = await ipc.loadProject(meta.id);
      if (!pkg) return;
      const project = vendorSafe ? { ...pkg, document: vendorSafeDocument(pkg.document) } : pkg;
      const { json, yaml } = projectFolderFiles(project as unknown as Record<string, unknown>);
      const dir = await ipc.saveProjectFolder(folder, slug(meta.name) || 'project', json, yaml);
      store.setStatusMessage(`Saved ${dir} — project.coreview opens in Coreview; project.yaml is the readable copy`);
    } catch (err) {
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const exportPackage = async (withCredentials = false) => {
    const pkg = await ipc.loadProject(meta.id);
    if (!pkg) return;
    // Credentials are app-wide rather than part of a project, so they are
    // never in an export unless asked for. A project package is the thing
    // people send to each other, and quietly including every saved password
    // in it is how they escape.
    // LT-170: a vendor-safe package holds no imported artwork on any page.
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
          <button type="button" className="cv-btn cv-btn-small" onClick={() => store.restoreRecovery()}>
            Restore it
          </button>
          <button type="button" className="cv-btn cv-btn-small" onClick={() => store.discardRecovery()}>
            Keep what was saved
          </button>
        </div>
      )}
    <header className="cv-topbar">
      <div className="cv-topbar-left">
        {/* LT-309: the mark, drawn rather than imported, beside the name. */}
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
        <span className={`cv-save-state ${dirty ? 'is-dirty' : ''}`}>
          {dirty
            ? 'Unsaved changes'
            : lastSavedAt
              ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}`
              : 'Saved'}
        </span>
      </div>

      <div className="cv-topbar-actions">
        <button type="button" className="cv-btn" onClick={() => void store.saveProject()}>
          Save
        </button>
        <button type="button" className="cv-btn" onClick={store.undo} title="Ctrl+Z">
          Undo
        </button>
        <button type="button" className="cv-btn" onClick={store.redo} title="Ctrl+Y">
          Redo
        </button>
        <button
          type="button"
          className="cv-btn"
          /* Fits the sheet, not only what is on it: fitting to the devices
             alone puts the page edge off-screen, and the edge is the thing
             that says where the drawing surface is. */
          onClick={() =>
            (pg.canvas.sheet ?? true)
              ? (() => {
                  const sheet = effectivePage(pg.canvas.sheetRect, pg.nodes);
                  rf.fitBounds({ x: sheet.x, y: sheet.y, width: sheet.w, height: sheet.h }, { padding: 0.08 });
                  if (rf.getZoom() > 2) rf.zoomTo(2);
                })()
              : rf.fitView({ padding: 0.2, maxZoom: 2 })
          }
        >
          Fit view
        </button>

        <div className="cv-divider" />

        {session.state === 'running' || session.state === 'stopping' ? (
          <button
            type="button"
            className="cv-btn cv-btn-stop"
            onClick={() => void store.stopValidation()}
          >
            Stop validation
          </button>
        ) : (
          <button
            type="button"
            className="cv-btn cv-btn-start"
            onClick={() => void store.startValidation()}
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

        <div className="cv-divider" />

        {/* LT-300: the register is the second job this app does, so it is a
            place to go rather than a panel about the diagram. */}
        <button type="button" className="cv-btn cv-btn-register"
          title="Subnets, addresses, ranges and the planning tools, on a screen of their own"
          onClick={() => store.setRegisterOpen(true)}>
          {t('register.open')}
        </button>

        {/* LT-232. */}
        <CanvasFilterMenu />

        <details className="cv-dropdown" ref={exportMenu}>
          <summary className="cv-btn">Export</summary>
          <div
            className="cv-dropdown-menu"
            onClick={() => {
              if (exportMenu.current) exportMenu.current.open = false;
            }}
          >
            {/* LT-170 / D-028: the operator is responsible for imported artwork
                leaving the organisation, so the menu says it is there. */}
            {artwork.devices > 0 && (
              <div className="cv-dropdown-field cv-export-artwork" onClick={(e) => e.stopPropagation()}>
                <p className="cv-help" role="note">
                  ⚠ {artwork.devices} device{artwork.devices === 1 ? ' uses' : 's use'} imported stencils —
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
            {store.doc.pages.length > 1 && (
              <label className="cv-dropdown-field" onClick={(e) => e.stopPropagation()}>
                Pages
                <select className="cv-input" aria-label="Pages to export" value={pageScope} onChange={(e) => setPageScope(e.target.value as 'page' | 'all')}>
                  <option value="page">This page</option>
                  <option value="all">All {store.doc.pages.length} pages</option>
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
                  onChange={(e) => store.setSettings({ paper: e.target.value })}
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
                      store.setSettings({
                        orientation: e.target.value as 'portrait' | 'landscape',
                      })
                    }
                  >
                    <option value="landscape">Landscape</option>
                    <option value="portrait">Portrait</option>
                  </select>
                </label>
              )}
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
            {/* LT-252: the rest of the project's tables. */}
            <button type="button" onClick={() => void runExport(`${slug(meta.name)}-ports.csv`, () => portsCsv(store.doc), 'text/csv')}>
              Ports as CSV
            </button>
            <button type="button" onClick={() => void runExport(`${slug(meta.name)}-vlans.csv`, () => vlansCsv(store.doc), 'text/csv')}>
              VLANs as CSV
            </button>
            <button type="button" onClick={() => void runExport(`${slug(meta.name)}-probe-results.csv`, () => probeResultsCsv(store.doc, store.runtime, store.recentSamples), 'text/csv')}>
              Probe results as CSV
            </button>
            {/* LT-285: the address register. */}
            <button type="button" onClick={() => void runExport(`${slug(meta.name)}-addresses.csv`, () => ipamCsv(store.doc), 'text/csv')}>
              Addresses as CSV
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

        {/* LT-175: whether dragging snaps to the grid, always in sight. */}
        <button
          type="button"
          className={`cv-btn${gridSnap ? ' is-active' : ''}`}
          aria-pressed={gridSnap}
          title="Snap dragged objects to the grid where no alignment guide applies (Ctrl+Shift+G; Alt while dragging does the opposite)"
          onClick={() => store.setGridSnap(!gridSnap)}
        >
          Grid snap {gridSnap ? 'on' : 'off'}
        </button>
        <button
          type="button"
          className="cv-btn"
          title="Draw on white — for a document, a projector, or daylight. Every colour is chosen against the ground it is on, not inverted."
          onClick={() =>
            store.setSettings({ ground: settings.ground === 'light' ? 'dark' : 'light' })
          }
        >
          {settings.ground === 'light' ? 'Dark background' : 'White background'}
        </button>

        <label className="cv-check cv-check-inline" title="The overview box, bottom-right">
          <input
            type="checkbox"
            checked={settings.minimap}
            onChange={(e) => store.setSettings({ minimap: e.target.checked })}
          />
          Overview
        </label>

        <label className="cv-check cv-check-inline" title="Stops all packet-dot animation">
          <input
            type="checkbox"
            checked={settings.reduceMotion}
            onChange={(e) => store.setSettings({ reduceMotion: e.target.checked })}
          />
          Reduce motion
        </label>
        {/* LT-242. */}
        <label className="cv-check cv-check-inline" title="Stronger lines and text, and a clear focus ring">
          <input
            type="checkbox"
            checked={settings.highContrast}
            onChange={(e) => store.setSettings({ highContrast: e.target.checked })}
          />
          High contrast
        </label>

        {/* LT-076: how every timestamp is written. DTG is what an operator
            reads at a glance; a plain clock is what everyone else does. The
            zone is named in the tooltip so nobody has to guess. */}
        <label
          className="cv-check cv-check-inline"
          title={`Times shown in ${
            isLocalFormat(settings.timeFormat) ? zoneLabel() : 'Zulu (UTC)'
          }`}
        >
          Times
          <select
            className="cv-input cv-input-inline"
            value={settings.timeFormat}
            onChange={(e) => store.setSettings({ timeFormat: e.target.value as TimeFormat })}
          >
            {TIME_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        {/* LT-303: the guide is in the app, not only in the repository. */}
        <button type="button" className="cv-btn cv-btn-help"
          title="How to use Coreview — the whole user guide, searchable"
          onClick={() => store.setHelpOpen(true)}>
          {t('help.open')}
        </button>
        <button type="button" className="cv-btn" onClick={() => setAbout(true)}>
          About
        </button>
        <button
          type="button"
          className="cv-btn"
          onClick={() => {
            void store.closeProject().then(onExit);
          }}
        >
          Close project
        </button>
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
  // Every page (LT-094): these counts are monitoring, not a drawing.
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
          account, no cloud sync and no telemetry. It never contacts a server of its own.
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
