import { describe, expect, it } from 'vitest';

import {
  overrideLabel,
  snmpDraft,
  snmpOverrideProblem,
  sshDraft,
  sshOverrideProblem,
} from './credentialOverride';

describe('naming a credential typed on a device', () => {
  it('says which device and which login, because the vault is shared', () => {
    expect(overrideLabel('ssh', 'core-sw-1', 'netadmin')).toBe('core-sw-1 — netadmin (SSH)');
  });

  it('still names something when the device has no name yet', () => {
    expect(overrideLabel('snmp', '  ', '')).toBe('A device (SNMP)');
  });
});

describe('what cannot be saved yet', () => {
  it('will not keep half an SSH login', () => {
    expect(sshOverrideProblem({ username: '  ', password: 'not-a-real-password' })).toMatch(/username/);
    expect(sshOverrideProblem({ username: 'netadmin', password: '' })).toMatch(/password/);
    expect(sshOverrideProblem({ username: 'netadmin', password: 'not-a-real-password' })).toBeNull();
  });

  it('wants a community for v2c and a user and auth password for v3', () => {
    expect(snmpOverrideProblem({ version: 'v2c' })).toMatch(/community/);
    expect(snmpOverrideProblem({ version: 'v2c', community: 'not-a-real-community' })).toBeNull();
    expect(snmpOverrideProblem({ version: 'v3', authPassword: 'not-a-real-password' })).toMatch(/user/);
    expect(snmpOverrideProblem({ version: 'v3', user: 'ops' })).toMatch(/authentication/);
  });

  it('refuses privacy without a privacy password, which fails as a wrong password', () => {
    const half = { version: 'v3' as const, user: 'ops', authPassword: 'not-a-real-password', privacy: 'aes 256' };
    expect(snmpOverrideProblem(half)).toMatch(/privacy password/);
    expect(snmpOverrideProblem({ ...half, privacyPassword: 'not-a-real-passphrase' })).toBeNull();
    expect(snmpOverrideProblem({ ...half, privacy: 'none' })).toBeNull();
  });
});

describe('the shape the vault stores, which the backend reads back', () => {
  it('keeps an SSH login with its enable password beside it', () => {
    expect(sshDraft('edge-fw', { username: ' netadmin ', password: 'not-a-real-password', enable: 'not-a-real-enable' }))
      .toEqual({
        label: 'edge-fw — netadmin (SSH)',
        kind: 'ssh',
        username: 'netadmin',
        secret: 'not-a-real-password',
        secondSecret: 'not-a-real-enable',
      });
  });

  it('leaves the enable password out rather than storing an empty one', () => {
    expect(sshDraft('edge-fw', { username: 'netadmin', password: 'not-a-real-password', enable: '' }).secondSecret)
      .toBeUndefined();
  });

  it('writes v2c as an empty username, which is how the backend tells them apart', () => {
    // vault_commands::snmp_credentials: `if stored.username.is_empty()` is the
    // whole of the version test, so an empty username is load-bearing.
    expect(snmpDraft('access-sw', { version: 'v2c', community: 'not-a-real-community' })).toEqual({
      label: 'access-sw (SNMP)',
      kind: 'snmp',
      username: '',
      secret: 'not-a-real-community',
    });
  });

  it('writes v3 with the algorithm words in clear, because they are not secret', () => {
    expect(
      snmpDraft('access-sw', {
        version: 'v3',
        user: 'ops',
        auth: 'sha256',
        authPassword: 'not-a-real-password',
        privacy: 'aes 256',
        privacyPassword: 'not-a-real-passphrase',
      }),
    ).toEqual({
      label: 'access-sw — ops (SNMP)',
      kind: 'snmp',
      username: 'ops',
      secret: 'not-a-real-password',
      secondSecret: 'not-a-real-passphrase',
      detail: 'sha256|aes 256',
    });
  });

  it('records no privacy rather than "none", which the backend parses as none', () => {
    const d = snmpDraft('access-sw', {
      version: 'v3', user: 'ops', auth: 'sha', authPassword: 'not-a-real-password',
      privacy: 'none', privacyPassword: 'ignored',
    });
    expect(d.detail).toBe('sha|');
    expect(d.secondSecret).toBeUndefined();
  });
});
