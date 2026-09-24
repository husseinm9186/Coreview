import type { MerakiReport, MerakiStatus } from './ipc';

/**
 * The health report's pure parts (LT-406).
 *
 * Counting verdicts and drawing the PDF are logic, not markup, so they live
 * here where they can be tested without a browser — the same split every other
 * panel in this app uses.
 */

/** The words a person reads for each verdict.
 *
 * Written once, here, and never spelled out at a call site. His script carries
 * a comment about exactly this having drifted: "Manual review" survived a
 * rename because it was written out in six places. */
const LABEL: Record<MerakiStatus, string> = {
  attention: 'Needs attention',
  advisory: 'Advisory',
  manual: 'Not reported',
  pass: 'OK',
  na: 'Not applicable',
};

/** The order verdicts are counted and shown in, everywhere. */
export const STATUS_ORDER: MerakiStatus[] = ['attention', 'advisory', 'manual', 'pass', 'na'];

export function statusLabel(status: MerakiStatus): string {
  return LABEL[status] ?? status;
}

/** How many checks landed on each verdict, in {@link STATUS_ORDER}. */
export function tally(report: MerakiReport): { status: MerakiStatus; count: number }[] {
  return STATUS_ORDER.map((status) => ({
    status,
    count: report.checks.filter((c) => c.status === status).length,
  }));
}

/** Every finding graded as an action, with the check it came from. */
export function actionItems(report: MerakiReport): { check: string; summary: string; code: string }[] {
  return report.checks.flatMap((c) =>
    c.findings
      .filter((f) => f.severity === 'action')
      .map((f) => ({ check: c.title, summary: c.summary, code: f.code })),
  );
}

/** What the saved PDF is called: the customer, the network and the day, so a
 *  folder of them sorts and reads without opening any. */
export function reportFilename(report: MerakiReport): string {
  const slug = (text: string) =>
    text
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase() || 'meraki';
  const day = report.takenAt.slice(0, 10) || 'undated';
  return `${slug(report.organization)}-${slug(report.network)}-health-${day}.pdf`;
}

/** XML-escapes a string for dropping into SVG text. */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Breaks a line to roughly `width` characters, so a long summary wraps
 *  instead of running off the page. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Print colours: dark enough to read on paper, which is what this becomes. */
const COLOUR: Record<MerakiStatus, string> = {
  attention: '#b4451e',
  advisory: '#1f5e9e',
  manual: '#8a6a00',
  pass: '#1e7b3c',
  na: '#6b7280',
};

const PAGE = { width: 794, height: 1123, margin: 48 };

/**
 * The report as one SVG, for the PDF engine that already exists.
 *
 * Deliberately plain: black text on white, because it is going to a printer
 * and then into a folder. The page is A4 at 96 dpi, which is what
 * `diagram_pdf` expects.
 */
export function reportSvg(report: MerakiReport): string {
  const { width, margin } = PAGE;
  const parts: string[] = [];
  let y = margin;

  const text = (content: string, size: number, weight: string, colour = '#0d1722', dx = 0) => {
    parts.push(
      `<text x="${margin + dx}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${colour}">${escape(content)}</text>`,
    );
    y += size + 6;
  };

  text('Network Health Check', 22, '700');
  text(`${report.organization} · ${report.network}`, 14, '600');
  text(`Read ${report.takenAt.replace('T', ' ').slice(0, 19)} · ${report.profile.label}`, 10, '400', '#3d4e63');
  y += 6;

  for (const line of wrap(report.profile.summary, 96)) text(line, 10, '400', '#3d4e63');
  y += 10;

  // The count of each verdict, as a row of figures.
  const counts = tally(report);
  const cell = (width - margin * 2) / counts.length;
  counts.forEach(({ status, count }, i) => {
    const x = margin + i * cell;
    parts.push(
      `<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="700" fill="${COLOUR[status]}">${count}</text>`,
      `<text x="${x}" y="${y + 14}" font-family="Helvetica, Arial, sans-serif" font-size="9" fill="#3d4e63">${escape(LABEL[status])}</text>`,
    );
  });
  y += 42;

  const actions = actionItems(report);
  text(actions.length > 0 ? `Action items (${actions.length})` : 'Action items: none', 13, '700');
  for (const item of actions) {
    text(`• ${item.check}`, 10, '600', COLOUR.attention);
    for (const line of wrap(item.summary, 92)) text(line, 9, '400', '#3d4e63', 10);
    y += 2;
  }
  y += 10;

  text('Every check', 13, '700');
  for (const check of [...report.checks].sort((a, b) => a.num.localeCompare(b.num))) {
    text(`${check.num}  ${check.title} — ${LABEL[check.status]}`, 10, '600', COLOUR[check.status]);
    for (const line of wrap(check.summary, 92)) text(line, 9, '400', '#3d4e63', 10);
    y += 2;
  }

  y += 10;
  for (const line of wrap(`What this is built from: ${report.dataWindows}`, 100)) {
    text(line, 8, '400', '#5b6b7e');
  }

  // The page grows to fit rather than clipping: a report that silently loses
  // its last checks is worse than a long one.
  const height = Math.max(PAGE.height, y + margin);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${parts.join('')}</svg>`;
}
