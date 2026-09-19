import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * The licence promises, checked rather than trusted (LT-312).
 *
 * Coreview is proprietary and free to use. Two things follow that are easy to
 * break by accident and expensive to break in public: a manifest quietly
 * claiming a different licence, and a dependency arriving under a licence that
 * a proprietary build may not ship. Both are one commit away at any time, so
 * neither is left to memory.
 */
const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, 'utf8');

const LICENCE_ID = 'LicenseRef-Almoola-Free-Proprietary';

describe('what Coreview says its own licence is', () => {
  it('ships a LICENSE file carrying the terms', () => {
    const licence = read('LICENSE');
    expect(licence).toContain('free of charge');
    expect(licence).toContain('Mohammed Almoola');
    expect(licence).toContain('© 2026 Mohammed Almoola. All rights reserved.');
  });

  it('lets anyone pass it on, which is the point of it (LT-313)', () => {
    const licence = read('LICENSE');
    expect(licence).toMatch(/YOU MAY PASS IT ON/i);
    expect(licence).toContain('unchanged');
    expect(licence).toContain('do not charge for it');
    // And still reserves what it reserves.
    expect(licence).toMatch(/may not[\s\S]*sell Coreview/i);
    expect(licence).toMatch(/derivative works/i);
  });

  it('claims no trademark on the name', () => {
    // The ™ reached the installer's licence page, asserting a mark that is not
    // owned, on a name an established company already uses.
    for (const f of ['LICENSE', 'README.md', 'src/components/TopBar.tsx']) {
      expect(read(f), f).not.toContain('™');
    }
    // The sentence wraps in the file, so match it the way it is written.
    expect(read('LICENSE').replace(/\s+/g, ' ')).toContain('is not claimed as a trademark');
  });

  it('says the same thing in every manifest', () => {
    expect(JSON.parse(read('package.json')).license).toBe(LICENCE_ID);
    for (const manifest of [
      'src-tauri/Cargo.toml',
      'crates/coreview-probe/Cargo.toml',
      'crates/coreview-discover/Cargo.toml',
    ]) {
      const text = read(manifest);
      expect(text, manifest).toContain(`license = "${LICENCE_ID}"`);
      // A proprietary crate that can be published by accident is a crate that
      // will be. coreview-probe declared MIT until 2026-09-18.
      expect(text, manifest).toContain('publish = false');
    }
  });

  it('installs the licence and the notices beside the application', () => {
    const bundle = JSON.parse(read('src-tauri/tauri.conf.json')).bundle;
    expect(bundle.resources).toMatchObject({
      '../LICENSE': 'LICENSE.txt',
      '../THIRD-PARTY-NOTICES.md': 'THIRD-PARTY-NOTICES.md',
    });
    expect(bundle.copyright).toContain('Mohammed Almoola');
    expect(bundle.publisher).toBe('Mohammed Almoola');
  });
});

describe('what Coreview is allowed to ship', () => {
  const notices = existsSync(`${root}/THIRD-PARTY-NOTICES.md`) ? read('THIRD-PARTY-NOTICES.md') : '';

  it('has notices at all, generated rather than written', () => {
    expect(notices).not.toBe('');
    expect(notices).toContain('scripts/third-party-notices.mjs');
  });

  it('reproduces licence texts, not just a list of names', () => {
    // A name list satisfies nobody: MIT asks for the notice itself to travel
    // with the binary.
    expect(notices).toContain('# Licence texts');
    expect(notices).toContain('Permission is hereby granted, free of charge');
    expect(notices).toContain('Apache License');
  });

  it('carries no licence that a proprietary build may not ship', () => {
    // The tables list one licence per row; a copyleft one with no permissive
    // alternative beside it would stop distribution outright.
    const rows = notices
      .split('\n')
      .filter((line) => /^\| \S/.test(line) && line.split('|').length >= 4)
      .map((line) => line.split('|')[3]!.trim());
    expect(rows.length).toBeGreaterThan(100);

    const blocking = rows.filter(
      (l) => /\b(AGPL|SSPL|OSL|EUPL|CPAL)\b/i.test(l) || (/\bGPL-[23]/i.test(l) && !/ OR /i.test(l)),
    );
    expect(blocking).toEqual([]);
  });

  it('names the MPL components and where their source is', () => {
    // MPL-2.0 is copyleft per file: fine to link, and the source has to be
    // pointed at. Saying so is the whole obligation.
    expect(notices).toContain('Mozilla Public License 2.0 components');
    expect(notices).toMatch(/- \*\*cssparser [\d.]+\*\* — https:\/\//);
  });
});
