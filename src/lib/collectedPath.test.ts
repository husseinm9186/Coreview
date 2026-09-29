import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { asTraceResult, collectionRunOf, devicesIn, endingText, toCsv, toMarkdown } from './collectedPath';
import type { PathOutcome } from './ipc';
import { devicesOnPath } from './pathTrace';

/** Written by the builder itself (`the_pages_fixture_is_what_the_builder_writes`). */
const load = (name: string) => JSON.parse(readFileSync(new URL(`../../crates/coreview-path/fixtures/${name}.json`, import.meta.url), 'utf8')) as PathOutcome;
const core = load('path-outcome');
const firewall = load('path-outcome-firewall');

describe('the path the Rust builder writes, on the page (LT-536)', () => {
  it('finds the collection a stored run was built from', () => {
    expect(collectionRunOf('collection col-1759000000000')).toBe('col-1759000000000');
    expect(collectionRunOf('192.0.2.1')).toBeNull();
    expect(collectionRunOf(undefined)).toBeNull();
  });

  it('keeps both equal-cost legs as paths the highlight and the page generator read', () => {
    const tr = asTraceResult(core.forward);
    expect(tr.kind).toBe('delivered');
    expect(tr.paths).toHaveLength(2);
    expect(tr.paths[0]![0]).toMatchObject({ device: 'ACC1', prefix: '203.0.113.0/24', protocol: 'ospf', ecmp: 2 });
    expect(new Set(devicesOnPath(tr))).toEqual(new Set(['ACC1', 'CORE1', 'CORE2', 'DC1']));
    expect(new Set(devicesIn(core))).toEqual(new Set(['ACC1', 'CORE1', 'CORE2', 'DC1']));
  });

  it('says the firewall verdict and the translation on the hop, and marks destination NAT as a segment', () => {
    const hop = asTraceResult(firewall.forward).paths[0]![0]!;
    expect(hop.segment).toEqual({ kind: 'nat', was: '203.0.113.10', now: '10.1.1.10', description: 'VIP-WEB' });
    expect(hop.notes?.join(' ')).toContain('allowed');
    expect(hop.notes?.join(' ')).toContain('web-in (1)');
  });

  it('makes a path that stops the result the page reports in red', () => {
    const stopped: PathOutcome = {
      ...firewall,
      forward: { ...firewall.forward, paths: [{ hops: [], ending: { kind: 'denied', at: 'FGT1', policy: 'block-rest (3)' } }] },
    };
    const tr = asTraceResult(stopped.forward);
    expect(tr.kind).toBe('unreachable');
    expect(tr.kind === 'unreachable' && tr.reason).toContain('block-rest (3)');
    expect(asTraceResult({ ...firewall.forward, paths: [{ hops: [], ending: { kind: 'insufficient', at: null, reason: 'No routing table was collected from R9.' } }] })).toMatchObject({ kind: 'insufficient', reason: 'No routing table was collected from R9.' });
    expect(endingText({ kind: 'unmanaged', at: 'R4', nextHop: '198.51.100.114', mac: '000000000114', name: null })).toContain('198.51.100.114');
  });

  it('exports a CSV row per hop, both ways, quoting what needs it', () => {
    const csv = toCsv(firewall);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('direction,path,hop,device,in_interface,vrf,src,dst,decision,prefix,protocol,next_hop,next_device,out_interface,firewall,nat,l2_path,notes');
    expect(lines.some((l) => l.startsWith('forward,1,1,FGT1,port1,default,203.0.113.99,203.0.113.10,connected,10.1.1.0/24'))).toBe(true);
    expect(lines.some((l) => l.startsWith('reverse,1,1,FGT1'))).toBe(true);
    expect(lines.every((l) => l.split(',').length >= 18 || l.includes('"'))).toBe(true);
  });

  it('writes a markdown report with the traceroute comparison', () => {
    const md = toMarkdown(core);
    expect(md).toContain('# Path from 192.0.2.50 to 203.0.113.50');
    expect(md).toContain('The traceroute matches the modeled path at 100%.');
    expect(md).toContain('| 1 | 198.51.100.2 | CORE1 | CORE1 | ✓ |');
    expect(md).toContain('the same routers both ways');
  });
});
