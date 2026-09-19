/**
 * The Backups tab's show-command capture, the parts with no network in them
 * (LT-149).
 *
 * Deliberately **no** built-in command lists. Coreview is given away, and a
 * preset lifted from any real project is exactly what D-027 forbids; the
 * operator writes his own. What is here is vendor fact: each platform's own
 * session-only command for switching paging off.
 *
 * The labels mirror `showcmd::Paging` in the Rust crate, which is authoritative
 * — it is what decides what is actually sent.
 */
export type PagingMode =
  | 'auto'
  | 'cisco-ios'
  | 'cisco-asa'
  | 'palo-alto'
  | 'forti-os'
  | 'aruba-hp'
  | 'juniper'
  | 'huawei-h3c'
  | 'none';

export const PAGING_CHOICES: { value: PagingMode; label: string; sends: string }[] = [
  { value: 'auto', label: 'Automatic', sends: 'terminal length 0 at login, and any --More-- is answered' },
  { value: 'cisco-ios', label: 'Cisco IOS / IOS-XE / NX-OS', sends: 'terminal length 0' },
  { value: 'cisco-asa', label: 'Cisco ASA / FTD', sends: 'terminal pager 0' },
  { value: 'palo-alto', label: 'Palo Alto', sends: 'set cli pager off' },
  {
    value: 'forti-os',
    label: 'FortiOS',
    sends: 'nothing — FortiOS has no session-only pager command, so --More-- is answered instead',
  },
  { value: 'aruba-hp', label: 'Aruba / HP', sends: 'no page' },
  { value: 'juniper', label: 'Juniper', sends: 'set cli screen-length 0' },
  { value: 'huawei-h3c', label: 'Huawei / H3C', sends: 'screen-length 0 temporary' },
  { value: 'none', label: 'Nothing extra', sends: 'nothing beyond the login default' },
];

export function isPagingMode(value: unknown): value is PagingMode {
  return PAGING_CHOICES.some((c) => c.value === value);
}

/** One command per line: trimmed, blanks and repeats dropped, order kept. */
export function parseCommandList(text: string | undefined | null): string[] {
  const out: string[] = [];
  for (const line of (text ?? '').split(/\r?\n/)) {
    const c = line.trim();
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
