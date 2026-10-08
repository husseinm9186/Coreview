/**
 * The change timeline as the page reads and saves it.
 *
 * `timeline.rs` works out what changed; this groups it by run for the table,
 * writes the "since your last crawl" line, and renders the Markdown and CSV
 * the operator saves. Pure, like every other reader here.
 */
import type { TimelineEntry } from './ipc';
import { sourceWords } from './evidence';
import { t } from '../i18n';

export const FIELD_WORDS: Record<string, string> = {
  appeared: 'appeared',
  disappeared: 'disappeared',
  class: 'type',
  platform: 'model',
  version: 'software',
  serial: 'serial',
  address: 'address',
  neighbour: 'neighbour',
  restarted: 'restarted',
};

export function fieldWords(field: string): string {
  return FIELD_WORDS[field] ?? field;
}

/** One line for the top of the view: what the newest run changed, or that
 *  it changed nothing, or that there is nothing to compare yet. */
export function sinceLastLine(sinceLast: Record<string, number>, runs: number): string {
  if (runs < 2) return t('timeline.needTwo', { count: runs });
  const parts = Object.entries(sinceLast)
    .sort((a, b) => b[1] - a[1])
    .map(([field, n]) => `${n} ${fieldWords(field)}`);
  return parts.length === 0 ? t('timeline.nothingSinceLast') : t('timeline.sinceLast', { list: parts.join(', ') });
}

/** Entries grouped by run, newest run first, each run's entries as given. */
export function byRun(entries: readonly TimelineEntry[]): { runId: string; takenAt: number; entries: TimelineEntry[] }[] {
  const groups = new Map<string, { runId: string; takenAt: number; entries: TimelineEntry[] }>();
  for (const e of entries) {
    const g = groups.get(e.runId) ?? { runId: e.runId, takenAt: e.takenAt, entries: [] };
    g.entries.push(e);
    groups.set(e.runId, g);
  }
  return [...groups.values()].sort((a, b) => b.takenAt - a.takenAt);
}

/** `was → now` in one cell, or the one side that exists. */
export function changeWords(e: TimelineEntry): string {
  if (e.was != null && e.now != null) return `${e.was} → ${e.now}`;
  if (e.now != null) return `+ ${e.now}`;
  if (e.was != null) return `− ${e.was}`;
  return '';
}

const csvCell = (v: string) => {
  const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
};

export function timelineCsv(entries: readonly TimelineEntry[], when: (ms: number) => string): string {
  const lines = ['Run,Device,What,Was,Now,Source'];
  for (const e of entries) {
    lines.push([when(e.takenAt), e.device, fieldWords(e.field), e.was ?? '', e.now ?? '', e.source ? sourceWords(e.source) : ''].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function timelineMarkdown(title: string, entries: readonly TimelineEntry[], when: (ms: number) => string): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const out = [`# ${title}`, ''];
  for (const g of byRun(entries)) {
    out.push(`## ${when(g.takenAt)}`, '', '| Device | What | Change | Source |', '| --- | --- | --- | --- |');
    for (const e of g.entries) {
      out.push(`| ${esc(e.device)} | ${fieldWords(e.field)} | ${esc(changeWords(e))} | ${e.source ? esc(sourceWords(e.source)) : ''} |`);
    }
    out.push('');
  }
  if (entries.length === 0) out.push(t('timeline.nothingSinceLast'), '');
  return out.join('\n');
}
