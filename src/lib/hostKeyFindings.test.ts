import { describe, expect, it } from 'vitest';
import { crawlFindings, FINDING_LABEL, firstSeenKeyFindings } from './crawlFindings';

describe('first contact is a finding', () => {
  it('writes one informational finding per key trusted for the first time, after the faults', () => {
    const keys = [
      { host: '192.0.2.1', port: 22, fingerprint: 'SHA256:0zaqrPUcHnE0V0z+kM4ZmJmS7nDBn/8P9wYc4bTGf2E' },
      { host: '192.0.2.2', port: 2222, fingerprint: 'SHA256:9xyzQQQQQnE0V0z+kM4ZmJmS7nDBn/8P9wYc4bTGf2E' },
    ];
    const found = firstSeenKeyFindings(keys);
    expect(found.map((f) => [f.kind, f.severity, f.devices])).toEqual([
      ['host-key-new', 'info', ['192.0.2.1']],
      ['host-key-new', 'info', ['192.0.2.2']],
    ]);
    expect(found[0]?.message).toMatch(/^192\.0\.2\.1 was trusted on first contact; its key is SHA256:0zaq/);
    expect(found[1]?.message).toMatch(/^192\.0\.2\.2:2222 was trusted/);
    expect(FINDING_LABEL['host-key-new']).toBe('First contact');
    // Through the whole engine, with nothing else to report: still there, and last.
    const all = crawlFindings({ devices: [], firstSeenKeys: keys });
    expect(all.map((f) => f.kind)).toEqual(['host-key-new', 'host-key-new']);
    expect(crawlFindings({ devices: [] })).toEqual([]);
  });
});
