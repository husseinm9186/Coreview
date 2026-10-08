import type { MerakiCheck, MerakiReport, MerakiSection, MerakiStatus } from './ipc';

/**
 * The health report's pure parts.
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

/** What each verdict means, for the key at the top of the report.
 *
 *  "Not reported" is the one that has to be worded carefully: it is a
 *  statement about what could be read, never a task handed to the reader. */
export const STATUS_KEY: { status: MerakiStatus; meaning: string }[] = [
  { status: 'pass', meaning: 'checked and healthy.' },
  { status: 'attention', meaning: 'needs fixing. Steps are given under each one.' },
  { status: 'advisory', meaning: 'a real finding, not urgent here.' },
  { status: 'manual', meaning: 'the API does not return this figure; the dashboard page is named under each one.' },
  { status: 'na', meaning: 'not present on this network.' },
];

const SECTION_TITLE: Record<MerakiSection, string> = {
  firewall: 'Firewall (MX) Health Check',
  wireless: 'Wireless Health Check',
  switching: 'Switch Health Check',
};

export function sectionTitle(section: MerakiSection): string {
  return SECTION_TITLE[section] ?? section;
}

/** The first step of every item that needs attention — the action items
 *  table, which is the first page of the report and often the only one read. */
export function actionItems(report: MerakiReport): { check: MerakiCheck; step: string }[] {
  return summaryRows(report, 'attention');
}

/** The same, for the findings the profile graded as advisories. */
export function advisoryItems(report: MerakiReport): { check: MerakiCheck; step: string }[] {
  return summaryRows(report, 'advisory');
}

function summaryRows(report: MerakiReport, status: MerakiStatus): { check: MerakiCheck; step: string }[] {
  return report.checks
    .filter((c) => c.status === status && c.steps.length > 0)
    .map((check) => ({ check, step: check.steps[0]! }));
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
 * Deliberately plain: dark text on white, because it goes to a printer and
 * then into a folder. The page is A4 wide at 96 dpi, and grows downwards
 * rather than clipping — `diagram_pdf` takes the height it is given.
 *
 * **The tool is not named on it.** This is the customer's document.
 */
export function reportSvg(report: MerakiReport): string {
  const { width, margin } = PAGE;
  const parts: string[] = [];
  let y = margin;
  const contentWidth = width - margin * 2;

  const text = (content: string, size: number, weight: string, colour = '#0d1722', dx = 0) => {
    parts.push(
      `<text x="${margin + dx}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${colour}">${escape(content)}</text>`,
    );
    y += size + 5;
  };
  const wrapped = (content: string, size: number, weight: string, colour: string, dx: number, cols: number) => {
    for (const line of wrap(content, cols)) text(line, size, weight, colour, dx);
  };
  const rule = () => {
    parts.push(
      `<line x1="${margin}" y1="${y}" x2="${margin + contentWidth}" y2="${y}" stroke="#c9ced6" stroke-width="1"/>`,
    );
    y += 12;
  };

  // ── Title and the metadata table.
  text('Network Health Check', 22, '700');
  text(report.organization, 15, '600');
  y += 4;
  for (const [label, value] of [
    ['Customer', report.organization],
    ['Networks assessed', report.network],
    ['Date generated', `${report.takenAt.replace('T', ' ').slice(0, 19)} UTC`],
    ['Profile', report.profile.label],
  ]) {
    parts.push(
      `<text x="${margin}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="9" font-weight="700" fill="#0d1722">${escape(label!)}</text>`,
      `<text x="${margin + 130}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="9" fill="#3d4e63">${escape(value!)}</text>`,
    );
    y += 14;
  }
  y += 6;
  rule();

  // ── How to read it.
  text('How to read this report', 12, '700');
  text('Every item comes from the health check list and is answered from live dashboard data. Read-only — nothing was changed.', 8, '400', '#3d4e63');
  for (const { status, meaning } of STATUS_KEY) {
    text(`${LABEL[status]} — ${meaning}`, 8, '400', COLOUR[status], 6);
  }
  y += 2;
  wrapped(`Data used: ${report.dataWindows}`, 8, '400', '#5b6b7e', 0, 118);
  const sections = [...new Set(report.checks.map((c) => c.section))];
  text(
    `${sections.map((s) => SECTION_TITLE[s].replace(' Health Check', '')).join(' · ')} · ${report.checks.length} items assessed`,
    8,
    '600',
    '#3d4e63',
  );
  y += 6;
  rule();

  // ── Results at a glance.
  text('Results at a glance', 12, '700');
  y += 4;
  const counts = tally(report);
  const cell = contentWidth / counts.length;
  counts.forEach(({ status, count }, i) => {
    const x = margin + i * cell;
    parts.push(
      `<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="19" font-weight="700" fill="${COLOUR[status]}">${count}</text>`,
      `<text x="${x}" y="${y + 13}" font-family="Helvetica, Arial, sans-serif" font-size="8" fill="#3d4e63">${escape(LABEL[status])}</text>`,
    );
  });
  y += 36;
  rule();

  // ── Action items, then advisories.
  const table = (heading: string, rows: { check: MerakiCheck; step: string }[], empty: string, colour: string) => {
    text(heading, 12, '700');
    if (rows.length === 0) {
      text(empty, 9, '400', '#3d4e63');
      y += 4;
      return;
    }
    rows.forEach(({ check, step }, i) => {
      text(`${i + 1}.  ${check.title}`, 9, '700', colour);
      wrapped(step, 8, '400', '#3d4e63', 14, 112);
      y += 3;
    });
    y += 4;
  };
  table('Action items', actionItems(report), 'Nothing in this network needs attention under this profile.', COLOUR.attention);
  table('Advisories — worth doing, not urgent', advisoryItems(report), 'No advisories.', COLOUR.advisory);
  rule();

  // ── Every item, by section.
  for (const section of ['firewall', 'wireless', 'switching'] as MerakiSection[]) {
    const inSection = report.checks.filter((c) => c.section === section);
    if (inSection.length === 0) continue;
    text(SECTION_TITLE[section], 14, '700');
    y += 2;

    for (const check of [...inSection].sort((a, b) => a.num.localeCompare(b.num, 'en', { numeric: true }))) {
      text(`${check.num}. ${check.title}`, 11, '700');
      text(`Navigation: ${check.navigation}`, 8, '400', '#5b6b7e');
      if (check.checklist.length > 0) {
        text('Checklist', 8, '700', '#3d4e63');
        for (const item of check.checklist) wrapped(`• ${item}`, 8, '400', '#3d4e63', 8, 112);
      }
      text(`${LABEL[check.status]} — ${check.summary}`, 9, '600', COLOUR[check.status]);

      if (check.observations.length > 0) {
        text('Observed', 8, '700', '#3d4e63');
        for (const o of check.observations) wrapped(o, 8, '400', '#3d4e63', 8, 112);
      }

      for (const detail of check.details) {
        text(detail.label, 8, '700', '#3d4e63');
        text(detail.columns.join('  ·  '), 7, '700', '#5b6b7e', 8);
        for (const row of detail.rows.slice(0, 12)) {
          wrapped(row.join('  ·  '), 7, '400', '#3d4e63', 8, 130);
        }
        if (detail.rows.length > 12) {
          text(`… and ${detail.rows.length - 12} more`, 7, '400', '#5b6b7e', 8);
        }
      }

      if (check.steps.length > 0) {
        text(check.status === 'attention' ? 'Recommended action' : 'Suggested improvement', 8, '700', '#3d4e63');
        check.steps.forEach((step, i) => wrapped(`${i + 1}. ${step}`, 8, '400', '#3d4e63', 8, 112));
      }
      y += 10;
    }
    rule();
  }

  // The page grows to fit rather than clipping: a report that silently loses
  // its last items is worse than a long one.
  const height = Math.max(PAGE.height, y + margin);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${parts.join('')}</svg>`;
}
