/**
 * The discovery catalog, held to its sources from the page side (LT-508,
 * LT-509, LT-511, LT-512). The Rust crate does the deep check; this one
 * keeps the JavaScript allowlist, the reconciliation script and the
 * checked-in YAML in step with each other and with ntc-templates' index.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { allowlistVerdict } from '../../scripts/allowlist.mjs';
import { expandIndexCommand, loadIndex, matchIndex } from '../../scripts/reconcile-ntc.mjs';

const root = resolve(__dirname, '../..');
const catalogDir = join(root, 'resources/catalog');
const ntcDir = join(root, 'resources/templates/ntc');
const testsDir = join(root, 'resources/templates/tests');

interface Command {
  id: string;
  cmd: string;
  gate: string;
  parser: string;
  also?: string[];
  feeds: string[];
  verified: 'lab' | 'docs' | 'unverified';
  evidence?: string;
}
interface Catalog {
  os: string;
  ntc_platform: string | null;
  phase: number;
  fingerprint: { probe: string; match_regex: string } | null;
  caps_probe: { id: string; cmd: string; flags: Record<string, string> }[];
  commands: Command[];
  live_path: Command[];
}

const catalogs = (): Catalog[] =>
  readdirSync(catalogDir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => YAML.parse(readFileSync(join(catalogDir, f), 'utf8')) as Catalog);

describe('the read-only allowlist (JavaScript side)', () => {
  it('agrees with the shared fixture that Rust and Python also run', () => {
    const cases = JSON.parse(readFileSync(join(catalogDir, 'allowlist-cases.json'), 'utf8')) as { command: string; verdict: string }[];
    expect(cases.length).toBeGreaterThanOrEqual(20);
    for (const c of cases) expect(allowlistVerdict(c.command), c.command).toBe(c.verdict);
  });

  it('refuses what is not a string', () => {
    expect(allowlistVerdict(42)).toBe('not a string');
  });
});

describe('ntc-templates index matching, the way clitable does it', () => {
  it('expands [[completion]] shorthand exactly as textfsm does', () => {
    expect(expandIndexCommand('sh[[ow]] ver[[sion]]')).toBe('sh(o(w)?)? ver(s(i(o(n)?)?)?)?');
  });

  it('matches a platform regex and a command prefix, and stops at a word boundary', () => {
    const index = loadIndex(ntcDir);
    expect(matchIndex(index, 'cisco_ios', 'show version')?.template).toBe('cisco_ios_show_version.textfsm');
    expect(matchIndex(index, 'cisco_ios', 'sh ver')?.template).toBe('cisco_ios_show_version.textfsm');
    expect(matchIndex(index, 'hp_procurve', 'show system')?.template).toBe('hp_procurve_show_system.textfsm');
    expect(matchIndex(index, 'cisco_ftd', 'show arp')?.template).toBe('cisco_asa_show_arp.textfsm');
    expect(matchIndex(index, 'cisco_ios', 'show ip route vrf X')?.template).toBe('cisco_ios_show_ip_route.textfsm');
    // clitable would hand this the standby template; we do not.
    expect(matchIndex(index, 'cisco_ios', 'show stackwise-virtual')).toBeNull();
  });
});

describe('every checked-in catalog', () => {
  const schema = JSON.parse(readFileSync(join(catalogDir, 'schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const index = loadIndex(ntcDir);

  it('fits resources/catalog/schema.json', () => {
    for (const c of catalogs()) {
      const ok = validate(c);
      expect(ok, `${c.os}: ${JSON.stringify(validate.errors?.slice(0, 5))}`).toBe(true);
    }
  });

  it('sends nothing the allowlist refuses, api paths aside', () => {
    for (const c of catalogs()) {
      for (const cmd of [...c.commands, ...c.live_path]) {
        if (cmd.parser === 'api') continue;
        expect(allowlistVerdict(cmd.cmd), `${c.os} ${cmd.id}`).toBe('ok');
      }
      for (const p of c.caps_probe) expect(allowlistVerdict(p.cmd), `${c.os} probe ${p.id}`).toBe('ok');
      if (c.fingerprint) expect(allowlistVerdict(c.fingerprint.probe)).toBe('ok');
    }
  });

  it('names only templates that exist, and each is the one the index would pick for that command', () => {
    for (const c of catalogs()) {
      for (const cmd of c.commands) {
        const names = [cmd.parser, ...(cmd.also ?? [])].filter((p) => p.startsWith('textfsm:')).map((p) => p.slice('textfsm:'.length));
        for (const name of names) expect(existsSync(join(ntcDir, `${name}.textfsm`)), `${c.os} ${cmd.id}: ${name}`).toBe(true);
        if (cmd.parser.startsWith('textfsm:') && c.ntc_platform) {
          const probe = cmd.cmd.replace(/\{(\w+)\}/g, 'X');
          const hit = matchIndex(index, c.ntc_platform, probe);
          expect(hit?.template.split(':')[0], `${c.os} ${cmd.id}: ${cmd.cmd}`).toBe(`${names[0]}.textfsm`);
        }
      }
    }
  });

  it('claims lab only where a fixture or a hardware-met reader exists', () => {
    for (const c of catalogs()) {
      for (const cmd of c.commands) {
        if (cmd.verified !== 'lab') continue;
        const fromNtc = /ntc-templates tests \((\d+) captures\)/.exec(cmd.evidence ?? '');
        if (fromNtc) {
          const named = [cmd.parser, (cmd as { shadow?: string }).shadow ?? '', ...(cmd.also ?? [])].find((p) => p.startsWith('textfsm:')) ?? '';
          const name = named.slice('textfsm:'.length);
          const platform = readdirSync(testsDir).sort((a, b) => b.length - a.length).find((p) => name.startsWith(p + '_'));
          expect(platform, `${c.os} ${cmd.id}: ${name}`).toBeDefined();
          const dir = join(testsDir, platform!, name.slice(platform!.length + 1));
          const raws = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.raw')) : [];
          expect(raws.length, `${c.os} ${cmd.id}: ${dir}`).toBe(Number(fromNtc[1]));
          for (const raw of raws) expect(existsSync(join(dir, raw.replace(/\.raw$/, '.yml'))), `${dir}/${raw} has no .yml`).toBe(true);
        } else {
          expect(cmd.evidence, `${c.os} ${cmd.id}`).toMatch(/Coreview .* reader/);
        }
      }
    }
  });

  it('marks unverified exactly the commands with no template and no structured output', () => {
    for (const c of catalogs()) {
      for (const cmd of c.commands) {
        if (cmd.parser === 'none') expect(cmd.verified, `${c.os} ${cmd.id}`).toBe('unverified');
        if (cmd.verified === 'unverified') expect(cmd.parser, `${c.os} ${cmd.id}`).toBe('none');
      }
    }
  });
});

describe('the reconciliation table (LT-508)', () => {
  it('is checked in and its capture list is what the catalogs mark unverified (LT-511)', () => {
    const table = JSON.parse(readFileSync(join(root, 'docs/DISCOVERY-RECONCILIATION.json'), 'utf8')) as { os: string; command: string; kind: string; gate: string }[];
    const none = new Set(table.filter((r) => r.kind === 'none' && !r.gate.startsWith('live-path')).map((r) => `${r.os}\u0000${r.command}`));
    for (const c of catalogs()) {
      for (const cmd of c.commands) {
        if (cmd.verified === 'unverified') expect(none.has(`${c.os}\u0000${cmd.cmd}`), `${c.os}: ${cmd.cmd} is unverified but not in the table's list`).toBe(true);
      }
    }
  });
});
