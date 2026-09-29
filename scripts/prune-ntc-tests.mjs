#!/usr/bin/env node
/**
 * Keep under resources/templates/tests only the fixture directories of
 * templates a catalog names (LT-509: "for every matched template"). Run
 * by scripts/vendor-ntc.sh after a refresh, and by hand after a catalog
 * gains a template.
 *
 *   node scripts/prune-ntc-tests.mjs [--dry-run]
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogDir = join(root, 'resources/catalog');
const testsDir = join(root, 'resources/templates/tests');
const dry = process.argv.includes('--dry-run');

const named = new Set();
for (const f of readdirSync(catalogDir).filter((f) => f.endsWith('.yaml'))) {
  const c = YAML.parse(readFileSync(join(catalogDir, f), 'utf8'));
  for (const cmd of [...(c.commands ?? []), ...(c.live_path ?? [])]) {
    for (const p of [cmd.parser, cmd.shadow ?? '', ...(cmd.also ?? [])]) if (p.startsWith('textfsm:')) named.add(p.slice(8));
  }
  for (const p of c.caps_probe ?? []) if ((p.parser ?? '').startsWith('textfsm:')) named.add(p.parser.slice(8));
}

let kept = 0;
let removed = 0;
for (const platform of readdirSync(testsDir)) {
  const pdir = join(testsDir, platform);
  if (!statSync(pdir).isDirectory()) continue;
  for (const cmd of readdirSync(pdir)) {
    const dir = join(pdir, cmd);
    if (!statSync(dir).isDirectory()) continue;
    if (named.has(`${platform}_${cmd}`)) {
      kept += 1;
    } else {
      removed += 1;
      if (!dry) rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!dry && existsSync(pdir) && readdirSync(pdir).length === 0) rmSync(pdir, { recursive: true });
}
console.log(`${named.size} templates named by the catalogs; ${kept} fixture directories kept, ${removed} ${dry ? 'would be ' : ''}removed`);
