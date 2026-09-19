import { useMemo, useState } from 'react';

import { useStore, type TopoEdge } from '../state/store';
import { ipc, isDesktop } from '../lib/ipc';
import { parseCsv, type LinkCsvRow, type NodeCsvRow } from '../lib/csv';
import { fieldsFor, guessKind, guessMapping, headerRowOf, mapRows, type ColumnMapping, type ImportKind } from '../lib/columnMap';
import { readNetbox, type NetboxImport } from '../lib/netbox';
import { makeDeviceNode } from './Canvas';
import { newProbe } from '../lib/probes';
import { uid } from '../lib/id';
import { DEVICE_LABEL } from './icons';
import type { DeviceNodeData, DeviceType, LinkData } from '../types/domain';
import { activePage } from '../lib/pages';

/** Matches a `type` value to a device glyph, by label or by id. */
function deviceType(raw: string): DeviceType {
  const want = raw.trim().toLowerCase().replace(/[\s_]/g, '-');
  const ids = Object.keys(DEVICE_LABEL) as DeviceType[];
  return (
    ids.find((id) => id === want) ??
    ids.find((id) => DEVICE_LABEL[id].toLowerCase() === raw.trim().toLowerCase()) ??
    'generic'
  );
}

type Loaded =
  | { kind: 'grid'; source: string; sheets: { name: string; rows: string[][] }[]; sheet: number; headerRow: number; as: ImportKind; mapping: ColumnMapping }
  | { kind: 'netbox'; source: string; found: NetboxImport };

const extension = (path: string) => (path.split(/[\\/]/).pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Building a diagram from a file somebody already has (LT-245, LT-247).
 *
 * Most people arrive with an inventory before they arrive with a network they
 * can crawl — a rack list, an IPAM export, a handover document. A CSV or a
 * workbook is read into a grid and every column is matched to a field, with
 * the guess shown and changeable before anything is added. A NetBox export
 * carries its own structure, so it goes straight to devices and cables.
 */
export function CsvImportPanel() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const withSheet = (source: string, sheets: { name: string; rows: string[][] }[], sheet = 0): Loaded => {
    const rows = sheets[sheet]?.rows ?? [];
    const headerRow = headerRowOf(rows);
    const as = guessKind(rows[headerRow] ?? []);
    return { kind: 'grid', source, sheets, sheet, headerRow, as, mapping: guessMapping(rows[headerRow] ?? [], as) };
  };

  const read = async () => {
    setProblem(null);
    setDone(null);
    try {
      const path = await ipc.pickImportFile();
      if (!path) return;
      const ext = extension(path);
      if (ext === 'xlsx' || ext === 'xlsm') {
        const sheets = (await ipc.readSpreadsheet(path)).filter((s) => s.rows.length > 0);
        if (!sheets.length) throw new Error(`${fileName(path)} has no rows on any sheet.`);
        setLoaded(withSheet(path, sheets));
      } else if (ext === 'json' || ext === 'yaml' || ext === 'yml') {
        setLoaded({ kind: 'netbox', source: path, found: readNetbox(await ipc.readImport(path)) });
      } else {
        setLoaded(withSheet(path, [{ name: fileName(path), rows: parseCsv(await ipc.readImport(path)) }]));
      }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  const mapped = useMemo(() => {
    if (loaded?.kind !== 'grid') return null;
    return mapRows(loaded.sheets[loaded.sheet]?.rows ?? [], loaded.mapping, loaded.as, loaded.headerRow);
  }, [loaded]);

  const addNodes = (rows: NodeCsvRow[]) => {
    const store = useStore.getState();
    const bottom = activePage(store.doc).nodes.reduce((m, n) => Math.max(m, n.position.y + 120), 0);
    rows.forEach((r, i) => {
      const node = makeDeviceNode(deviceType(r.type), 80 + (i % 6) * 230, bottom + 80 + Math.floor(i / 6) * 140);
      const d = node.data as DeviceNodeData;
      d.label = r.name;
      d.tags = r.tags;
      if (r.notes) d.notes = r.notes;
      if (r.vendor) d.vendor = r.vendor;
      if (r.model) d.model = r.model;
      if (r.serial) d.serial = r.serial;
      if (r.assetTag) d.assetTag = r.assetTag;
      if (r.role) d.role = r.role;
      if (r.site) d.site = r.site;
      if (r.rack) d.rack = r.rack;
      if (r.rackU !== undefined && r.rack) d.rackU = r.rackU;
      if (r.address) {
        d.addresses = [{ id: uid(), label: 'Imported', address: r.address, isPrimary: true }];
      }
      store.addNode(node);
      // An address in the sheet is there to be watched; a row without one is a
      // box on the diagram and nothing more, so it gets no probe.
      if (r.address && store.meta) {
        const probe = newProbe('node', node.id, store.meta.id, r.address, 'Imported');
        probe.kind = r.probeType;
        if (r.probeType === 'tcp') probe.tcpPort = r.port ?? 443;
        store.upsertProbe(probe);
      }
    });
    return `Added ${rows.length} device${rows.length === 1 ? '' : 's'}.`;
  };

  const addLinks = (rows: LinkCsvRow[]) => {
    const store = useStore.getState();
    // Names, because a spreadsheet has no way to know the ids this app
    // generates. Matched case-insensitively: a sheet and a diagram rarely
    // agree on capitalisation. Read fresh, so devices added a moment ago by
    // the same import are there.
    const byName = new Map(
      activePage(store.doc)
        .nodes.filter((n) => n.type === 'device')
        .map((n) => [String((n.data as DeviceNodeData).label).trim().toLowerCase(), n.id]),
    );
    let added = 0;
    const missing: string[] = [];
    for (const r of rows) {
      const s = byName.get(r.source.trim().toLowerCase());
      const t = byName.get(r.target.trim().toLowerCase());
      if (!s || !t) {
        missing.push(!s ? r.source : r.target);
        continue;
      }
      // Style is left to the document's default (LT-130) — an imported link
      // should look like a link drawn here, not like whatever this importer
      // happened to hardcode.
      const data: Partial<LinkData> = {
        sourcePortLabel: r.sourcePort,
        targetPortLabel: r.targetPort,
        label: r.label,
        enabled: true,
        maintenance: false,
        healthRule: { type: r.healthRule },
      };
      store.addEdge({ id: uid(), source: s, target: t, sourceHandle: 'b', targetHandle: 't', type: 'live', data } as TopoEdge);
      added += 1;
    }
    const unmatched = [...new Set(missing)];
    return (
      `Added ${added} link${added === 1 ? '' : 's'}.` +
      (unmatched.length
        ? ` ${unmatched.length} skipped — no device on the diagram called ${unmatched.slice(0, 3).map((n) => `"${n}"`).join(', ')}${unmatched.length > 3 ? '…' : ''}.`
        : '')
    );
  };

  const apply = () => {
    if (!loaded) return;
    if (loaded.kind === 'netbox') {
      setDone([addNodes(loaded.found.devices), loaded.found.links.length ? addLinks(loaded.found.links) : ''].filter(Boolean).join(' '));
    } else if (mapped) {
      setDone(mapped.kind === 'devices' ? addNodes(mapped.rows) : addLinks(mapped.rows));
    }
    setLoaded(null);
  };

  if (!isDesktop) {
    return <p className="cv-help cv-discover-empty">Reading a file needs the desktop app.</p>;
  }

  const header = loaded?.kind === 'grid' ? (loaded.sheets[loaded.sheet]?.rows[loaded.headerRow] ?? []) : [];
  const missingRequired = loaded?.kind === 'grid' ? fieldsFor(loaded.as).filter((f) => f.required && loaded.mapping[f.key] == null) : [];
  const count = loaded?.kind === 'netbox' ? loaded.found.devices.length + loaded.found.links.length : (mapped?.rows.length ?? 0);

  return (
    <div className="cv-discover">
      <div className="cv-discover-form">
        <button type="button" className="cv-btn cv-btn-start" onClick={() => void read()}>
          Choose a file
        </button>
        <span className="cv-help">
          A device or link list as CSV or an Excel workbook — you choose which column is which — or a NetBox
          export of devices and cables, as JSON or YAML. Links are matched to devices by name.
        </span>
      </div>

      {problem && <p className="cv-discover-problem">{problem}</p>}
      {done && <p className="cv-help" role="status">{done}</p>}

      {loaded?.kind === 'grid' && (
        <section className="cv-import-map" aria-label="Match the columns">
          <p className="cv-help">{fileName(loaded.source)}</p>
          <div className="cv-import-map-head">
            {loaded.sheets.length > 1 && (
              <label className="cv-field cv-field-narrow">
                <span>Sheet</span>
                <select className="cv-input" value={loaded.sheet} onChange={(e) => setLoaded(withSheet(loaded.source, loaded.sheets, Number(e.target.value)))}>
                  {loaded.sheets.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
                </select>
              </label>
            )}
            <label className="cv-field cv-field-narrow">
              <span>Header row</span>
              <input className="cv-input" type="number" min={1} max={Math.max(1, (loaded.sheets[loaded.sheet]?.rows.length ?? 1))} value={loaded.headerRow + 1}
                onChange={(e) => {
                  const headerRow = Math.max(0, Number(e.target.value) - 1);
                  const h = loaded.sheets[loaded.sheet]?.rows[headerRow] ?? [];
                  setLoaded({ ...loaded, headerRow, mapping: guessMapping(h, loaded.as) });
                }} />
            </label>
            <fieldset className="cv-import-kind">
              <legend>Each row is</legend>
              {(['devices', 'links'] as const).map((k) => (
                <label key={k} className="cv-check cv-check-inline">
                  <input type="radio" name="cv-import-kind" checked={loaded.as === k} onChange={() => setLoaded({ ...loaded, as: k, mapping: guessMapping(header, k) })} />
                  {k === 'devices' ? 'a device' : 'a link'}
                </label>
              ))}
            </fieldset>
          </div>
          <div className="cv-import-fields">
            {fieldsFor(loaded.as).map((f) => (
              <label key={f.key} className="cv-field cv-field-narrow">
                <span>{f.label}{f.required ? ' *' : ''}</span>
                <select className="cv-input" aria-label={`Column for ${f.label}`} value={loaded.mapping[f.key] ?? ''}
                  onChange={(e) => setLoaded({ ...loaded, mapping: { ...loaded.mapping, [f.key]: e.target.value === '' ? null : Number(e.target.value) } })}>
                  <option value="">— not in this file —</option>
                  {header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </label>
            ))}
          </div>
          {missingRequired.length > 0 && (
            <p className="cv-discover-problem">Choose a column for {missingRequired.map((f) => f.label.toLowerCase()).join(' and ')}.</p>
          )}
        </section>
      )}

      {loaded?.kind === 'netbox' && (
        <p className="cv-help">
          {fileName(loaded.source)} — {loaded.found.devices.length} device{loaded.found.devices.length === 1 ? '' : 's'} and{' '}
          {loaded.found.links.length} cable{loaded.found.links.length === 1 ? '' : 's'} from NetBox
        </p>
      )}

      {loaded && (
        <>
          {(() => {
            const errors = loaded.kind === 'netbox' ? loaded.found.problems : (mapped?.errors ?? []);
            return errors.length > 0 && (
              <details className="cv-discover-failures">
                <summary>{errors.length} row{errors.length === 1 ? '' : 's'} could not be used</summary>
                <ul>{errors.slice(0, 20).map((e) => <li key={e}>{e}</li>)}</ul>
              </details>
            );
          })()}

          <div className="cv-discover-actions">
            <button type="button" className="cv-btn cv-btn-start" onClick={apply} disabled={count === 0 || missingRequired.length > 0}>
              Add {count} to diagram
            </button>
            <button type="button" className="cv-btn" onClick={() => setLoaded(null)}>Cancel</button>
          </div>

          {loaded.kind === 'netbox' || mapped?.kind === 'devices' ? (
            <table className="cv-table cv-discover-table">
              <thead>
                <tr><th>Name</th><th>Type</th><th>Address</th><th>Model</th><th>Site / rack</th><th>Tags</th></tr>
              </thead>
              <tbody>
                {(loaded.kind === 'netbox' ? loaded.found.devices : (mapped?.rows as NodeCsvRow[])).slice(0, 200).map((r, i) => (
                  <tr key={`${r.name}-${i}`}>
                    <td>{r.name}</td>
                    <td>{DEVICE_LABEL[deviceType(r.type)]}</td>
                    <td className="cv-mono">{r.address || '—'}</td>
                    <td>{[r.vendor, r.model].filter(Boolean).join(' ') || '—'}</td>
                    <td>{[r.site, r.rack, r.rackU !== undefined ? `U${r.rackU}` : ''].filter(Boolean).join(' / ') || '—'}</td>
                    <td>{r.tags.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {(loaded.kind === 'netbox' ? loaded.found.links : mapped?.kind === 'links' ? mapped.rows : []).length > 0 && (
            <table className="cv-table cv-discover-table">
              <thead>
                <tr><th>Source</th><th>Target</th><th>Ports</th><th>Label</th><th>Health rule</th></tr>
              </thead>
              <tbody>
                {(loaded.kind === 'netbox' ? loaded.found.links : (mapped?.rows as LinkCsvRow[])).slice(0, 200).map((r, i) => (
                  <tr key={`${r.source}-${r.target}-${i}`}>
                    <td>{r.source}</td>
                    <td>{r.target}</td>
                    <td className="cv-mono">{r.sourcePort || '—'} / {r.targetPort || '—'}</td>
                    <td>{r.label || '—'}</td>
                    <td>{r.healthRule}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
