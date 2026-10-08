import { describe, expect, it } from 'vitest';

import type { MerakiCheck, MerakiProfile, MerakiReport, MerakiSection, MerakiStatus } from './ipc';
import {
  actionItems,
  advisoryItems,
  reportFilename,
  reportSvg,
  sectionTitle,
  statusLabel,
  tally,
  STATUS_ORDER,
} from './merakiReport';

const profile: MerakiProfile = {
  id: 'smb',
  label: 'Small business',
  summary: 'Only faults that affect service count as actions.',
  thresholds: {
    latencyMs: 250, lossPct: 3, chanUtilPct: 65, nonWifiPct: 30,
    wifiFailPct: 15, clientFailCount: 5, licenceDays: 30, stpEventCount: 20,
  },
  defaultSeverity: 'advisory',
  actions: ['uplink.down'],
};

function check(over: Partial<MerakiCheck> & { id: string; status: MerakiStatus }): MerakiCheck {
  return {
    section: 'firewall' as MerakiSection,
    num: '1',
    title: 'A check',
    navigation: 'Security & SD-WAN > Somewhere',
    checklist: ['What this item covers'],
    summary: 'Something was found.',
    observations: [],
    details: [],
    steps: [],
    findings: [],
    ...over,
  };
}

function report(checks: MerakiCheck[], over: Partial<MerakiReport> = {}): MerakiReport {
  return {
    takenAt: '2026-09-23T10:15:00Z',
    organization: 'Example Group',
    network: 'Head Office',
    profile,
    checks,
    dataWindows: 'settings as they are now; clients over 24 hours.',
    ...over,
  };
}

describe('the Meraki health report', () => {
  it('counts every verdict, including the ones with none', () => {
    const counted = tally(
      report([
        check({ id: 'a', status: 'attention' }),
        check({ id: 'b', status: 'attention' }),
        check({ id: 'c', status: 'pass' }),
      ]),
    );
    // Every status appears, so a zero is visible rather than absent — "no
    // advisories" is a result and should be shown as one.
    expect(counted.map((c) => c.status)).toEqual(STATUS_ORDER);
    expect(counted).toEqual([
      { status: 'attention', count: 2 },
      { status: 'advisory', count: 0 },
      { status: 'manual', count: 0 },
      { status: 'pass', count: 1 },
      { status: 'na', count: 0 },
    ]);
  });

  it('separates actions from advisories, and hides neither', () => {
    const r = report([
      check({ id: 'a', status: 'attention', title: 'Uplinks', steps: ['Check the WAN lead.', 'Then the ISP.'] }),
      check({ id: 'b', status: 'advisory', title: 'IDS', steps: ['Set IDS to prevention.'] }),
      check({ id: 'c', status: 'pass', title: 'Licensing' }),
    ]);
    const actions = actionItems(r);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.check.title).toBe('Uplinks');
    // The first step is what the summary table shows — it is the one a
    // reader acts on before opening the item.
    expect(actions[0]!.step).toBe('Check the WAN lead.');

    const advisories = advisoryItems(r);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.check.title).toBe('IDS');

    // Nothing is hidden: all three are still in the report.
    expect(r.checks).toHaveLength(3);
  });

  it('names the three checklists the way the health check list does', () => {
    expect(sectionTitle('firewall')).toBe('Firewall (MX) Health Check');
    expect(sectionTitle('wireless')).toBe('Wireless Health Check');
    expect(sectionTitle('switching')).toBe('Switch Health Check');
  });

  it('says "Not reported" rather than anything that sounds like homework', () => {
    // The rename the health-check script had to make: "Manual review" read as a task for
    // whoever opened the report, when it means the API did not answer.
    expect(statusLabel('manual')).toBe('Not reported');
    expect(statusLabel('na')).toBe('Not applicable');
    expect(statusLabel('pass')).toBe('OK');
    expect(statusLabel('attention')).toBe('Needs attention');
  });

  it('names the saved file after the customer, the network and the day', () => {
    expect(reportFilename(report([]))).toBe('example-group-head-office-health-2026-09-23.pdf');
  });

  it('survives a customer name that is punctuation and nothing else', () => {
    const name = reportFilename(report([], { organization: '!!!', network: '***' }));
    expect(name).toBe('meraki-meraki-health-2026-09-23.pdf');
    expect(name).not.toContain('/');
  });

  describe('the PDF drawing', () => {
    it('is a whole SVG carrying the report', () => {
      const svg = reportSvg(
        report([
          check({ id: 'a', status: 'attention', title: 'Uplinks', summary: 'An uplink is down.', findings: [{ code: 'uplink.down', severity: 'action' }] }),
          check({ id: 'b', status: 'pass', num: '1.2', title: 'Licensing', summary: 'Licensing is in order.' }),
        ]),
      );
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
      expect(svg).toContain('Example Group');
      expect(svg).toContain('Head Office');
      expect(svg).toContain('Small business');
      expect(svg).toContain('Uplinks');
      expect(svg).toContain('Licensing');
      // The window each number was read over travels with it.
      expect(svg).toContain('Data used:');
      // And the document's own front matter.
      expect(svg).toContain('How to read this report');
      expect(svg).toContain('Results at a glance');
      expect(svg).toContain('Networks assessed');
    });

    it('escapes a customer name that would otherwise break the XML', () => {
      // An organisation name comes from the API — a customer's own string,
      // never one Coreview wrote — and lands in markup.
      const svg = reportSvg(report([], { organization: 'A & B <Ltd>', network: '"HQ"' }));
      expect(svg).toContain('A &amp; B &lt;Ltd&gt;');
      expect(svg).not.toContain('<Ltd>');
      // Still one well-formed element.
      expect(svg.match(/<svg/g)).toHaveLength(1);
    });

    it('grows the page rather than clipping a long report', () => {
      const short = reportSvg(report([check({ id: 'a', status: 'pass' })]));
      const many = Array.from({ length: 60 }, (_, i) =>
        check({ id: `c${i}`, num: `9.${i}`, status: 'attention', summary: 'A fairly long summary line that will wrap more than once when it is drawn onto the page.', findings: [{ code: 'uplink.down', severity: 'action' }] }),
      );
      const long = reportSvg(report(many));
      const heightOf = (svg: string) => Number(/height="(\d+)"/.exec(svg)![1]);
      expect(heightOf(long)).toBeGreaterThan(heightOf(short));
      // And the last check is actually on it.
      expect(long).toContain('9.59');
    });

    it('draws an empty report without failing', () => {
      // A key that can reach a network and read nothing still produces a
      // report, and it must still be a page.
      const svg = reportSvg(report([]));
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('Nothing in this network needs attention');
    });

    it('carries what each item covers and what to do, not only the verdict', () => {
      const svg = reportSvg(
        report([
          check({
            id: 'a',
            section: 'switching',
            num: '2',
            status: 'attention',
            title: 'Port Status and Utilization',
            navigation: 'Switch > Switch ports',
            checklist: ['Errors: CRCs, collisions, STP changes'],
            summary: 'Two ports are reporting errors.',
            observations: ['Both are on the same switch.'],
            steps: ['Re-seat both ends of the patch lead, clear the counters, then watch for an hour.'],
          }),
        ]),
      );
      expect(svg).toContain('Switch Health Check');
      expect(svg).toContain('Navigation:');
      expect(svg).toContain('Checklist');
      expect(svg).toContain('Errors: CRCs, collisions, STP changes');
      expect(svg).toContain('Observed');
      expect(svg).toContain('Recommended action');
      expect(svg).toContain('Re-seat both ends');
    });

    it('never names the tool that made it', () => {
      // His script says it outright: the document carries the customer's
      // names and nothing else. It is the customer's report.
      const svg = reportSvg(
        report([check({ id: 'a', status: 'attention', steps: ['Do the thing.'] })]),
      );
      expect(svg).not.toContain('Coreview');
      expect(svg).not.toContain('coreview');
    });
  });
});
