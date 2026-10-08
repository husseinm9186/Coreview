/**
 * Colour for devices that send none.
 *
 * Most switches send plain text. Reading twelve screens of `show interface`
 * for the one line that says `down` is what colour is for, and SecureCRT has
 * had keyword highlighting for twenty years.
 *
 * **The hard part is doing no harm**, and everything here is shaped by it:
 *
 * - A device that colours its own output must be left alone, or its sequences
 *   and ours interleave and the screen fills with stray brackets. So a line
 *   carrying any escape of its own passes through untouched.
 * - Anything full-screen — `?` completion redrawing the line, a pager, an
 *   editor — must not be rewritten. Those arrive as partial lines and as
 *   control sequences, and both are left alone.
 * - A chunk off the network ends where TCP says, not where a line does. Only
 *   **complete** lines are ever coloured; the tail is held until its newline
 *   arrives. Colouring half a word and then the other half is how a
 *   highlighter corrupts a screen.
 *
 * None of this touches the log: the transcript is written from the raw stream
 * in Rust, with escapes taken out.
 */

/** Built rather than written as a literal: a raw escape byte in a source file
 *  is invisible in a diff and in a review. */
const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

/** The palette, as ANSI. Kept to the bright set rather than the loud one: this
 *  sits under whatever the device itself does, and a wall of red reads as an
 *  outage when it is only the word "errors" in a counter heading. */
const COLOUR = {
  bad: `${ESC}[91m`,
  good: `${ESC}[92m`,
  warn: `${ESC}[93m`,
  address: `${ESC}[96m`,
  iface: `${ESC}[94m`,
  prompt: `${ESC}[95m`,
};

/**
 * One rule: what to find, and which colour to put round it.
 *
 * Order matters — the first rule to claim a piece of text owns it, because a
 * second pass over text that already carries an escape is how nesting starts.
 */
const RULES: { re: RegExp; colour: string }[] = [
  // Whole-line conditions first: a device's error line is worth seeing as a
  // line, not as one coloured word inside it.
  { re: /^%.*$/gm, colour: COLOUR.bad },
  // States. Word boundaries on both sides, so `shutdown` does not match `down`
  // and `notconnect` does not match `connect`.
  { re: /\b(?:administratively down|admin down|err-?disabled|disabled|shutdown)\b/gi, colour: COLOUR.warn },
  { re: /\b(?:down|failed|failure|denied|error|errors|invalid|unreachable|timeout|timed out|drop|drops|dropped)\b/gi, colour: COLOUR.bad },
  // `ok` carries a negative lookahead for `?`, which is not fussiness: every
  // `show ip interface brief` has an `OK?` column heading, and colouring a
  // heading as though it were a state is wrong on every line of every table
  // (found against a real 2960CX).
  { re: /\b(?:up|connected|established|reachable|success|succeeded|ok(?!\?)|active|forwarding)\b/gi, colour: COLOUR.good },
  // A MAC, in the three spellings devices use.
  { re: /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\b[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}\b/gi, colour: COLOUR.address },
  // IPv4, with an optional prefix length.
  { re: /\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/g, colour: COLOUR.address },
  // Interface names, the way the vendors write them.
  {
    re: /\b(?:GigabitEthernet|TenGigabitEthernet|FastEthernet|Port-channel|Ethernet|Loopback|Tunnel|Serial|Vlan|Gi|Te|Fa|Eth|Et|Po|Vl|Lo|Tu|Se|Hu|Fo|mgmt|wan|internal|port)[0-9]+(?:\/[0-9]+)*(?:\.[0-9]+)?\b/g,
    colour: COLOUR.iface,
  },
];

/** A line the device drew itself, or a line worth leaving exactly as it is. */
function untouchable(line: string): boolean {
  // Its own escape sequences, or a carriage return mid-line — a device
  // redrawing what it has already written.
  return line.includes(ESC) || line.includes('\r');
}

/**
 * Colours one complete line. Exported for the tests; `Colouriser` is what the
 * terminal uses, because only it knows where a line ends.
 */
export function colouriseLine(line: string): string {
  if (!line || untouchable(line)) return line;

  // A prompt line — `SW-A#`, `router>`, `fw01 $` — with nothing typed after it
  // is the one case where the whole line is one thing.
  const prompt = /^([\w.@()\- ]{1,64}[#$>])(\s*)$/.exec(line);
  if (prompt) return `${COLOUR.prompt}${prompt[1]}${RESET}${prompt[2]}`;

  // Each character is claimed by at most one rule. Marking first and building
  // afterwards is what stops a second rule colouring inside a first one's
  // match, which produces nested escapes and a reset in the wrong place.
  const owner: (string | null)[] = new Array(line.length).fill(null);
  for (const { re, colour } of RULES) {
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      // A zero-width match would spin here forever.
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      let free = true;
      for (let i = m.index; i < m.index + m[0].length; i += 1) if (owner[i]) free = false;
      if (free) for (let i = m.index; i < m.index + m[0].length; i += 1) owner[i] = colour;
    }
  }

  let out = '';
  let open: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const want = owner[i] ?? null;
    if (want !== open) {
      if (open) out += RESET;
      if (want) out += want;
      open = want;
    }
    out += line[i];
  }
  if (open) out += RESET;
  return out;
}

/**
 * Colours a stream, chunk by chunk, holding back the part of a chunk that is
 * not yet a whole line.
 *
 * One per session, and thrown away when colouring is switched off so a partial
 * line is never carried from one setting to the next.
 */
export class Colouriser {
  private tail = '';

  /** The coloured form of everything that is now complete. */
  feed(chunk: string): string {
    const text = this.tail + chunk;
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak < 0) {
      this.tail = text;
      return '';
    }
    this.tail = text.slice(lastBreak + 1);
    return text
      .slice(0, lastBreak + 1)
      .split('\n')
      .slice(0, -1)
      .map((line) => {
        // Devices end lines with `\r\n`. That trailing carriage return is a
        // line ending, not a device redrawing the line it is on — treating it
        // as the latter made every line untouchable and nothing was ever
        // coloured at all.
        const cr = line.endsWith('\r');
        const body = cr ? line.slice(0, -1) : line;
        return `${colouriseLine(body)}${cr ? '\r' : ''}\n`;
      })
      .join('');
  }

  /**
   * Everything held back, uncoloured.
   *
   * A prompt has no newline after it — it is the device waiting — so a
   * terminal that only ever wrote complete lines would never draw one. This is
   * called once the device has stopped sending for a moment.
   */
  flush(): string {
    const held = this.tail;
    this.tail = '';
    return held;
  }

  /** Whether anything is being held back. */
  get pending(): boolean {
    return this.tail.length > 0;
  }
}
