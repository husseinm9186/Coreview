/**
 * Capture filename patterns (LT-151), the parts with no filesystem in them.
 *
 * `backup::render_filename` in the Rust crate is authoritative — it is what
 * names the file, and it refuses a bad pattern before anything connects. This
 * mirrors its rules so the Backups tab can show a preview and say what is
 * wrong while the pattern is being typed, rather than after Back up.
 */

export const DEFAULT_FILE_PATTERN = '{stamp}-{kind}';

export const FILE_TOKENS: { token: string; means: string }[] = [
  { token: '{stamp}', means: 'date and time of the run, 20260828-101530 — required' },
  { token: '{kind}', means: 'running-config, startup-config or show-commands — required' },
  { token: '{device}', means: "the device's name" },
  { token: '{address}', means: "the device's address" },
  { token: '{site}', means: "the device's Site, or the project's" },
  { token: '{date}', means: 'the date alone, 2026-08-28' },
];

export type CaptureKind = 'running-config' | 'startup-config' | 'show-commands';

const KINDS: CaptureKind[] = ['running-config', 'startup-config', 'show-commands'];
const MAX_STEM = 92;
const MAX_TOKEN = 32;

/** What is wrong with a pattern, or null when it can be used. Blank is the
 *  default and is fine. */
export function patternProblem(pattern: string): string | null {
  const p = pattern.trim();
  if (!p) return null;
  for (const required of ['{stamp}', '{kind}']) {
    if (!p.includes(required)) {
      return `needs ${required} — without it one capture would overwrite another`;
    }
  }
  const known = FILE_TOKENS.map((t) => t.token);
  let rest = p;
  for (;;) {
    const open = rest.indexOf('{');
    if (open < 0) break;
    const close = rest.indexOf('}', open);
    if (close < 0) return 'has a { with no closing }';
    const token = rest.slice(open, close + 1);
    if (!known.includes(token)) return `${token} is not a file name token`;
    rest = rest.slice(close + 1);
  }
  if (rest.includes('}')) return 'has a } with no opening {';
  return null;
}

/** `safe_component`'s rule: letters, digits, dot, dash and underscore; runs of
 *  anything else become one dash; dashes and dots trimmed from the ends. */
function sanitise(raw: string): string {
  let out = '';
  let lastDash = false;
  for (const ch of raw.trim()) {
    if (/[A-Za-z0-9._-]/.test(ch)) {
      out += ch;
      lastDash = false;
    } else if (!lastDash && out) {
      out += '-';
      lastDash = true;
    }
  }
  return out.replace(/^[-.]+|[-.]+$/g, '');
}

const tokenValue = (raw: string, cap: number) => sanitise(sanitise(raw).slice(0, cap));

/**
 * The filename a pattern gives one capture, or null when the pattern is
 * refused. For the preview only; the backend names the real file.
 */
export function previewFileName(
  pattern: string,
  device: { name: string; address: string; site?: string },
  stamp: string,
  kind: CaptureKind,
): string | null {
  const p = pattern.trim() || DEFAULT_FILE_PATTERN;
  if (patternProblem(p)) return null;
  const date = /^\d{8}/.test(stamp) ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` : '';
  const render = (cap: number) =>
    sanitise(
      p
        .replaceAll('{stamp}', stamp)
        .replaceAll('{kind}', kind)
        .replaceAll('{device}', tokenValue(device.name, cap) || tokenValue(device.address, cap))
        .replaceAll('{address}', tokenValue(device.address, cap))
        .replaceAll('{site}', tokenValue(device.site ?? '', cap))
        .replaceAll('{date}', date),
    );
  // As the backend does: shorten what the device supplied until it fits,
  // never the pattern's own text.
  let cap = MAX_TOKEN;
  let stem = render(cap);
  while (stem.length > MAX_STEM && cap > 0) stem = render(--cap);
  if (stem.length > MAX_STEM || !stem.includes(stamp) || !stem.includes(kind)) return null;
  return `${stem}.txt`;
}

/** A run's stamp, `20260828-101530`, as `2026-08-28 10:15:30`. */
export function describeStamp(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : stamp;
}

/** A capture's filename read back as a date and a kind, wherever a pattern put
 *  them. Anything unrecognised is shown as the filename itself. */
export function describeCapture(filename: string): string {
  const m = /(?<!\d)(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?!\d)/.exec(filename);
  const kind = KINDS.find((k) => filename.includes(k));
  if (!m || !kind) return filename;
  const [, y, mo, d, h, mi, s] = m;
  const label = `${y}-${mo}-${d} ${h}:${mi}:${s} · ${kind.replace('-', ' ')}`;
  // A pattern with other text in it is the operator's naming; show the file too.
  const plain = filename === `${y}${mo}${d}-${h}${mi}${s}-${kind}.txt`;
  return plain ? label : `${label} — ${filename}`;
}
