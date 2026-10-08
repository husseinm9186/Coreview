import { describe, expect, it } from 'vitest';

import { Colouriser, colouriseLine } from './colourise';

/** Built rather than written as a literal: a control character inside a source
 *  file — and especially inside a regular expression — is invisible in a diff,
 *  which is what `no-control-regex` exists to stop. */
const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;
const ESCAPES = new RegExp(`${ESC}\\[(\\d+)m`, 'g');
/** What is written, with every escape shown as `<…>` so a failure is readable. */
const shape = (s: string) => s.replace(ESCAPES, (_, n) => `<${n}>`);
/** The same string with the colour taken back out. */
const plain = (s: string) => s.replace(ESCAPES, '');

describe('colouring output a device sent plain', () => {
  it('marks the word that says something is wrong', () => {
    expect(shape(colouriseLine('Gi1/0/1 is down, line protocol is down')))
      .toBe('<94>Gi1/0/1<0> is <91>down<0>, line protocol is <91>down<0>');
  });

  it('and the word that says it is not', () => {
    expect(shape(colouriseLine('status: connected'))).toBe('status: <92>connected<0>');
  });

  it('tells administratively down from down, because they are different problems', () => {
    // One is somebody's decision and one is a fault. Colouring both red is
    // how a change window gets read as an outage.
    expect(shape(colouriseLine('administratively down'))).toBe('<93>administratively down<0>');
  });

  it('does not find "down" inside "shutdown" or "up" inside "backup"', () => {
    expect(colouriseLine('shutdown')).toBe(`${ESC}[93mshutdown${RESET}`);
    expect(colouriseLine('backup')).toBe('backup');
  });

  it('picks out addresses and MACs in all the spellings devices use', () => {
    expect(shape(colouriseLine('192.0.2.10/24'))).toBe('<96>192.0.2.10/24<0>');
    expect(shape(colouriseLine('aa:bb:cc:dd:ee:ff'))).toBe('<96>aa:bb:cc:dd:ee:ff<0>');
    expect(shape(colouriseLine('aabb.ccdd.eeff'))).toBe('<96>aabb.ccdd.eeff<0>');
  });

  it('colours a whole error line rather than one word of it', () => {
    expect(shape(colouriseLine("% Invalid input detected at '^' marker.")))
      .toBe("<91>% Invalid input detected at '^' marker.<0>");
  });

  it('marks the prompt, which is where the eye goes back to', () => {
    expect(shape(colouriseLine('CORE-SW1#'))).toBe('<95>CORE-SW1#<0>');
    expect(shape(colouriseLine('router>'))).toBe('<95>router><0>');
  });

  it('does not treat a command someone typed as a prompt', () => {
    expect(colouriseLine('CORE-SW1#show version')).not.toContain(`${ESC}[95m`);
  });

  it('does not colour a column heading as though it were a state', () => {
    // The heading line of `show ip interface brief`, copied from a real
    // 2960CX. `OK?` is a heading; colouring it green says the opposite of
    // nothing, on every table the device prints.
    const heading = 'Interface              IP-Address      OK? Method Status                Protocol';
    expect(colouriseLine(heading)).toBe(heading);
  });

  it('still colours ok when it is genuinely a state', () => {
    expect(shape(colouriseLine('status: ok'))).toBe('status: <92>ok<0>');
  });

  it('colours a real interface row the way an engineer reads it', () => {
    // Also from the 2960CX, unchanged apart from the address.
    expect(shape(colouriseLine('GigabitEthernet0/2     unassigned      YES unset  down                  down')))
      .toBe('<94>GigabitEthernet0/2<0>     unassigned      YES unset  <91>down<0>                  <91>down<0>');
  });

  it('never nests one colour inside another', () => {
    // Several rules want different parts of this line. Every escape must be
    // opened and closed once, in order, or the terminal keeps the wrong
    // colour for everything after it.
    const out = colouriseLine('Gi1/0/1 is up, 192.0.2.10 errors 0');
    const escapes = [...out.matchAll(ESCAPES)].map((m) => m[1]);
    for (let i = 0; i < escapes.length; i += 2) {
      expect(escapes[i], out).not.toBe('0');
      expect(escapes[i + 1], out).toBe('0');
    }
    // And the text survives unchanged.
    expect(plain(out)).toBe('Gi1/0/1 is up, 192.0.2.10 errors 0');
  });
});

describe('doing no harm to what the device drew itself', () => {
  it('leaves a line that already carries colour exactly as it is', () => {
    const own = `${ESC}[31mdown${RESET} and up`;
    expect(colouriseLine(own)).toBe(own);
  });

  it('leaves a line being redrawn alone, because it is not finished', () => {
    // A pager or `?` completion writes, returns to column one and writes
    // again. Colouring the half-drawn form tears the screen.
    const redraw = 'loading\rdone up';
    expect(colouriseLine(redraw)).toBe(redraw);
  });

  it('leaves an empty line empty', () => {
    expect(colouriseLine('')).toBe('');
  });
});

describe('a stream, which is not a list of lines', () => {
  it('holds back a word split across two chunks rather than colouring half of it', () => {
    const c = new Colouriser();
    expect(c.feed('Gi1/0/1 is do')).toBe('');
    expect(shape(c.feed('wn\n'))).toBe('<94>Gi1/0/1<0> is <91>down<0>\n');
  });

  it('writes every line that is complete and keeps the rest', () => {
    const c = new Colouriser();
    const out = c.feed('one up\ntwo down\nthree par');
    expect(shape(out)).toBe('one <92>up<0>\ntwo <91>down<0>\n');
    expect(c.pending).toBe(true);
    expect(c.flush()).toBe('three par');
    expect(c.pending).toBe(false);
  });

  it('gives back a prompt that will never have a newline after it', () => {
    // The device is waiting. A terminal that only ever wrote whole lines would
    // leave the screen blank at exactly the moment somebody wants to type.
    const c = new Colouriser();
    expect(c.feed('CORE-SW1#')).toBe('');
    expect(c.flush()).toBe('CORE-SW1#');
  });

  it('colours a line that ends the way a device ends one', () => {
    // `\r\n` is the line ending every device sends. Read as a mid-line
    // carriage return it made the line look like a redraw, and nothing was
    // ever coloured at all.
    const c = new Colouriser();
    expect(shape(c.feed('Gi1/0/1 is down\r\n'))).toBe('<94>Gi1/0/1<0> is <91>down<0>\r\n');
  });

  it('loses nothing across a whole exchange', () => {
    const c = new Colouriser();
    const chunks = ['CORE-SW', '1#show ip int br\r\n', 'Gi1/0/1  192.0.2.10  up  ', 'up\n', 'CORE-SW1#'];
    let written = '';
    for (const chunk of chunks) written += c.feed(chunk);
    written += c.flush();
    expect(plain(written)).toBe(chunks.join(''));
  });
});
