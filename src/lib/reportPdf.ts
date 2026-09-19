/**
 * A report as pages (LT-256), for a PDF: title page, summary, the drawings,
 * the device and port inventory, the cable schedule, how every check is set
 * up and what it found, what changed, and an appendix.
 *
 * Each page is an A4 SVG, laid out here and turned into one PDF by the same
 * writer the diagram export uses, so text stays text. Laying out in SVG means
 * nothing wraps by itself: text is broken by an estimate of its width (the
 * `fit` rule the diagram uses), tables break across pages with their header
 * repeated, and a drawing gets a page of its own, scaled to fit.
 *
 * The four templates (LT-257) are choices of section and wording for the four
 * reports engineers are asked for most; every section can still be switched
 * on or off before the report is made.
 */
import { fit } from './diagram';
import type { CableRow } from './cableSchedule';
import type { DiffRow } from './runDiff';
import type { HealthStatus, ProjectMeta } from '../types/domain';
import { STATUS_LABEL } from '../types/domain';

export type ReportSection = 'summary' | 'diagrams' | 'devices' | 'ports' | 'cables' | 'probes' | 'results' | 'diffs' | 'appendix';

export const SECTION_LABEL: Record<ReportSection, string> = {
  summary: 'Summary',
  diagrams: 'Diagrams',
  devices: 'Device inventory',
  ports: 'Port inventory',
  cables: 'Cable schedule',
  probes: 'Check configuration',
  results: 'Results',
  diffs: 'Changes',
  appendix: 'Appendix',
};

export interface ReportTemplate {
  id: 'baseline' | 'verification' | 'monthly' | 'handover';
  name: string;
  purpose: string;
  sections: ReportSection[];
}

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: 'baseline',
    name: 'Pre-change baseline',
    purpose: 'The network as it stands before the change: every device, port, cable and check, and what each check finds now, to compare against afterwards.',
    sections: ['summary', 'diagrams', 'devices', 'ports', 'cables', 'probes', 'results', 'appendix'],
  },
  {
    id: 'verification',
    name: 'Post-change verification',
    purpose: 'Whether the change left the network as it should be: what every check finds now, and what is different since the previous validation session and crawl.',
    sections: ['summary', 'diagrams', 'results', 'diffs', 'cables', 'appendix'],
  },
  {
    id: 'monthly',
    name: 'Monthly health',
    purpose: 'How the network has been running: availability and response time for every check, what is down or degraded, and what changed between the last two sessions and crawls.',
    sections: ['summary', 'results', 'diffs', 'devices', 'appendix'],
  },
  {
    id: 'handover',
    name: 'New-site handover',
    purpose: 'Everything the team taking over the site needs: the drawings, every device with its serial and location, every port and cable, and every check that watches them.',
    sections: ['summary', 'diagrams', 'devices', 'ports', 'cables', 'probes', 'appendix'],
  },
];

export interface ReportInput {
  meta: ProjectMeta;
  template: ReportTemplate;
  sections: readonly ReportSection[];
  generatedAt: Date;
  statusCounts: Record<HealthStatus, number>;
  linkCount: number;
  diagrams: { name: string; svg: string }[];
  devices: { name: string; type: string; address: string; model: string; serial: string; location: string; status: string }[];
  ports: { device: string; port: string; status: string; speed: string; vlan: string; errors: string }[];
  cables: CableRow[];
  probes: { object: string; name: string; kind: string; target: string; every: string; thresholds: string; enabled: string }[];
  results: { object: string; name: string; status: string; rtt: string; availability: string; last: string }[];
  transitions: { time: string; object: string; change: string; detail: string }[];
  diffs: { title: string; rows: DiffRow[] }[];
}

const W = 595;
const H = 842;
const M = 42;
const INNER = W - M * 2;
const ACCENT = '#0b5f73';
const INK = '#17202a';
const DIM = '#5b6773';
const RULE = '#d5dbe1';
const FAINT = '#f2f5f7';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Words broken into lines that fit `width` at `size`. */
export function wrap(text: string, width: number, size: number): string[] {
  const max = Math.max(4, Math.floor(width / (size * 0.52)));
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= max) line = candidate;
      else {
        if (line) lines.push(line);
        line = word.length > max ? fit(word, width, size * 0.95) : word;
      }
    }
    lines.push(line);
  }
  return lines;
}

interface Column {
  title: string;
  /** Share of the page width. */
  width: number;
  align?: 'left' | 'right';
}

class Pages {
  private pages: string[][] = [];
  private y = 0;
  private section = '';

  constructor(private title: string) {}

  newPage(section = this.section) {
    this.section = section;
    this.pages.push([]);
    this.y = M + 34;
  }

  private get body() {
    return this.pages[this.pages.length - 1]!;
  }

  private room(h: number) {
    if (this.pages.length === 0 || this.y + h > H - M - 24) this.newPage();
  }

  push(markup: string) {
    this.body.push(markup);
  }

  text(t: string, opts: { size?: number; weight?: number; colour?: string; gap?: number; indent?: number } = {}) {
    const size = opts.size ?? 9;
    const lh = size * 1.45;
    for (const line of wrap(t, INNER - (opts.indent ?? 0), size)) {
      this.room(lh);
      this.body.push(`<text x="${M + (opts.indent ?? 0)}" y="${(this.y + size).toFixed(1)}" font-size="${size}" font-weight="${opts.weight ?? 400}" fill="${opts.colour ?? INK}">${esc(line)}</text>`);
      this.y += lh;
    }
    this.y += opts.gap ?? 4;
  }

  heading(t: string) {
    this.room(60);
    this.y += 6;
    this.body.push(`<text x="${M}" y="${this.y + 15}" font-size="15" font-weight="700" fill="${INK}">${esc(t)}</text>`);
    this.body.push(`<rect x="${M}" y="${this.y + 21}" width="28" height="2.5" fill="${ACCENT}"/>`);
    this.y += 34;
  }

  subheading(t: string) {
    this.room(40);
    this.body.push(`<text x="${M}" y="${this.y + 11}" font-size="11" font-weight="700" fill="${INK}">${esc(t)}</text>`);
    this.y += 20;
  }

  table(columns: Column[], rows: string[][], empty: string) {
    if (rows.length === 0) {
      this.text(empty, { colour: DIM });
      return;
    }
    const size = 7.5;
    const rowH = 14;
    const xs: number[] = [];
    let x = M;
    for (const c of columns) {
      xs.push(x);
      x += c.width * INNER;
    }
    const cell = (value: string, i: number, weight: number, colour: string) => {
      const c = columns[i]!;
      const w = c.width * INNER - 6;
      const tx = c.align === 'right' ? xs[i]! + c.width * INNER - 3 : xs[i]! + 3;
      return `<text x="${tx.toFixed(1)}" y="${(this.y + 9.8).toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${colour}"${c.align === 'right' ? ' text-anchor="end"' : ''}>${esc(fit(value, w, size))}</text>`;
    };
    const header = () => {
      this.body.push(`<rect x="${M}" y="${this.y}" width="${INNER}" height="${rowH}" fill="${FAINT}"/>`);
      this.body.push(columns.map((c, i) => cell(c.title, i, 700, DIM)).join(''));
      this.y += rowH;
    };
    this.room(rowH * 3);
    header();
    rows.forEach((r) => {
      if (this.y + rowH > H - M - 24) {
        this.newPage();
        header();
      }
      this.body.push(r.map((v, i) => cell(v, i, 400, INK)).join(''));
      this.body.push(`<line x1="${M}" x2="${M + INNER}" y1="${this.y + rowH}" y2="${this.y + rowH}" stroke="${RULE}" stroke-width="0.5"/>`);
      this.y += rowH;
    });
    this.y += 10;
  }

  /** A drawing on a page of its own, scaled to fit under its name. */
  drawing(name: string, svg: string) {
    this.newPage();
    this.body.push(`<text x="${M}" y="${this.y + 13}" font-size="13" font-weight="700" fill="${INK}">${esc(name)}</text>`);
    const top = this.y + 24;
    const box = { w: INNER, h: H - M - 24 - top };
    const root = svg.replace(/^<\?xml[^>]*\?>\s*/, '');
    const width = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(root)?.[1] ?? 800);
    const height = Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(root)?.[1] ?? 600);
    const scale = Math.min(box.w / width, box.h / height);
    const w = width * scale;
    const h = height * scale;
    // The drawing's own viewBox keeps its coordinates; only its box on this
    // page changes.
    const placed = root.replace(/<svg([^>]*?)\swidth="[\d.]+"\s+height="[\d.]+"/, `<svg$1 x="${(M + (box.w - w) / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"`);
    this.body.push(`<rect x="${M - 0.5}" y="${top - 0.5}" width="${box.w + 1}" height="${box.h + 1}" fill="none" stroke="${RULE}"/>`);
    this.body.push(placed);
    this.y = H;
  }

  finish(cover: string): string[] {
    const total = this.pages.length + 1;
    const frame = (inner: string, n: number) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif">` +
      `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
      (n > 1
        ? `<text x="${M}" y="${M}" font-size="8" fill="${DIM}">${esc(this.title)}</text><line x1="${M}" x2="${W - M}" y1="${M + 8}" y2="${M + 8}" stroke="${RULE}" stroke-width="0.6"/>` +
          `<text x="${W - M}" y="${H - M + 10}" font-size="8" fill="${DIM}" text-anchor="end">Page ${n} of ${total}</text>`
        : '') +
      inner +
      '</svg>';
    return [frame(cover, 1), ...this.pages.map((p, i) => frame(p.join(''), i + 2))];
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function reportPages(r: ReportInput): string[] {
  const on = (s: ReportSection) => r.sections.includes(s);
  const title = `${r.template.name} — ${r.meta.name}`;
  const doc = new Pages(title);
  const when = r.generatedAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  // Title page.
  const details = [
    ['Customer', r.meta.customer], ['Site', r.meta.site], ['Change', r.meta.ticket], ['Engineer', r.meta.engineer], ['Generated', when],
  ].filter(([, v]) => v);
  const purpose = wrap(r.template.purpose, INNER - 20, 11);
  const contents = r.sections.map((s) => SECTION_LABEL[s]);
  const cover =
    `<rect x="0" y="0" width="${W}" height="250" fill="${ACCENT}"/>` +
    `<text x="${M}" y="120" font-size="12" font-weight="600" fill="#cfe6ec" letter-spacing="1.2">${esc(r.template.name.toUpperCase())}</text>` +
    `<text x="${M}" y="160" font-size="28" font-weight="700" fill="#ffffff">${esc(fit(r.meta.name, INNER, 28))}</text>` +
    `<text x="${M}" y="190" font-size="11" fill="#e2f0f3">${esc(fit([r.meta.customer, r.meta.site].filter(Boolean).join(' · '), INNER, 11))}</text>` +
    purpose.map((l, i) => `<text x="${M}" y="${300 + i * 17}" font-size="11" fill="${INK}">${esc(l)}</text>`).join('') +
    details.map(([k, v], i) => `<text x="${M}" y="${380 + purpose.length * 17 + i * 18}" font-size="10" fill="${DIM}">${esc(k!)}</text><text x="${M + 90}" y="${380 + purpose.length * 17 + i * 18}" font-size="10" fill="${INK}">${esc(fit(v!, INNER - 90, 10))}</text>`).join('') +
    `<text x="${M}" y="${H - M - 14 * contents.length - 12}" font-size="9" font-weight="700" fill="${DIM}">CONTENTS</text>` +
    contents.map((c, i) => `<text x="${M}" y="${H - M - 14 * (contents.length - i) + 4}" font-size="9" fill="${INK}">${esc(c)}</text>`).join('');

  const devicesDown = r.results.filter((x) => x.status === STATUS_LABEL.down);
  const degraded = r.results.filter((x) => x.status === STATUS_LABEL.warning);

  if (on('summary')) {
    doc.newPage(SECTION_LABEL.summary);
    doc.heading('Summary');
    doc.text(`${count(r.devices.length, 'device')}, ${count(r.linkCount, 'link')}, ${count(r.diagrams.length, 'page')} of drawings and ${count(r.probes.length, 'check')}.`, { size: 10 });
    const states = (Object.keys(r.statusCounts) as HealthStatus[]).filter((k) => r.statusCounts[k] > 0);
    doc.text(states.length ? `Status when the report was made: ${states.map((k) => `${r.statusCounts[k]} ${STATUS_LABEL[k].toLowerCase()}`).join(', ')}.` : 'No object had a status when the report was made.', { size: 10 });
    if (devicesDown.length || degraded.length) {
      doc.subheading('Needs attention');
      doc.table(
        [{ title: 'Object', width: 0.3 }, { title: 'Check', width: 0.3 }, { title: 'Status', width: 0.15 }, { title: 'Last result', width: 0.25 }],
        [...devicesDown, ...degraded].map((x) => [x.object, x.name, x.status, x.last]),
        '',
      );
    } else if (r.results.length) {
      doc.text('Every check was healthy or not yet run.', { colour: DIM });
    }
    const worse = r.diffs.flatMap((d) => d.rows).filter((x) => x.tone === 'worse').length;
    if (on('diffs') && r.diffs.length) doc.text(`${count(worse, 'change')} for the worse since the previous run.`, { size: 10 });
  }

  if (on('diagrams')) for (const d of r.diagrams) doc.drawing(`Diagram — ${d.name}`, d.svg);

  if (on('devices')) {
    doc.newPage(SECTION_LABEL.devices);
    doc.heading('Device inventory');
    doc.table(
      [{ title: 'Name', width: 0.19 }, { title: 'Type', width: 0.13 }, { title: 'Address', width: 0.13 }, { title: 'Model', width: 0.18 }, { title: 'Serial', width: 0.15 }, { title: 'Site / rack', width: 0.13 }, { title: 'Status', width: 0.09 }],
      r.devices.map((d) => [d.name, d.type, d.address, d.model, d.serial, d.location, d.status]),
      'The project has no devices.',
    );
  }

  if (on('ports')) {
    doc.newPage(SECTION_LABEL.ports);
    doc.heading('Port inventory');
    doc.table(
      [{ title: 'Device', width: 0.22 }, { title: 'Port', width: 0.14 }, { title: 'Status', width: 0.15 }, { title: 'Speed', width: 0.12 }, { title: 'VLAN', width: 0.17 }, { title: 'Errors', width: 0.2, align: 'right' }],
      r.ports.map((p) => [p.device, p.port, p.status, p.speed, p.vlan, p.errors]),
      'No crawl has read any ports yet. Run a crawl with "Ports and VLANs" ticked to fill this in.',
    );
  }

  if (on('cables')) {
    doc.newPage(SECTION_LABEL.cables);
    doc.heading('Cable schedule');
    doc.table(
      [{ title: 'Device A', width: 0.2 }, { title: 'Port A', width: 0.13 }, { title: 'Device B', width: 0.2 }, { title: 'Port B', width: 0.13 }, { title: 'Cable', width: 0.14 }, { title: 'Length', width: 0.08 }, { title: 'Page', width: 0.12 }],
      r.cables.map((c) => [c.deviceA, c.portA, c.deviceB, c.portB, c.cable || c.label, c.length, c.page]),
      'There are no links between devices.',
    );
  }

  if (on('probes')) {
    doc.newPage(SECTION_LABEL.probes);
    doc.heading('Check configuration');
    doc.table(
      [{ title: 'Object', width: 0.2 }, { title: 'Check', width: 0.18 }, { title: 'Kind', width: 0.1 }, { title: 'Target', width: 0.2 }, { title: 'Every', width: 0.1 }, { title: 'Thresholds', width: 0.14 }, { title: 'On', width: 0.08 }],
      r.probes.map((p) => [p.object, p.name, p.kind, p.target, p.every, p.thresholds, p.enabled]),
      'No checks are configured.',
    );
  }

  if (on('results')) {
    doc.newPage(SECTION_LABEL.results);
    doc.heading('Results');
    doc.table(
      [{ title: 'Object', width: 0.2 }, { title: 'Check', width: 0.2 }, { title: 'Status', width: 0.12 }, { title: 'Last RTT', width: 0.11, align: 'right' }, { title: 'Available', width: 0.11, align: 'right' }, { title: 'Last result', width: 0.26 }],
      r.results.map((x) => [x.object, x.name, x.status, x.rtt, x.availability, x.last]),
      'No checks have run.',
    );
    doc.subheading(`State changes (${r.transitions.length})`);
    doc.table(
      [{ title: 'Time', width: 0.2 }, { title: 'Object', width: 0.22 }, { title: 'Change', width: 0.18 }, { title: 'Detail', width: 0.4 }],
      r.transitions.map((t) => [t.time, t.object, t.change, t.detail]),
      'No state changed during the session.',
    );
  }

  if (on('diffs')) {
    doc.newPage(SECTION_LABEL.diffs);
    doc.heading('Changes');
    if (!r.diffs.length) doc.text('There is nothing earlier to compare with: a report of changes needs two validation sessions or two crawls.', { colour: DIM });
    for (const d of r.diffs) {
      doc.subheading(d.title);
      doc.table(
        [{ title: 'What', width: 0.26 }, { title: 'Change', width: 0.22 }, { title: 'Before', width: 0.22 }, { title: 'After', width: 0.22 }, { title: '', width: 0.08 }],
        d.rows.map((x) => [x.subject, x.change, x.before, x.after, x.tone === 'worse' ? 'worse' : x.tone === 'better' ? 'better' : '']),
        'Nothing changed.',
      );
    }
  }

  if (on('appendix')) {
    doc.newPage(SECTION_LABEL.appendix);
    doc.heading('Appendix');
    doc.subheading('How to read this report');
    doc.text('Every result was produced by a check run from the machine where Coreview was running. A healthy result proves that machine could reach the target with the configured method at that moment. It does not prove that every drawn link on the way is healthy, nor that application traffic flows end to end. A link\'s state follows the health rule chosen for it.');
    doc.text('Availability is the share of checks that were healthy or warning, of those that ran, over the samples held when the report was made. Inventory, ports and neighbours are what the last crawl read from each device; a device that has not been crawled shows what was drawn or imported.');
    doc.subheading('Statuses');
    doc.text((Object.keys(STATUS_LABEL) as HealthStatus[]).map((k) => STATUS_LABEL[k]).join(' · '));
    doc.subheading('Made by');
    doc.text(`Coreview, ${when}. Template: ${r.template.name}. Sections: ${contents.join(', ')}.`);
  }

  return doc.finish(cover);
}
