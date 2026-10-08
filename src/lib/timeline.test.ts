import { describe, expect, it } from 'vitest';
import { byRun, changeWords, sinceLastLine, timelineCsv, timelineMarkdown } from './timeline';
import type { TimelineEntry } from './ipc';

const e = (runId: string, takenAt: number, device: string, field: string, was: string | null, now: string | null, source: string | null = 'ssh'): TimelineEntry => ({
  runId, takenAt, device, field, was, now, source,
});

describe('the change timeline', () => {
  const entries = [
    e('r2', 2_000, 'CORE', 'version', '15.2(7)E4', '15.2(7)E8', 'ssh:show version'),
    e('r2', 2_000, 'ACCESS-2', 'appeared', null, 'ACCESS-2', 'reported'),
    e('r3', 3_000, 'CORE', 'neighbour', 'ACCESS-1 on Gi1/0/1', null),
    e('r3', 3_000, '=EVIL', 'restarted', '1000s', '40s', 'snmp:sysUpTime'),
  ];
  const when = (ms: number) => `t${ms}`;

  it('groups by run, newest first, keeping each run\'s order', () => {
    const groups = byRun(entries);
    expect(groups.map((g) => g.runId)).toEqual(['r3', 'r2']);
    expect(groups[1]?.entries.map((x) => x.device)).toEqual(['CORE', 'ACCESS-2']);
  });

  it('says what the newest run changed, or that there is nothing to compare', () => {
    expect(sinceLastLine({}, 1)).toBe('One crawl so far — a second one is what makes a change visible.');
    expect(sinceLastLine({}, 3)).toBe('Nothing changed since your last crawl.');
    expect(sinceLastLine({ neighbour: 2, appeared: 1 }, 3)).toBe('Since your last crawl: 2 neighbour, 1 appeared.');
  });

  it('writes the change as an arrow, a plus or a minus', () => {
    expect(changeWords(entries[0]!)).toBe('15.2(7)E4 → 15.2(7)E8');
    expect(changeWords(entries[1]!)).toBe('+ ACCESS-2');
    expect(changeWords(entries[2]!)).toBe('− ACCESS-1 on Gi1/0/1');
  });

  it('saves as CSV with the source in words and a formula guard, and as Markdown by run', () => {
    const csv = timelineCsv(entries, when);
    expect(csv.split('\r\n')[1]).toBe('t2000,CORE,software,15.2(7)E4,15.2(7)E8,show version over SSH');
    expect(csv).toContain("t3000,'=EVIL,restarted,1000s,40s,SNMP sysUpTime");
    const md = timelineMarkdown('Changes', entries, when);
    expect(md).toContain('## t3000');
    expect(md).toContain('| CORE | neighbour | − ACCESS-1 on Gi1/0/1 | ssh |');
    expect(md.indexOf('## t3000')).toBeLessThan(md.indexOf('## t2000'));
  });
});
