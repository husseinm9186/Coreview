/**
 * What is needed to open a shell on a device, and what to say when it is not
 * there.
 *
 * Right-click and **SSH to this device** has two ways of failing before
 * anything is sent: the device has no address, or it has no credential of its
 * own. Both are worth saying precisely — "connection failed" after a timeout,
 * for a device nobody ever gave a password to, is the wrong answer to the
 * wrong question.
 *
 * Pure, so the rules are tested without a network or a menu.
 */
import type { DeviceNodeData } from '../types/domain';

export type SshPlan =
  | { ok: true; address: string; credentialId: string; label: string; inherited: boolean }
  | { ok: false; reason: 'noAddress' | 'noCredential' };

/**
 * The address a session should dial.
 *
 * The primary address, where one is marked — the same address the device's own
 * check watches — then the first one that has anything in it. A hostname is
 * not used: the vault binds credentials by address, and a name that does not
 * resolve fails later and less clearly.
 */
export function sshAddress(d: DeviceNodeData): string {
  const addresses = d.addresses ?? [];
  const primary = addresses.find((a) => a.isPrimary && a.address.trim());
  const any = addresses.find((a) => a.address.trim());
  return (primary ?? any)?.address.trim() ?? '';
}

/** What the tab is called: the device's name, or failing that its address. */
export function sshLabel(d: DeviceNodeData): string {
  return d.hostname?.trim() || d.label?.trim() || sshAddress(d) || 'Device';
}

/**
 * Everything the command needs, or which half is missing.
 *
 * **A device with no login of its own inherits the project's**: "by
 * default all devices should inherit the global ssh and snmp password, admin
 * can override". The device's own credential wins where there is one, which is
 * what makes it an override rather than a second place to look.
 *
 * `projectSsh` is `credentialDefaults.ssh` — a vault id, never a secret.
 */
export function planSsh(d: DeviceNodeData, projectSsh?: string): SshPlan {
  const address = sshAddress(d);
  if (!address) return { ok: false, reason: 'noAddress' };
  const own = d.sshCredentialId?.trim();
  const credentialId = own || projectSsh?.trim();
  if (!credentialId) return { ok: false, reason: 'noCredential' };
  return { ok: true, address, credentialId, label: sshLabel(d), inherited: !own };
}
