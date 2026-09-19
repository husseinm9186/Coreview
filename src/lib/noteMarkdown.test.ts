import { describe, expect, it } from 'vitest';

import { inlinePieces, noteBlocks, plainLine } from './noteMarkdown';

describe('note Markdown (LT-237)', () => {
  it('reads the blocks a note understands', () => {
    const blocks = noteBlocks('# Cutover\n## Before\n### Checks\n- [x] backup taken\n* [ ] ping core\n- core first\n1. drain\n2) move\n> rollback ready\n---\n\nplain words');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'heading', 'heading', 'check', 'check', 'bullet', 'number', 'number', 'quote', 'rule', 'blank', 'paragraph']);
    expect(blocks[2]).toEqual({ kind: 'heading', level: 3, text: 'Checks' });
    expect(blocks[3]).toEqual({ kind: 'check', checked: true, text: 'backup taken' });
    expect(blocks[7]).toEqual({ kind: 'number', n: 2, text: 'move' });
  });

  it('reads bold, italic, struck, code and links, and leaves stray marks as text', () => {
    expect(inlinePieces('**do** *not* _touch_ ~~Gi0/1~~ `conf t` [runbook](https://wiki.example/r)')
      .filter((p) => p.kind !== 'text')).toEqual([
      { kind: 'bold', text: 'do' },
      { kind: 'italic', text: 'not' },
      { kind: 'italic', text: 'touch' },
      { kind: 'strike', text: 'Gi0/1' },
      { kind: 'code', text: 'conf t' },
      { kind: 'link', text: 'runbook', url: 'https://wiki.example/r' },
    ]);
    expect(inlinePieces('2 * 3 and a_b_c [brackets] no url')).toEqual([{ kind: 'text', text: '2 * 3 and a_b_c [brackets] no url' }]);
  });

  it('writes a block as plain text for the export', () => {
    expect(noteBlocks('## **Before**\n- [ ] ping *core*\n3. drain\n> rollback').map(plainLine)).toEqual([
      { text: 'Before', bold: true },
      { text: '☐ ping core', bold: false },
      { text: '3. drain', bold: false },
      { text: '│ rollback', bold: false },
    ]);
  });
});
