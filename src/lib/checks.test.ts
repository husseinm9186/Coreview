import { describe, expect, it } from 'vitest';

import {
  isComplete,
  newCheck,
  orderResults,
  parseChecks,
  serializeChecks,
  summarise,
  type BackupCheck,
  type CheckResult,
} from './checks';

// Invented for the test (D-027).
const check = (over: Partial<BackupCheck>): BackupCheck => ({
  id: 'c', name: '', command: 'show version', expect: 'contains', pattern: 'x', ignoreCase: false, ...over,
});
const result = (device: string, checkId: string, verdict: CheckResult['verdict']): CheckResult => ({
  device, checkId, verdict, line: null, evidence: null, why: '',
});

describe('checks (LT-153)', () => {
  it('a new check starts empty and is not ready to run', () => {
    const c = newCheck();
    expect([c.name, c.command, c.pattern]).toEqual(['', '', '']);
    expect(c.expect).toBe('contains');
    expect(isComplete(c)).toBe(false);
    expect(isComplete(check({}))).toBe(true);
    expect(isComplete(check({ command: '  ' }))).toBe(false);
  });

  it('round-trips through the stored setting and drops anything malformed', () => {
    const checks = [check({ id: 'a', name: 'Default route', expect: 'notMatches', ignoreCase: true })];
    expect(parseChecks(serializeChecks(checks))).toEqual(checks);
    expect(serializeChecks([])).toBeNull();
    expect(parseChecks('nope')).toEqual([]);
    expect(parseChecks('[{"id":"k","expect":"reload","ignoreCase":"yes"}]')).toEqual([
      { id: 'k', name: '', command: '', expect: 'contains', pattern: '', ignoreCase: false },
    ]);
    expect(parseChecks('[{"id":"d"},{"id":"d"},{"name":"no id"}]')).toHaveLength(1);
  });

  it('counts every verdict', () => {
    expect(
      summarise([result('A', 'a', 'pass'), result('A', 'b', 'fail'), result('B', 'a', 'fail'), result('B', 'b', 'notCaptured')]),
    ).toEqual({ pass: 1, fail: 2, notCaptured: 1, rejected: 0 });
  });

  it('puts failures first, then refusals, gaps and passes, by device and check order', () => {
    const checks = [check({ id: 'second' }), check({ id: 'first' })].reverse();
    const ordered = orderResults(
      [
        result('B', 'first', 'pass'),
        result('B', 'second', 'fail'),
        result('A', 'second', 'notCaptured'),
        result('A', 'first', 'fail'),
        result('A', 'second', 'rejected'),
      ],
      checks,
    );
    expect(ordered.map((r) => `${r.verdict}:${r.device}:${r.checkId}`)).toEqual([
      'fail:A:first',
      'fail:B:second',
      'rejected:A:second',
      'notCaptured:A:second',
      'pass:B:first',
    ]);
  });
});
