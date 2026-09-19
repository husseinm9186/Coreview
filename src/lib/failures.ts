import type { FailureKind } from './ipc';

/**
 * A crawl failure carries the address as its own field, and the reason is a
 * Rust error whose Display names the host so a log line reads on its own —
 * `192.168.77.112 rejected the credentials`. Rendering both produces
 * "192.168.77.112 — 192.168.77.112 rejected the credentials".
 *
 * Strip the address only where the reason starts with it, so what is left is
 * still a whole sentence. A reason that mentions the host mid-string
 * ("could not reach 192.168.77.9:22: connection refused") is left alone: it is
 * mildly redundant, and cutting a value out of the middle of a message is how
 * you end up rendering ":22: connection refused".
 */
export function reasonWithoutAddress(address: string, reason: string): string {
  if (!address || !reason.startsWith(address)) return reason;
  // The address has to end where it says it does: a bare prefix test turns
  // "192.168.77.11 rejected ..." into "1 rejected ..." when the address is
  // 192.168.77.1.
  const next = reason.charAt(address.length);
  if (next !== ' ') return reason;
  const rest = reason.slice(address.length).trimStart();
  // Only when a sentence remains. "192.168.77.9" alone would strip to nothing.
  return rest.length > 0 ? rest : reason;
}

/** What each kind of failure means, and what to do about it (LT-144).
 *
 *  The operator asked whether 8 seconds was too short for a normal device. It
 *  is not — a reachable device on a LAN answers in hundredths of a second,
 *  measured on his own subnet — so a timeout means the packets are being
 *  dropped, not that the device is slow. Saying "did not answer within 8s"
 *  invites the wrong fix; these say the right one.
 */
export function failureAdvice(kind: FailureKind | undefined): string {
  switch (kind) {
    case 'reachable-no-ssh':
      return 'Up, but did not take an SSH session — check SSH is enabled and reachable from here. A controller-managed access point usually offers none at all.';
    case 'unreachable':
      return 'Nothing answered SSH or a ping. It may be off, or on a network this machine cannot reach.';
    case 'refused':
      return 'Something is at this address, but nothing is listening on that port.';
    case 'auth-rejected':
      return 'The credentials were refused. Try another set.';
    case 'auth-timed-out':
      return 'Authentication was never completed — a push factor was not approved in time.';
    case 'no-prompt':
      return 'It accepted the session but never gave a prompt; it may not have a CLI.';
    case 'host-key-changed':
      return 'The host key has changed. Confirm why before logging in again.';
    case 'command-timed-out':
      return 'It answered, then stopped responding part way through.';
    default:
      return '';
  }
}

/** A short heading for a group of failures that share a kind. */
export function failureHeading(kind: FailureKind | undefined): string {
  switch (kind) {
    case 'reachable-no-ssh':
      return 'Up, but no SSH';
    case 'unreachable':
      return 'Nothing there';
    case 'refused':
      return 'Refused the connection';
    case 'auth-rejected':
      return 'Credentials refused';
    case 'auth-timed-out':
      return 'Second factor not approved';
    case 'no-prompt':
      return 'No command prompt';
    case 'host-key-changed':
      return 'Host key changed';
    case 'command-timed-out':
      return 'Stopped part way through';
    default:
      return 'Could not be reached';
  }
}
