#!/usr/bin/env node
/**
 * The release manifest the app's update check reads, and the notes the
 * GitHub Release carries — written from the artifacts CI built.
 *
 * The updater in the app fetches `latest.json` from the newest release and
 * compares its `version` with its own; `platforms` names, per target, the
 * file to download and the minisign signature CI produced beside it
 * (`<file>.sig`, written by `tauri build` when the signing key is present).
 * The macOS bundle is universal, so the one archive serves both Mac targets.
 *
 *   node scripts/release-manifest.mjs --version 2.9.0 --artifacts dl \
 *     --repo owner/name --out release
 *
 * Writes `release/latest.json` and `release/notes.md` (the version's section
 * of docs/RELEASE-NOTES.md) and prints the files to attach, one per line.
 * Fails when an installer or its signature is missing: a release the app
 * cannot verify is worse than none.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** The artifacts a release needs, by their names. */
export function pickArtifacts(names) {
  const one = (test) => names.filter(test);
  const windows = one((n) => /-setup\.exe$/i.test(n));
  const windowsSig = one((n) => /-setup\.exe\.sig$/i.test(n));
  const mac = one((n) => /\.app\.tar\.gz$/i.test(n));
  const macSig = one((n) => /\.app\.tar\.gz\.sig$/i.test(n));
  const dmg = one((n) => /\.dmg$/i.test(n));
  const missing = [];
  if (windows.length !== 1) missing.push('the Windows installer (*-setup.exe)');
  if (windowsSig.length !== 1) missing.push('the Windows installer\'s signature (*-setup.exe.sig)');
  if (mac.length !== 1) missing.push('the macOS update archive (*.app.tar.gz)');
  if (macSig.length !== 1) missing.push('the macOS archive\'s signature (*.app.tar.gz.sig)');
  if (dmg.length !== 1) missing.push('the macOS disk image (*.dmg)');
  if (missing.length) throw new Error(`cannot write a release without ${missing.join(', ')}`);
  const extras = one((n) => /^SHA256SUMS\.txt$|\.cdx\.json$|\.crt$|\.cer$/i.test(n));
  return { windows: windows[0], windowsSig: windowsSig[0], mac: mac[0], macSig: macSig[0], dmg: dmg[0], extras };
}

/** `latest.json`, as tauri-plugin-updater reads it. */
export function manifest({ version, repo, picked, signatures, notes, date }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`);
  const url = (name) => `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`;
  const mac = { signature: signatures.mac, url: url(picked.mac) };
  return {
    version,
    notes,
    pub_date: date,
    platforms: {
      'windows-x86_64': { signature: signatures.windows, url: url(picked.windows) },
      'darwin-aarch64': mac,
      'darwin-x86_64': { ...mac },
    },
  };
}

/** The version's own section of the release notes, without its heading. */
export function notesFor(releaseNotes, version) {
  const lines = releaseNotes.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`).test(l));
  if (start < 0) throw new Error(`docs/RELEASE-NOTES.md has no section for ${version}`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim() + '\n';
}

/** What a minisign signature says it signed: the trusted comment's fields.
 *  Printed so the job log shows whether the CLI recorded the version. */
export function trustedComment(sigBase64) {
  const text = Buffer.from(sigBase64.trim(), 'base64').toString('utf8');
  const line = text.split('\n').find((l) => l.startsWith('trusted comment: '));
  return line ? line.slice('trusted comment: '.length) : '';
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`--${name} is required`);
  return process.argv[i + 1];
}

if (process.argv[1] && basename(process.argv[1]) === 'release-manifest.mjs') {
  const version = arg('version');
  const artifacts = arg('artifacts');
  const repo = arg('repo');
  const out = arg('out');
  const paths = walk(artifacts);
  const byName = new Map(paths.map((p) => [basename(p), p]));
  const picked = pickArtifacts([...byName.keys()]);
  const read = (name) => readFileSync(byName.get(name), 'utf8').trim();
  const signatures = { windows: read(picked.windowsSig), mac: read(picked.macSig) };
  const notes = notesFor(readFileSync(new URL('../docs/RELEASE-NOTES.md', import.meta.url), 'utf8'), version);
  const json = manifest({ version, repo, picked, signatures, notes, date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
  if (!existsSync(out)) mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'latest.json'), JSON.stringify(json, null, 2) + '\n');
  writeFileSync(join(out, 'notes.md'), notes);
  console.error(`windows signature signed: ${trustedComment(signatures.windows)}`);
  console.error(`macOS signature signed:   ${trustedComment(signatures.mac)}`);
  for (const name of [picked.windows, picked.windowsSig, picked.dmg, picked.mac, picked.macSig, ...picked.extras]) {
    console.log(byName.get(name));
  }
  console.log(join(out, 'latest.json'));
}
