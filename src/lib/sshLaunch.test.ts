import { describe, expect, it } from 'vitest';

import { planSsh, sshAddress, sshLabel } from './sshLaunch';
import type { DeviceNodeData } from '../types/domain';

const device = (over: Partial<DeviceNodeData> = {}): DeviceNodeData =>
  ({ label: 'SW-A', deviceType: 'access-switch', tags: [], ...over }) as DeviceNodeData;

const at = (address: string, isPrimary = false) => ({ id: address, label: '', address, isPrimary });

describe('which address a session dials (LT-320)', () => {
  it('takes the primary one, the same one the device’s own check watches', () => {
    expect(sshAddress(device({ addresses: [at('192.0.2.9'), at('192.0.2.10', true)] }))).toBe('192.0.2.10');
  });

  it('falls back to the first that has anything in it', () => {
    expect(sshAddress(device({ addresses: [at('  '), at('192.0.2.11')] }))).toBe('192.0.2.11');
  });

  it('has nothing to dial when the device has no address', () => {
    expect(sshAddress(device({ addresses: [] }))).toBe('');
  });
});

describe('what the tab is called', () => {
  it('prefers the name the device gave itself', () => {
    expect(sshLabel(device({ hostname: 'CORE-SW1', addresses: [at('192.0.2.10')] }))).toBe('CORE-SW1');
  });

  it('then the label on the diagram, then the address', () => {
    expect(sshLabel(device({ addresses: [at('192.0.2.10')] }))).toBe('SW-A');
    expect(sshLabel(device({ label: '', addresses: [at('192.0.2.10')] }))).toBe('192.0.2.10');
  });
});

describe('what stops a session before anything is sent', () => {
  it('says which half is missing rather than letting it time out', () => {
    expect(planSsh(device({ addresses: [] }))).toEqual({ ok: false, reason: 'noAddress' });
    expect(planSsh(device({ addresses: [at('192.0.2.10')] }))).toEqual({ ok: false, reason: 'noCredential' });
  });

  it('and hands over the address, the credential id and the name when both are there', () => {
    expect(planSsh(device({ hostname: 'CORE-SW1', addresses: [at('192.0.2.10', true)], sshCredentialId: 'cred-1' })))
      .toEqual({ ok: true, address: '192.0.2.10', credentialId: 'cred-1', label: 'CORE-SW1', inherited: false });
  });

  it('does not accept a credential id that is only spaces', () => {
    expect(planSsh(device({ addresses: [at('192.0.2.10')], sshCredentialId: '   ' })))
      .toEqual({ ok: false, reason: 'noCredential' });
  });
});

describe('a device with no login of its own inherits the project\u2019s (LT-330)', () => {
  const plain = device({ addresses: [at('192.0.2.10', true)] });

  it('falls back to the project, and says that is what happened', () => {
    expect(planSsh(plain, 'project-cred')).toEqual({
      ok: true, address: '192.0.2.10', credentialId: 'project-cred', label: 'SW-A', inherited: true,
    });
  });

  it('but the device\u2019s own wins, which is what makes it an override', () => {
    const own = device({ addresses: [at('192.0.2.10', true)], sshCredentialId: 'its-own' });
    expect(planSsh(own, 'project-cred')).toMatchObject({ credentialId: 'its-own', inherited: false });
  });

  it('and with neither there is still nothing to try', () => {
    expect(planSsh(plain, '   ')).toEqual({ ok: false, reason: 'noCredential' });
    expect(planSsh(plain)).toEqual({ ok: false, reason: 'noCredential' });
  });
});
