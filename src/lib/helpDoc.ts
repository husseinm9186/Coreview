/**
 * The user guide, read into sections so the app can show it (LT-303).
 *
 * The guide is `docs/USER_GUIDE.md` and stays there: it is the same text
 * whether someone reads it in the repository or presses Help, and there is one
 * copy of it, so the two cannot drift. This turns that one file into something
 * a screen can page through.
 *
 * A parser of its own rather than `noteMarkdown`, which a note and the export
 * both depend on: the guide has fenced code and tables, notes do not, and
 * widening the note parser to suit a help screen would change what a note
 * draws. Same reason there are two: they answer different questions.
 */
export type HelpBlock =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'number'; n: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lines: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'rule' };

export interface HelpSection {
  /** Stable enough to key a list and to link to: the title, slugged. */
  id: string;
  title: string;
  blocks: HelpBlock[];
}

/** `Find what is on the network` → `find-what-is-on-the-network`. */
export function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

const isDivider = (line: string): boolean => /^\|?[\s:|-]+\|[\s:|-]*$/.test(line.trim()) && line.includes('-');

/**
 * Every `##` section of the guide, in the order it is written.
 *
 * `###` stays inside its section as a heading rather than starting a new one:
 * the sub-headings are steps within a job, and splitting on them would turn a
 * list of nine tasks into a list of thirty fragments.
 */
export function helpSections(markdown: string): HelpSection[] {
  const lines = markdown.split('\n');
  const sections: HelpSection[] = [];
  let current: HelpSection | null = null;

  const push = (block: HelpBlock) => {
    if (!current) current = { id: 'about', title: 'About', blocks: [] };
    current.blocks.push(block);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    // Fenced code, taken whole: its blank lines and leading spaces are the
    // point, so nothing inside is parsed.
    if (line.trimStart().startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        code.push(lines[i]!);
        i += 1;
      }
      push({ kind: 'code', lines: code });
      continue;
    }

    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      // `#` is the document's own title and starts nothing.
      if (level === 1) continue;
      if (level === 2) {
        current = { id: slug(text), title: text, blocks: [] };
        sections.push(current);
        continue;
      }
      push({ kind: 'heading', level: 3, text });
      continue;
    }

    // A table: a header row, a divider, then rows until something else.
    if (line.trim().startsWith('|') && isDivider(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(cells(lines[i]!));
        i += 1;
      }
      i -= 1;
      push({ kind: 'table', head, rows });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      push({ kind: 'rule' });
      continue;
    }
    const bullet = /^\s*[-*] (.*)$/.exec(line);
    if (bullet) {
      push({ kind: 'bullet', text: bullet[1]!.trim() });
      continue;
    }
    const numbered = /^\s*(\d{1,3})[.)] (.*)$/.exec(line);
    if (numbered) {
      push({ kind: 'number', n: Number(numbered[1]), text: numbered[2]!.trim() });
      continue;
    }
    const quote = /^> ?(.*)$/.exec(line);
    if (quote) {
      push({ kind: 'quote', text: quote[1]! });
      continue;
    }

    if (!line.trim()) continue;

    // A paragraph is joined across the lines it is wrapped over, because the
    // guide is wrapped for reading in a terminal and a screen re-wraps it.
    const last = current?.blocks[current.blocks.length - 1];
    if (last?.kind === 'paragraph' && lines[i - 1]?.trim()) last.text += ` ${line.trim()}`;
    else push({ kind: 'paragraph', text: line.trim() });
  }

  return sections;
}

/** Every word of a section, for the search box. */
export function sectionText(section: HelpSection): string {
  return [
    section.title,
    ...section.blocks.map((b) => {
      switch (b.kind) {
        case 'code':
          return b.lines.join(' ');
        case 'table':
          return [...b.head, ...b.rows.flat()].join(' ');
        case 'rule':
          return '';
        default:
          return b.text;
      }
    }),
  ].join(' ');
}

/** The sections a search matches, title first where it matches there. */
export function searchHelp(sections: readonly HelpSection[], query: string): HelpSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...sections];
  const hits = sections.filter((s) => sectionText(s).toLowerCase().includes(q));
  return hits.sort((a, b) => {
    const at = a.title.toLowerCase().includes(q) ? 0 : 1;
    const bt = b.title.toLowerCase().includes(q) ? 0 : 1;
    return at - bt;
  });
}
