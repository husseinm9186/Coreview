/**
 * Which spreadsheet column is which (LT-245).
 *
 * Every inventory names its columns differently — `Hostname`, `Device`,
 * `Mgmt IP`, `Serial No` — and the CSV importer used to accept only its own
 * spellings. This guesses a mapping from the header, shows it, and lets the
 * person correct it before anything is added. The same mapping reads a CSV
 * and every sheet of a workbook, because both arrive here as a grid of text.
 */
import type { LinkCsvRow, NodeCsvRow } from './csv';
import type { LinkHealthRuleType, ProbeKind } from '../types/domain';

export type ImportKind = 'devices' | 'links';

export interface ImportField {
  key: string;
  label: string;
  required?: boolean;
  /** Header spellings, normalised (lower case, no spaces, dashes or
   *  underscores), best first. */
  aliases: string[];
}

export const DEVICE_FIELDS: ImportField[] = [
  { key: 'name', label: 'Name', required: true, aliases: ['name', 'devicename', 'device', 'hostname', 'host', 'label'] },
  { key: 'address', label: 'Address', aliases: ['ip', 'ipaddress', 'mgmtip', 'managementip', 'managementaddress', 'primaryip', 'primaryipv4', 'address', 'iphostname', 'hostname', 'fqdn'] },
  { key: 'type', label: 'Type', aliases: ['type', 'devicetype', 'kind', 'shape', 'class'] },
  { key: 'role', label: 'Role', aliases: ['role', 'devicerole', 'function'] },
  { key: 'vendor', label: 'Vendor', aliases: ['vendor', 'manufacturer', 'make', 'brand'] },
  { key: 'model', label: 'Model', aliases: ['model', 'platform', 'hardware', 'modelnumber', 'pid'] },
  { key: 'serial', label: 'Serial number', aliases: ['serialnumber', 'serial', 'serialno', 'sn', 's/n'] },
  { key: 'assetTag', label: 'Asset tag', aliases: ['assettag', 'asset', 'assetno', 'assetnumber'] },
  { key: 'site', label: 'Site', aliases: ['site', 'location', 'building', 'campus'] },
  { key: 'rack', label: 'Rack', aliases: ['rack', 'cabinet'] },
  { key: 'tags', label: 'Tags', aliases: ['tags', 'tag', 'labels', 'groups'] },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'comments', 'comment', 'description'] },
  { key: 'probeType', label: 'Probe type', aliases: ['probetype', 'check', 'checktype'] },
  { key: 'port', label: 'Probe port', aliases: ['port', 'tcpport', 'probeport'] },
];

export const LINK_FIELDS: ImportField[] = [
  { key: 'source', label: 'Source device', required: true, aliases: ['sourcename', 'source', 'from', 'adevice', 'devicea', 'sidea', 'local', 'localdevice'] },
  { key: 'target', label: 'Target device', required: true, aliases: ['targetname', 'target', 'to', 'bdevice', 'deviceb', 'sideb', 'remote', 'remotedevice', 'neighbour', 'neighbor'] },
  { key: 'sourcePort', label: 'Source port', aliases: ['sourceport', 'fromport', 'aport', 'porta', 'localport', 'localinterface', 'interface'] },
  { key: 'targetPort', label: 'Target port', aliases: ['targetport', 'toport', 'bport', 'portb', 'remoteport', 'remoteinterface'] },
  { key: 'label', label: 'Label', aliases: ['linklabel', 'label', 'cable', 'cableid', 'circuit', 'description'] },
  { key: 'healthRule', label: 'Health rule', aliases: ['healthrule', 'rule'] },
];

export type ColumnMapping = Record<string, number | null>;

export const normaliseHeader = (h: string) => h.trim().toLowerCase().replace(/[\s_-]/g, '');

export function fieldsFor(kind: ImportKind): ImportField[] {
  return kind === 'devices' ? DEVICE_FIELDS : LINK_FIELDS;
}

/** Links when the header plainly has two ends; devices otherwise. */
export function guessKind(header: readonly string[]): ImportKind {
  const m = guessMapping(header, 'links');
  return m.source !== null && m.target !== null ? 'links' : 'devices';
}

/** Each field to the first column whose header is one of its spellings, in
 *  field order, never using a column twice. */
export function guessMapping(header: readonly string[], kind: ImportKind): ColumnMapping {
  const norm = header.map(normaliseHeader);
  const used = new Set<number>();
  const out: ColumnMapping = {};
  for (const f of fieldsFor(kind)) {
    out[f.key] = null;
    for (const alias of f.aliases) {
      const i = norm.findIndex((h, at) => h === alias && !used.has(at));
      if (i >= 0) {
        out[f.key] = i;
        used.add(i);
        break;
      }
    }
  }
  return out;
}

/** A cell as typed, with the quote a spreadsheet export adds in front of a
 *  formula character taken back off. */
function cell(row: readonly string[], i: number | null | undefined): string {
  if (i === null || i === undefined) return '';
  const v = (row[i] ?? '').trim();
  return /^'[=+\-@]/.test(v) ? v.slice(1) : v;
}

const HEALTH_RULES: LinkHealthRuleType[] = ['manual', 'follow-source', 'follow-target', 'both-endpoints', 'dedicated-probe', 'named-node-probe'];

export interface MappedDevices {
  kind: 'devices';
  rows: NodeCsvRow[];
  errors: string[];
}
export interface MappedLinks {
  kind: 'links';
  rows: LinkCsvRow[];
  errors: string[];
}

/** The rows under the header, read through the mapping. Row numbers in the
 *  errors are the spreadsheet's own (the header is row `headerRow + 1`). */
export function mapRows(grid: readonly (readonly string[])[], mapping: ColumnMapping, kind: ImportKind, headerRow = 0): MappedDevices | MappedLinks {
  const errors: string[] = [];
  const body = grid.slice(headerRow + 1);
  const rowNo = (i: number) => headerRow + i + 2;
  const blank = (r: readonly string[]) => r.every((c) => !c.trim());
  if (kind === 'devices') {
    const rows: NodeCsvRow[] = [];
    body.forEach((r, i) => {
      if (blank(r)) return;
      const name = cell(r, mapping.name);
      if (!name) {
        errors.push(`Row ${rowNo(i)}: no name; skipped.`);
        return;
      }
      const kindText = cell(r, mapping.probeType).toLowerCase();
      const optional = (key: string) => cell(r, mapping[key]) || undefined;
      rows.push({
        name,
        type: cell(r, mapping.type) || 'generic',
        address: cell(r, mapping.address),
        probeType: (['icmp', 'tcp', 'dns', 'manual'].includes(kindText) ? kindText : 'icmp') as ProbeKind,
        port: Number(cell(r, mapping.port)) || undefined,
        notes: cell(r, mapping.notes),
        tags: cell(r, mapping.tags).split(/[;|]/).map((t) => t.trim()).filter(Boolean),
        vendor: optional('vendor'),
        model: optional('model'),
        serial: optional('serial'),
        assetTag: optional('assetTag'),
        role: optional('role'),
        site: optional('site'),
        rack: optional('rack'),
      });
    });
    return { kind, rows, errors };
  }
  const rows: LinkCsvRow[] = [];
  body.forEach((r, i) => {
    if (blank(r)) return;
    const source = cell(r, mapping.source);
    const target = cell(r, mapping.target);
    if (!source || !target) {
      errors.push(`Row ${rowNo(i)}: needs both ends; skipped.`);
      return;
    }
    const rule = cell(r, mapping.healthRule) as LinkHealthRuleType;
    rows.push({
      source,
      target,
      sourcePort: cell(r, mapping.sourcePort),
      targetPort: cell(r, mapping.targetPort),
      label: cell(r, mapping.label),
      healthRule: HEALTH_RULES.includes(rule) ? rule : 'both-endpoints',
    });
  });
  return { kind, rows, errors };
}

/** The first row that looks like a header: the first with at least two
 *  non-empty cells, so a title line above the table is passed over. */
export function headerRowOf(grid: readonly (readonly string[])[]): number {
  const i = grid.findIndex((r) => r.filter((c) => c.trim()).length >= 2);
  return i < 0 ? 0 : i;
}
