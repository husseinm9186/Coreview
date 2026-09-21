/**
 * Reading the register back in from a spreadsheet (LT-298, Phase 2).
 *
 * `ipamRows` has always written the register out as CSV — the format of the
 * spreadsheet this replaces. Nothing read it back, so the round trip was
 * one-way and an estate already recorded in Excel had to be typed in.
 *
 * **Columns are matched by heading, not by position.** A spreadsheet that has
 * been through three people has reordered columns and extra ones of its own;
 * insisting on an order would reject exactly the files worth importing. Only
 * `Address` is required, because it is the only field that must parse.
 *
 * **Nothing is guessed.** A row whose address will not parse is skipped and
 * says which line and why, rather than being imported as something plausible.
 * A subnet named on a row that the register does not hold is reported as
 * wanted rather than silently created, because creating subnets is a decision
 * about someone's network (D-050). Two rows claiming one address are a
 * conflict and both are reported; the register is not quietly given the last.
 */
import type { AssignmentType, EntryKind, IpamEntry } from './ipam';
import { ASSIGNMENT_TYPES, ENTRY_KINDS, toValue } from './ipam';

export interface CsvSkip {
  /** 1-based line in the file, counting the heading, so it matches the editor. */
  line: number;
  why: string;
  address?: string;
}

export interface CsvImportResult {
  /** Entries ready to go into the register, in file order. */
  entries: Omit<IpamEntry, 'id'>[];
  /** Subnets a row named that the caller does not hold yet, deduplicated. */
  wantedSubnets: string[];
  /** Rows that were not imported, each with a reason. */
  skipped: CsvSkip[];
  /** Addresses claimed by more than one row. Neither is imported. */
  conflicts: string[];
}

/** Splits one CSV line, honouring quotes so a note may contain a comma. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Headings this understands, lower-cased, mapped to what they fill in. */
const HEADINGS: Record<string, keyof Omit<IpamEntry, 'id'> | 'subnet'> = {
  address: 'address',
  ip: 'address',
  'ip address': 'address',
  name: 'label',
  label: 'label',
  'held as': 'kind',
  kind: 'kind',
  'used as': 'assignment',
  assignment: 'assignment',
  hostname: 'hostname',
  fqdn: 'fqdn',
  owner: 'owner',
  purpose: 'purpose',
  mac: 'mac',
  note: 'note',
  notes: 'note',
  subnet: 'subnet',
};

/**
 * Reads a CSV the register wrote, or one a person kept by hand.
 *
 * `known` is the subnets the register already holds, so a row naming one of
 * them is not reported as wanted.
 */
export function parseIpamCsv(text: string, known: readonly string[] = []): CsvImportResult {
  const result: CsvImportResult = { entries: [], wantedSubnets: [], skipped: [], conflicts: [] };
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((l) => l.trim() !== '');
  if (headingIndex < 0) return result;

  const headings = splitCsvLine(lines[headingIndex]!).map((h) => h.toLowerCase());
  const columns = headings.map((h) => HEADINGS[h] ?? null);
  if (!columns.includes('address')) {
    result.skipped.push({ line: headingIndex + 1, why: 'no Address column — nothing here can be an address' });
    return result;
  }

  const haveSubnet = new Set(known);
  const wanted = new Set<string>();
  const seen = new Map<string, number>();
  const conflicted = new Set<string>();

  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const line = i + 1;
    const cells = splitCsvLine(raw);
    const entry: Record<string, string> = {};
    let subnet = '';
    columns.forEach((field, c) => {
      if (!field) return;
      const value = cells[c] ?? '';
      if (field === 'subnet') subnet = value;
      else if (value !== '') entry[field] = value;
    });

    const address = entry.address ?? '';
    if (toValue(address) === null) {
      result.skipped.push({ line, why: address === '' ? 'no address on this row' : `"${address}" is not an address`, address });
      continue;
    }
    const already = seen.get(address);
    if (already !== undefined) {
      if (!conflicted.has(address)) {
        result.conflicts.push(address);
        conflicted.add(address);
      }
      result.skipped.push({ line, why: `${address} is also on line ${already}`, address });
      continue;
    }
    seen.set(address, line);
    if (subnet !== '' && !haveSubnet.has(subnet)) wanted.add(subnet);

    const kind = ENTRY_KINDS.includes(entry.kind as EntryKind) ? (entry.kind as EntryKind) : 'in-use';
    const assignment = ASSIGNMENT_TYPES.includes(entry.assignment as AssignmentType)
      ? (entry.assignment as AssignmentType)
      : undefined;
    result.entries.push({
      address,
      label: entry.label ?? '',
      kind,
      ...(assignment ? { assignment } : {}),
      ...(entry.hostname ? { hostname: entry.hostname } : {}),
      ...(entry.fqdn ? { fqdn: entry.fqdn } : {}),
      ...(entry.mac ? { mac: entry.mac } : {}),
      ...(entry.owner ? { owner: entry.owner } : {}),
      ...(entry.purpose ? { purpose: entry.purpose } : {}),
      ...(entry.note ? { note: entry.note } : {}),
    });
  }

  // Both sides of a conflict stay out: the register is not given the last one.
  if (conflicted.size) {
    result.entries = result.entries.filter((e) => !conflicted.has(e.address));
  }
  result.wantedSubnets = [...wanted];
  return result;
}
