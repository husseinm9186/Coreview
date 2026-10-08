/**
 * A sweep's hits as CSV, the way the crawl's tables export: one row
 * per address that answered, with what the sweep learned about it and where
 * each name came from. Pure, so the shape is tested without a network.
 */
import { toCsv } from './csv';
import type { SweepHit } from './ipc';

/** The ports typed into the sweep form: numbers between 1 and 65535, once
 *  each, in the order given. Anything else is dropped rather than guessed. */
export function parsePortList(text: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const part of text.split(/[,\s;]+/)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > 65_535 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function sweepCsv(hits: readonly SweepHit[]): string {
  const rows: string[][] = [['Address', 'Name', 'Name from', 'MAC', 'Manufacturer', 'RTT ms', 'Open ports', 'Serial']];
  for (const h of hits) {
    rows.push([
      h.ip,
      h.hostname ?? '',
      h.nameSource ?? '',
      h.mac ?? '',
      h.vendor ?? '',
      h.rttMs == null ? '' : String(Math.round(h.rttMs * 10) / 10),
      h.ports.map((p) => (p.service ? `${p.port}/${p.service}` : String(p.port))).join(' '),
      h.serial ?? '',
    ]);
  }
  return toCsv(rows);
}
