import { describe, expect, it } from 'vitest';

import { REPORT_TEMPLATES, reportPages, wrap, type ReportInput } from './reportPdf';

const meta = { id: 'p', name: 'Lab <network>', customer: 'Example Co', site: 'HQ', ticket: 'CHG-1', engineer: 'Sam', description: '', createdAt: 0, updatedAt: 0, archived: false };

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  meta,
  template: REPORT_TEMPLATES[0]!,
  sections: REPORT_TEMPLATES[0]!.sections,
  generatedAt: new Date(0),
  statusCounts: { healthy: 3, warning: 1, down: 1, unknown: 0, disabled: 0, maintenance: 0 },
  linkCount: 2,
  diagrams: [{ name: 'Core', svg: '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600"><text>CORE-SW1</text></svg>' }],
  devices: Array.from({ length: 120 }, (_, i) => ({ name: `SW-${i}`, type: 'Access switch', address: `192.0.2.${i}`, model: 'C9200L', serial: `S${i}`, location: 'Lab / R01', status: 'Healthy' })),
  ports: [],
  cables: [{ page: 'Core', deviceA: 'SW-1', portA: 'Gi0/1', deviceB: 'SW-2', portB: 'Gi0/2', cable: 'C-1', length: '2 m', label: '' }],
  probes: [{ object: 'SW-1', name: 'Ping', kind: 'ICMP', target: '192.0.2.1', every: '5 s', thresholds: '3 / 2', enabled: 'yes' }],
  results: [
    { object: 'SW-1', name: 'Ping', status: 'Down', rtt: '—', availability: '80%', last: 'No reply' },
    { object: 'SW-2', name: 'Ping', status: 'Healthy', rtt: '2 ms', availability: '100%', last: 'Reply' },
  ],
  transitions: [],
  diffs: [],
  ...over,
});

const text = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

describe('the PDF report (LT-256)', () => {
  const pages = reportPages(input());

  it('starts with a title page naming the template, the project and its purpose', () => {
    const cover = text(pages[0]!);
    expect(cover).toContain('PRE-CHANGE BASELINE');
    expect(cover).toContain('Lab &lt;network&gt;');
    expect(cover.join(' ')).toMatch(/before the change/);
    expect(cover).toContain('CONTENTS');
  });

  it('numbers every page after the cover', () => {
    const n = pages.length;
    expect(text(pages[1]!)).toContain(`Page 2 of ${n}`);
    expect(text(pages[n - 1]!)).toContain(`Page ${n} of ${n}`);
  });

  it('lists what needs attention in the summary', () => {
    const summary = pages.slice(1).find((p) => text(p).includes('Summary'))!;
    expect(text(summary)).toContain('Needs attention');
    expect(text(summary)).toContain('No reply');
  });

  it('gives a drawing its own page, scaled into it with its own coordinates kept', () => {
    const page = pages.find((p) => text(p).includes('Diagram — Core'))!;
    const inner = /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" viewBox="0 0 1200 600">/.exec(page);
    expect(inner, page.slice(0, 900)).not.toBeNull();
    expect(Number(inner![3])).toBeLessThanOrEqual(511 + 0.1);
    expect(page).not.toContain('<?xml version="1.0"?>');
  });

  it('breaks a long table across pages with its header repeated', () => {
    const inventory = pages.filter((p) => text(p).includes('C9200L'));
    expect(inventory.length).toBeGreaterThan(2);
    for (const p of inventory) expect(text(p)).toContain('Serial');
    expect(inventory.flatMap(text).filter((t) => /^SW-\d+$/.test(t!))).toHaveLength(120);
  });

  it('says what a missing section needs rather than leaving it blank', () => {
    const ports = pages.slice(1).find((p) => text(p).includes('Port inventory'))!;
    expect(text(ports).join(' ')).toMatch(/No crawl has read any ports yet/);
  });

  it('includes only the sections chosen, and a changes section says when there is nothing to compare', () => {
    const verification = REPORT_TEMPLATES.find((t) => t.id === 'verification')!;
    const v = reportPages(input({ template: verification, sections: verification.sections }));
    const all = v.flatMap(text);
    expect(v.slice(1).flatMap(text)).not.toContain('Device inventory');
    expect(all.join(' ')).toMatch(/nothing earlier to compare with/);
    const withDiff = reportPages(input({ template: verification, sections: ['diffs'], diffs: [{ title: 'Validation sessions', rows: [{ subject: 'SW-1 Ping', change: 'Availability fell', before: '100%', after: '80%', tone: 'worse' }] }] }));
    expect(withDiff).toHaveLength(2);
    expect(withDiff.flatMap(text)).toContain('Availability fell');
  });

  it('has the four templates engineers are asked for', () => {
    expect(REPORT_TEMPLATES.map((t) => t.name)).toEqual(['Pre-change baseline', 'Post-change verification', 'Monthly health', 'New-site handover']);
  });

  it('wraps words to the width', () => {
    const lines = wrap('one two three four five six seven eight nine ten', 60, 10);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join(' ')).toBe('one two three four five six seven eight nine ten');
  });
});
