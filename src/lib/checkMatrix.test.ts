import { describe, expect, it } from 'vitest';
import { checkMatrix, matrixCsv, matrixMarkdown, parseChecks, type BackupCheck, type CheckResult } from './checks';

const chk = (id: string, name: string, severity: BackupCheck['severity'] = 'warning'): BackupCheck => ({
  id, name, command: 'show running-config', expect: 'contains', pattern: 'x', ignoreCase: false, block: '', severity, roles: [],
});
const res = (device: string, checkId: string, verdict: CheckResult['verdict'], severity: CheckResult['severity'] = 'warning'): CheckResult => ({
  device, checkId, verdict, severity, block: null, line: null, evidence: null, why: '',
});

describe('the check matrix', () => {
  const checks = [chk('a', 'NTP set', 'critical'), chk('b', 'BPDU guard'), chk('c', 'Banner', 'info')];
  const results = [
    res('EDGE', 'a', 'pass'), res('EDGE', 'b', 'fail'), res('EDGE', 'c', 'notApplicable'),
    res('CORE', 'a', 'fail', 'critical'), res('CORE', 'b', 'pass'),
    res('ACCESS', 'a', 'pass'), res('ACCESS', 'b', 'pass'), res('ACCESS', 'c', 'notCaptured'),
  ];

  it('puts the worst failures first and keeps the checks in their listed order', () => {
    const m = checkMatrix(results, checks);
    expect(m.rows.map((r) => r.device)).toEqual(['CORE', 'EDGE', 'ACCESS']);
    expect(m.rows[0]?.worst).toBe('critical');
    expect(m.rows[1]?.worst).toBe('warning');
    expect(m.rows[2]?.worst).toBeNull();
    // CORE has no result for check c: an empty cell, not a made-up one.
    expect(m.rows[0]?.cells.map((c) => c?.verdict ?? null)).toEqual(['fail', 'pass', null]);
  });

  it('writes CSV with the severity in the heading and a guard on device names', () => {
    const csv = matrixCsv(checkMatrix([...results, res('=cmd|x', 'a', 'pass')], checks));
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Device,NTP set (critical),BPDU guard (warning),Banner (info)');
    expect(lines[1]).toBe('CORE,FAIL,pass,');
    expect(csv).toContain("'=cmd|x,pass,,");
  });

  it('writes a Markdown table with a heading that names the run', () => {
    const md = matrixMarkdown(checkMatrix(results, checks), '20260901-090000');
    expect(md.startsWith('# Checks against run 20260901-090000\n\n3 devices, 2 with at least one failure.')).toBe(true);
    expect(md).toContain('| CORE | FAIL | pass |  |');
    expect(md).toContain('| ACCESS | pass | pass | not captured |');
  });

  it('reads a stored check without the new fields as a whole-output warning for every role', () => {
    const [c] = parseChecks(JSON.stringify([{ id: 'k', command: 'show version', expect: 'contains', pattern: '15.2' }]));
    expect(c).toMatchObject({ block: '', severity: 'warning', roles: [] });
    const [d] = parseChecks(JSON.stringify([{ id: 'k', command: 'x', expect: 'contains', pattern: 'y', block: 'interface', severity: 'critical', roles: ['switch', 3, ''] }]));
    expect(d).toMatchObject({ block: 'interface', severity: 'critical', roles: ['switch'] });
  });
});
