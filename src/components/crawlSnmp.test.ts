import { describe, expect, it } from 'vitest';

import { restoreSnmpRows, snmpRowsForRun, snmpRowsShape } from './CrawlPanel';

const row = (over: Record<string, unknown> = {}) => ({
  key: 'k',
  version: 'v2c' as const,
  community: '',
  user: '',
  auth: 'sha',
  authPass: '',
  priv: 'aes 256',
  privPass: '',
  credentialId: null as string | null,
  ...over,
});

describe('several SNMP credentials (LT-142)', () => {
  it('sends v2c and v3 together, in the order they were entered', () => {
    const { typed } = snmpRowsForRun([
      row({ version: 'v2c', community: 'public' }),
      row({ version: 'v3', user: 'LABUSR', authPass: 'x', priv: 'aes 256', privPass: 'y' }),
    ]);
    expect(typed).toHaveLength(2);
    expect(typed[0]).toEqual({ version: 'v2c', community: 'public' });
    expect(typed[1]).toMatchObject({ version: 'v3', username: 'LABUSR', privacy: 'aes 256' });
  });

  it('drops a half-filled row rather than failing on every device', () => {
    // A v3 user with no password fails identically to a wrong password, so
    // sending it would make every device look like it refused.
    const { typed } = snmpRowsForRun([
      row({ version: 'v3', user: 'LABUSR' }),
      row({ version: 'v2c', community: '   ' }),
      row(),
    ]);
    expect(typed).toEqual([]);
  });

  it('sends a saved credential by id and never its secrets', () => {
    const { typed, savedIds } = snmpRowsForRun([
      row({ credentialId: 'vault-1', community: 'should-be-ignored' }),
    ]);
    expect(savedIds).toEqual(['vault-1']);
    expect(typed).toEqual([]);
  });

  it('never writes a community or a passphrase into the saved shape', () => {
    // The settings table is plain text beside the projects.
    const shape = snmpRowsShape([
      row({ version: 'v2c', community: 'PLAINTEXT-COMMUNITY' }),
      row({ version: 'v3', user: 'LABUSR', authPass: 'PLAINTEXT-AUTH', privPass: 'PLAINTEXT-PRIV' }),
    ]);
    expect(shape).not.toContain('PLAINTEXT-COMMUNITY');
    expect(shape).not.toContain('PLAINTEXT-AUTH');
    expect(shape).not.toContain('PLAINTEXT-PRIV');
    // What it does keep is the shape, which is not secret.
    expect(shape).toContain('LABUSR');
    expect(shape).toContain('aes 256');
  });

  it('comes back with the secrets empty and the shape intact', () => {
    const back = restoreSnmpRows(
      snmpRowsShape([
        row({ version: 'v3', user: 'LABUSR', auth: 'sha', priv: 'aes 256', authPass: 'gone' }),
        row({ credentialId: 'vault-2' }),
      ]),
    );
    expect(back).toHaveLength(2);
    expect(back[0]!.user).toBe('LABUSR');
    expect(back[0]!.version).toBe('v3');
    expect(back[0]!.authPass).toBe('');
    expect(back[1]!.credentialId).toBe('vault-2');
  });

  it('survives nonsense in the settings table', () => {
    // Hand-edited, half-written, or from an older version.
    expect(restoreSnmpRows('')).toEqual([]);
    expect(restoreSnmpRows('not json')).toEqual([]);
    expect(restoreSnmpRows('{"not":"an array"}')).toEqual([]);
    expect(restoreSnmpRows('[null]')).toHaveLength(1);
    expect(restoreSnmpRows('[{"version":"nonsense"}]')[0]!.version).toBe('v2c');
  });
});
