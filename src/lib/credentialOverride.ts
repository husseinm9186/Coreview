/**
 * A login typed against one device, turned into a vault record.
 *
 * The inspector could already *choose* a saved credential for a device, which
 * is no use until one exists — and making one meant leaving the device, going
 * to Settings, and building it by hand. This is the other half: type the
 * username and password on the device itself, press Save, and it goes into the
 * same encrypted vault with the same id written on the node (the
 * secret never touches the document).
 *
 * The shaping is pure so the SNMP encoding is tested without a form. It has to
 * match `vault_commands::snmp_credentials`, which reads a saved SNMP
 * credential back: an empty username means v2c and the secret is the
 * community; otherwise it is v3, the secret is the auth password, the second
 * secret is the privacy password, and `detail` carries the two algorithm words
 * — which are not secret — as `auth|privacy`.
 */
export interface SshOverride {
  username: string;
  password: string;
  /** The enable/second password, where a device wants one. */
  enable?: string;
}

export interface SnmpOverride {
  version: 'v2c' | 'v3';
  /** v2c only. */
  community?: string;
  /** v3 only. */
  user?: string;
  auth?: string;
  authPassword?: string;
  privacy?: string;
  privacyPassword?: string;
}

/** What `ipc.saveCredential` is given, minus the id. */
export interface CredentialDraft {
  label: string;
  kind: 'ssh' | 'snmp' | 'sftp';
  username: string;
  secret: string;
  secondSecret?: string;
  detail?: string;
}

/**
 * What a saved credential is called in the vault list.
 *
 * It names the device, because the vault is shared by every project on the
 * machine and "admin" six times over tells nobody which switch is which. No
 * address is used when a name exists: a device that moves keeps its label.
 */
export function overrideLabel(kind: 'ssh' | 'snmp' | 'sftp', device: string, username: string): string {
  const who = username.trim();
  const what = device.trim() || 'A device';
  const suffix = kind === 'ssh' ? 'SSH' : kind === 'sftp' ? 'SFTP' : 'SNMP';
  return who ? `${what} — ${who} (${suffix})` : `${what} (${suffix})`;
}

/** Why this SSH override cannot be saved yet, or null. */
export function sshOverrideProblem(o: SshOverride): string | null {
  if (!o.username.trim()) return 'Give the username to log in with.';
  if (!o.password) return 'Give the password.';
  return null;
}

/** Why this SNMP override cannot be saved yet, or null. */
export function snmpOverrideProblem(o: SnmpOverride): string | null {
  if (o.version === 'v2c') {
    return o.community?.trim() ? null : 'Give the community string.';
  }
  if (!o.user?.trim()) return 'Give the v3 user.';
  if (!o.authPassword) return 'Give the authentication password.';
  // A privacy algorithm with no passphrase authenticates and then fails to
  // decrypt, which reads on the device as a wrong password.
  if (o.privacy && o.privacy !== 'none' && !o.privacyPassword) {
    return 'Give the privacy password, or set privacy to none.';
  }
  return null;
}

export function sshDraft(device: string, o: SshOverride): CredentialDraft {
  return {
    label: overrideLabel('ssh', device, o.username),
    kind: 'ssh',
    username: o.username.trim(),
    secret: o.password,
    secondSecret: o.enable || undefined,
  };
}

/** An SFTP server's login: a username and a password, nothing to enable. */
export function sftpDraft(device: string, o: SshOverride): CredentialDraft {
  return {
    label: overrideLabel('sftp', device, o.username),
    kind: 'sftp',
    username: o.username.trim(),
    secret: o.password,
  };
}

export function snmpDraft(device: string, o: SnmpOverride): CredentialDraft {
  if (o.version === 'v2c') {
    // Username empty is what tells the backend this is v2c. The community is
    // the secret; there is nothing else to say.
    return { label: overrideLabel('snmp', device, ''), kind: 'snmp', username: '', secret: o.community ?? '' };
  }
  const privacy = o.privacy && o.privacy !== 'none' ? o.privacy : '';
  return {
    label: overrideLabel('snmp', device, o.user ?? ''),
    kind: 'snmp',
    username: (o.user ?? '').trim(),
    secret: o.authPassword ?? '',
    secondSecret: privacy ? o.privacyPassword || undefined : undefined,
    detail: `${o.auth || 'sha'}|${privacy}`,
  };
}
