/**
 * The Markdown a note understands (LT-096, extended by LT-237): read into
 * blocks and inline pieces here, drawn by the note and by the export from the
 * same result, so what a note shows and what it exports agree.
 *
 * Blocks: `#`, `##`, `###` headings; `- [ ]` and `- [x]` checkboxes; `-` or `*`
 * bullets; `1.` numbered items; `>` quotes; `---` rules. Inline: `**bold**`,
 * `*italic*` or `_italic_`, `~~struck~~`, `` `code` `` and `[text](url)`.
 */
export type NoteBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'check'; checked: boolean; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'number'; n: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'blank' }
  | { kind: 'paragraph'; text: string };

export function noteBlocks(body: string): NoteBlock[] {
  return body.split('\n').map((line): NoteBlock => {
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) return { kind: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! };
    const check = /^[-*] \[( |x|X)\] (.*)$/.exec(line);
    if (check) return { kind: 'check', checked: check[1] !== ' ', text: check[2]! };
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) return { kind: 'rule' };
    const bullet = /^[-*] (.*)$/.exec(line);
    if (bullet) return { kind: 'bullet', text: bullet[1]! };
    const number = /^(\d{1,4})[.)] (.*)$/.exec(line);
    if (number) return { kind: 'number', n: Number(number[1]), text: number[2]! };
    const quote = /^> ?(.*)$/.exec(line);
    if (quote) return { kind: 'quote', text: quote[1]! };
    if (line.trim() === '') return { kind: 'blank' };
    return { kind: 'paragraph', text: line };
  });
}

export type InlinePiece =
  | { kind: 'text' | 'bold' | 'italic' | 'strike' | 'code'; text: string }
  | { kind: 'link'; text: string; url: string };

// Italic marks must not sit inside a word, so `a_b_c` and `2 * 3 * 4` stay text.
const INLINE = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|(?<![\w*])\*[^*\s][^*]*\*(?![\w*])|(?<!\w)_[^_\s][^_]*_(?!\w))/g;

export function inlinePieces(text: string): InlinePiece[] {
  const out: InlinePiece[] = [];
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) out.push({ kind: 'bold', text: part.slice(2, -2) });
    else if (part.startsWith('~~') && part.endsWith('~~') && part.length > 4) out.push({ kind: 'strike', text: part.slice(2, -2) });
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) out.push({ kind: 'code', text: part.slice(1, -1) });
    else if (/^\[[^\]]+\]\([^)\s]+\)$/.test(part)) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)!;
      out.push({ kind: 'link', text: m[1]!, url: m[2]! });
    } else if (((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) && part.length > 2) {
      out.push({ kind: 'italic', text: part.slice(1, -1) });
    } else out.push({ kind: 'text', text: part });
  }
  return out;
}

/** A block as plain text for places that cannot style it, like the SVG
 *  export: markers kept, emphasis marks dropped. */
export function plainLine(b: NoteBlock): { text: string; bold: boolean } {
  const flat = (t: string) => inlinePieces(t).map((p) => p.text).join('');
  switch (b.kind) {
    case 'heading': return { text: flat(b.text), bold: true };
    case 'check': return { text: `${b.checked ? '☑' : '☐'} ${flat(b.text)}`, bold: false };
    case 'bullet': return { text: `• ${flat(b.text)}`, bold: false };
    case 'number': return { text: `${b.n}. ${flat(b.text)}`, bold: false };
    case 'quote': return { text: `│ ${flat(b.text)}`, bold: false };
    case 'rule': return { text: '────────', bold: false };
    case 'blank': return { text: '', bold: false };
    default: return { text: flat(b.text), bold: false };
  }
}
