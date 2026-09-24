import { describe, expect, it } from 'vitest';

import type { MerakiCheck, MerakiProfile, MerakiReport, MerakiStatus } from './ipc';
import { actionItems, reportFilename, reportSvg, statusLabel, tally, STATUS_ORDER } from './merakiReport';

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
    num: '1.1',
    title: 'A check',
    navigation: 'Dashboard › Somewhere',
    summary: 'Something was found.',
    observations: [],
    details: [],
    action: null,
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

describe('the Meraki health report (LT-406)', () => {
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

  it('lists only actions as action items, and still keeps advisories in the report', () => {
    const r = report([
      check({ id: 'a', status: 'attention', title: 'Uplinks', findings: [{ code: 'uplink.down', severity: 'action' }] }),
      check({ id: 'b', status: 'advisory', title: 'IDS', findings: [{ code: 'ids.disabled', severity: 'advisory' }] }),
    ]);
    const actions = actionItems(r);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.check).toBe('Uplinks');
    // Nothing is hidden: the advisory is still one of the report's checks.
    expect(r.checks).toHaveLength(2);
  });

  it('says "Not reported" rather than anything that sounds like homework', () => {
    // The rename his script had to make: "Manual review" read as a task for
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
      expect(svg).toContain('What this is built from');
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
      expect(svg).toContain('Action items: none');
    });
  });
});
