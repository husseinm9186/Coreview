/**
 * Seeds for a crawl from a CSV (LT-207): an asset register or a spreadsheet of
 * management addresses, turned into the seed list the crawl panel sends.
 *
 * A column headed like an address or a hostname is taken whole. Without one,
 * only cells that are plainly an address or a range are taken — a word in a
 * notes column is not a hostname to dial.
 */
import { parseCsv } from './csv';

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const CIDR = /^(\d{1,3})(\.\d{1,3}){3}\/\d{1,2}$/;
const HEADERS = ['address', 'ip', 'ip address', 'management ip', 'management address', 'mgmt ip', 'host', 'hostname', 'seed', 'fqdn', 'name'];

export function seedsFromCsv(text: string): string[] {
  const grid = parseCsv(text).filter((row) => row.some((c) => c.trim()));
  if (grid.length === 0) return [];
  const header = grid[0]!.map((c) => c.trim().toLowerCase());
  // The most specific heading wins: an address column over a name column.
  const column = HEADERS.map((h) => header.indexOf(h)).find((i) => i >= 0);
  const out: string[] = [];
  const add = (v: string) => {
    const s = v.trim();
    if (s && !out.includes(s)) out.push(s);
  };
  if (column !== undefined) {
    for (const row of grid.slice(1)) add(row[column] ?? '');
  } else {
    for (const row of grid) for (const cell of row) if (IPV4.test(cell.trim()) || CIDR.test(cell.trim())) add(cell);
  }
  return out;
}
