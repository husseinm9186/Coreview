/**
 * The release manifest: the right files picked, the manifest the updater
 * reads shaped as it expects, the version's notes cut from the release
 * notes, and a signature's trusted comment read back.
 */
import { describe, expect, it } from 'vitest';

import { manifest, notesFor, pickArtifacts, trustedComment } from './release-manifest.mjs';

const NAMES = [
  'Coreview_2.9.0_x64-setup.exe',
  'Coreview_2.9.0_x64-setup.exe.sig',
  'SHA256SUMS.txt',
  'coreview-rust.cdx.json',
  'coreview-root-ca.crt',
  'Coreview_2.9.0_universal.dmg',
  'Coreview.app.tar.gz',
  'Coreview.app.tar.gz.sig',
];

describe('pickArtifacts', () => {
  it('finds each installer, its signature and the extras worth attaching', () => {
    const picked = pickArtifacts(NAMES);
    expect(picked.windows).toBe('Coreview_2.9.0_x64-setup.exe');
    expect(picked.windowsSig).toBe('Coreview_2.9.0_x64-setup.exe.sig');
    expect(picked.mac).toBe('Coreview.app.tar.gz');
    expect(picked.macSig).toBe('Coreview.app.tar.gz.sig');
    expect(picked.dmg).toBe('Coreview_2.9.0_universal.dmg');
    expect(picked.extras).toEqual(['SHA256SUMS.txt', 'coreview-rust.cdx.json', 'coreview-root-ca.crt']);
  });

  it('refuses a release the app could not verify', () => {
    expect(() => pickArtifacts(NAMES.filter((n) => !n.endsWith('.sig')))).toThrow(/signature/);
    expect(() => pickArtifacts(NAMES.filter((n) => !n.endsWith('.dmg')))).toThrow(/disk image/);
    expect(() => pickArtifacts([...NAMES, 'Coreview_2.9.1_x64-setup.exe'])).toThrow(/Windows installer/);
  });
});

describe('manifest', () => {
  const picked = pickArtifacts(NAMES);
  const made = manifest({
    version: '2.9.0',
    repo: 'owner/name',
    picked,
    signatures: { windows: 'dW50cnVzdGVk', mac: 'bWFj' },
    notes: 'Fixes.\n',
    date: '2026-10-09T12:00:00Z',
  });

  it('points every platform at the tagged release on GitHub, with its signature', () => {
    expect(made.version).toBe('2.9.0');
    expect(made.pub_date).toBe('2026-10-09T12:00:00Z');
    expect(made.notes).toBe('Fixes.\n');
    expect(made.platforms['windows-x86_64']).toEqual({
      signature: 'dW50cnVzdGVk',
      url: 'https://github.com/owner/name/releases/download/v2.9.0/Coreview_2.9.0_x64-setup.exe',
    });
    // The universal archive serves both Mac targets.
    expect(made.platforms['darwin-aarch64']).toEqual({
      signature: 'bWFj',
      url: 'https://github.com/owner/name/releases/download/v2.9.0/Coreview.app.tar.gz',
    });
    expect(made.platforms['darwin-x86_64']).toEqual(made.platforms['darwin-aarch64']);
    expect(Object.keys(made.platforms)).toHaveLength(3);
  });

  it('refuses anything but a release version', () => {
    expect(() => manifest({ version: 'v2.9.0', repo: 'o/n', picked, signatures: { windows: 'a', mac: 'b' }, notes: '', date: '' })).toThrow(/not a release version/);
  });
});

describe('notesFor', () => {
  const NOTES = `# Release notes

Newest first.

## 2.9.1 — 2026-10-20

**Fixes**
- One.

## 2.9.0 — 2026-10-09

**Updates**
- The app can check GitHub.

## 2.8.0 — 2026-10-09

**Backups**
- Over SNMP.
`;

  it('cuts the version\'s own section, without its heading', () => {
    expect(notesFor(NOTES, '2.9.0')).toBe('**Updates**\n- The app can check GitHub.\n');
    expect(notesFor(NOTES, '2.9.1')).toBe('**Fixes**\n- One.\n');
    // The oldest section runs to the end of the file.
    expect(notesFor(NOTES, '2.8.0')).toBe('**Backups**\n- Over SNMP.\n');
  });

  it('says when the notes have no section for the version', () => {
    expect(() => notesFor(NOTES, '2.10.0')).toThrow(/no section for 2\.10\.0/);
    // 2.9.0 must not match 2.9.0's neighbour by prefix.
    expect(() => notesFor(NOTES.replace('## 2.9.0', '## 2.9.01'), '2.9.0')).toThrow();
  });
});

describe('trustedComment', () => {
  it('reads what a minisign signature says it signed', () => {
    const sig = Buffer.from(
      'untrusted comment: signature from tauri secret key\nRUSv…\ntrusted comment: timestamp:1791601794\tfile:sigtest.bin\n3YPk…\n',
    ).toString('base64');
    expect(trustedComment(sig)).toBe('timestamp:1791601794\tfile:sigtest.bin');
    expect(trustedComment(Buffer.from('nothing here').toString('base64'))).toBe('');
  });
});
