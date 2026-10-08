import { describe, expect, it } from 'vitest';

import { readProfile, withProfile, type CrawlProfile } from './crawlProfiles';

const profile = (over: Partial<CrawlProfile> = {}): CrawlProfile => ({
  id: 'p1', name: 'Branch sites', seed: '192.0.2.1, 198.51.100.0/28', subnets: ['192.0.2.0/24'], maxHops: 3,
  preference: 'management', port: 22, transport: 'ssh', credentialId: 'cred-core', snmp: null,
  details: { routes: false, spanningTree: true, vlans: true, vrfs: false, overlay: false }, reverseDns: true, concurrency: 8,
  perHostTimeoutSecs: 120, retries: 2, secondFactor: false, hopThrough: false, ...over,
});

describe('crawl profiles', () => {
  it('reads back what was saved', () => {
    const p = profile();
    expect(readProfile(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it('keeps no secret, whatever was stored', () => {
    const stored = {
      ...profile(),
      password: 'hunter2',
      snmp: JSON.stringify([{ version: 'v3', user: 'reader', auth: 'sha', priv: 'aes 256', authPass: 'secret-1', privPass: 'secret-2', community: 'public', credentialId: null }]),
    };
    const read = readProfile(stored)!;
    expect(JSON.stringify(read)).not.toMatch(/hunter2|secret-1|secret-2|public/);
    expect(JSON.parse(read.snmp!)).toEqual([{ version: 'v3', user: 'reader', auth: 'sha', priv: 'aes 256', credentialId: null }]);
  });

  it('clamps numbers and falls back on unknown words', () => {
    const read = readProfile({ id: 'x', name: 'x', concurrency: 900, retries: -4, transport: 'carrier-pigeon', port: 'twenty' })!;
    expect(read.concurrency).toBe(32);
    expect(read.retries).toBe(0);
    expect(read.transport).toBe('ssh');
    expect(read.port).toBe(22);
    expect(readProfile({ id: 'x', name: '  ' })).toBeNull();
  });

  it('replaces a profile saved again under the same name, keeping its id', () => {
    const list = [profile()];
    const again = withProfile(list, profile({ id: 'new', name: 'branch SITES', retries: 0 }));
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe('p1');
    expect(again[0]!.retries).toBe(0);
    expect(withProfile(list, profile({ id: 'p2', name: 'Core' }))).toHaveLength(2);
  });
});

describe('a profile saved before the new tables existed', () => {
  it('means "do not ask", not "ask for everything new"', () => {
    // An older saved profile has no `vrfs` or `overlay` key at all. Defaulting
    // them on would silently start running commands somebody never chose.
    const older = JSON.parse('{"id":"p1","name":"Old","seed":"10.0.0.1","details":{"routes":true}}');
    const restored = readProfile(older);
    expect(restored?.details.vrfs).toBe(false);
    expect(restored?.details.overlay).toBe(false);
    // And what it did say is still honoured.
    expect(restored?.details.routes).toBe(true);
  });
});
