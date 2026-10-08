import { describe, expect, it } from 'vitest';
import { sourceWords, whySays } from './evidence';

describe('why a device says what it says', () => {
  const now = 10 * 60 * 60 * 1000;

  it('says nothing where there is no evidence, rather than inventing a source', () => {
    expect(whySays(undefined, 'class')).toBeNull();
    expect(whySays({ platform: { source: 'prompt' } }, 'class')).toBeNull();
  });

  it('writes one sentence with the source, the reporter and the time', () => {
    const evidence = {
      class: { source: 'neighbour-report', seenBy: 'CORE-SW1', seenAtMs: now - 5 * 60_000, detail: 'cisco WS-C2960' },
      uptime: { source: 'snmp:sysUpTime', seenAtMs: now - 3 * 60 * 60_000 },
      hostname: { source: 'prompt', detail: 'EDGE-RTR1' },
    };
    expect(whySays(evidence, 'class', now)).toBe(
      'Read from a neighbour’s advertisement, reported by CORE-SW1, 5 minutes ago. It said: cisco WS-C2960',
    );
    expect(whySays(evidence, 'uptime', now)).toBe('Read from SNMP sysUpTime, 3 hours ago.');
    expect(whySays(evidence, 'hostname', now)).toBe('Read from the device’s own prompt. It said: EDGE-RTR1');
  });

  it('shows an unknown source as it is, so a new one is never hidden', () => {
    expect(sourceWords('ssh:show inventory')).toBe('ssh:show inventory');
    expect(whySays({ serial: { source: 'ssh:show inventory' } }, 'serial', now)).toBe('Read from ssh:show inventory.');
  });
});
