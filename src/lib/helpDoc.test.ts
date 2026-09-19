import { describe, expect, it } from 'vitest';

import { helpSections, searchHelp, sectionText, slug } from './helpDoc';
import guide from '../../docs/USER_GUIDE.md?raw';

describe('the user guide, read for the app (LT-303)', () => {
  it('slugs a title into something that can key a list', () => {
    expect(slug('Find what is on the network')).toBe('find-what-is-on-the-network');
    expect(slug('MAC addresses behind a router')).toBe('mac-addresses-behind-a-router');
    expect(slug('  Spaces  ')).toBe('spaces');
  });

  it('starts a section on every ## and keeps ### inside it', () => {
    const sections = helpSections('# Title\n\n## One\n\ntext\n\n### Under one\n\nmore\n\n## Two\n\nlast\n');
    expect(sections.map((s) => s.title)).toEqual(['One', 'Two']);
    expect(sections[0]!.blocks.filter((b) => b.kind === 'heading')).toHaveLength(1);
    expect(sections[0]!.id).toBe('one');
  });

  it('takes fenced code whole, blank lines and indents included', () => {
    const [section] = helpSections('## Checks\n\n```\nnpx vitest run\n\n  indented\n```\n\nafter\n');
    const code = section!.blocks.find((b) => b.kind === 'code');
    expect(code).toEqual({ kind: 'code', lines: ['npx vitest run', '', '  indented'] });
    // And what follows the fence is a paragraph again.
    expect(section!.blocks.at(-1)).toEqual({ kind: 'paragraph', text: 'after' });
  });

  it('reads a table, header and rows', () => {
    const [section] = helpSections('## Ports\n\n| Port | Use |\n| --- | --- |\n| 22 | SSH |\n| 443 | HTTPS |\n\ndone\n');
    expect(section!.blocks[0]).toEqual({
      kind: 'table',
      head: ['Port', 'Use'],
      rows: [['22', 'SSH'], ['443', 'HTTPS']],
    });
    expect(section!.blocks[1]).toEqual({ kind: 'paragraph', text: 'done' });
  });

  it('joins a paragraph wrapped over several lines, and keeps two apart', () => {
    const [section] = helpSections('## A\n\none line\nwrapped over two\n\na second paragraph\n');
    expect(section!.blocks).toEqual([
      { kind: 'paragraph', text: 'one line wrapped over two' },
      { kind: 'paragraph', text: 'a second paragraph' },
    ]);
  });

  it('reads bullets, numbers, quotes and rules', () => {
    const [section] = helpSections('## A\n\n- one\n* two\n\n1. first\n2) second\n\n> quoted\n\n---\n');
    expect(section!.blocks).toEqual([
      { kind: 'bullet', text: 'one' },
      { kind: 'bullet', text: 'two' },
      { kind: 'number', n: 1, text: 'first' },
      { kind: 'number', n: 2, text: 'second' },
      { kind: 'quote', text: 'quoted' },
      { kind: 'rule' },
    ]);
  });

  it('finds sections by anything in them, title matches first', () => {
    const sections = helpSections('## Drawing\n\nnothing here\n\n## Other\n\nthe word drawing is in the body\n');
    expect(searchHelp(sections, 'drawing').map((s) => s.title)).toEqual(['Drawing', 'Other']);
    expect(searchHelp(sections, 'nothing').map((s) => s.title)).toEqual(['Drawing']);
    expect(searchHelp(sections, '').map((s) => s.title)).toEqual(['Drawing', 'Other']);
    expect(searchHelp(sections, 'no such words')).toEqual([]);
  });

  it('gathers a section\'s words for searching, code and tables included', () => {
    const [section] = helpSections('## A\n\n```\nsome code\n```\n\n| H |\n| - |\n| cell |\n');
    expect(sectionText(section!)).toContain('some code');
    expect(sectionText(section!)).toContain('cell');
  });
});

describe('the guide the app actually ships', () => {
  const sections = helpSections(guide);

  it('reads, and has the sections a person needs', () => {
    expect(sections.length).toBeGreaterThan(20);
    const titles = sections.map((s) => s.title);
    // A few that must exist for the help to be worth opening at all.
    expect(titles).toContain('Create a project');
    expect(titles).toContain('Draw');
    expect(titles).toContain('Find what is on the network');
  });

  it('leaves no section empty, which would show as a blank page', () => {
    const empty = sections.filter((s) => s.blocks.length === 0).map((s) => s.title);
    expect(empty).toEqual([]);
  });

  it('gives every section its own id, so the list keys do not collide', () => {
    const ids = sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
