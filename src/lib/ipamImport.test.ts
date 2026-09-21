import { describe, expect, it } from 'vitest';

import { ipamRows } from './ipam';
import { parseIpamCsv, splitCsvLine } from './ipamImport';

const csv = (rows: string[][]) => rows.map((r) => r.map((c) => (/[,"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

describe('reading the register back from a spreadsheet (LT-298)', () => {
  it('splits a line, honouring quotes so a note may contain a comma', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(splitCsvLine('10.0.0.1,"Core, spare",x')).toEqual(['10.0.0.1', 'Core, spare', 'x']);
    expect(splitCsvLine('"he said ""hi""",b')).toEqual(['he said "hi"', 'b']);
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('matches columns by heading, not by position', () => {
    const out = parseIpamCsv(csv([
      ['Note', 'Address', 'Name'],
      ['spare', '192.0.2.10', 'CORE-SW1'],
    ]));
    expect(out.skipped).toEqual([]);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({ address: '192.0.2.10', label: 'CORE-SW1', note: 'spare' });
  });

  it('round-trips what ipamRows wrote', () => {
    const rows = ipamRows({
      blocks: [
        {
          cidr: '192.0.2.0/24', name: 'Core', vlan: 10, usable: 254, used: 1, free: 253,
          addresses: [
            { address: '192.0.2.10', label: 'CORE-SW1', kind: 'in-use', source: 'typed', hostname: 'core-sw1', owner: 'Network' },
          ],
        },
      ],
      loose: [],
    } as never);
    const out = parseIpamCsv(rows.map((r) => r.map((c) => (/[,"]/.test(c) ? `"${c}"` : c)).join(',')).join('\n'), ['192.0.2.0/24']);
    expect(out.skipped).toEqual([]);
    expect(out.entries[0]).toMatchObject({
      address: '192.0.2.10', label: 'CORE-SW1', kind: 'in-use', hostname: 'core-sw1', owner: 'Network',
    });
    expect(out.wantedSubnets).toEqual([]);
  });

  it('skips a row it cannot read and says which line and why', () => {
    const out = parseIpamCsv(csv([
      ['Address', 'Name'],
      ['192.0.2.10', 'ok'],
      ['not-an-address', 'bad'],
      ['', 'empty'],
    ]));
    expect(out.entries).toHaveLength(1);
    expect(out.skipped).toEqual([
      { line: 3, why: '"not-an-address" is not an address', address: 'not-an-address' },
      { line: 4, why: 'no address on this row', address: '' },
    ]);
  });

  it('reports a subnet it does not hold rather than creating one', () => {
    const out = parseIpamCsv(csv([
      ['Subnet', 'Address'],
      ['10.9.0.0/24', '10.9.0.5'],
      ['10.9.0.0/24', '10.9.0.6'],
      ['192.0.2.0/24', '192.0.2.5'],
    ]), ['192.0.2.0/24']);
    expect(out.entries).toHaveLength(3);
    expect(out.wantedSubnets).toEqual(['10.9.0.0/24']);
  });

  it('keeps both sides of a conflict out rather than taking the last', () => {
    const out = parseIpamCsv(csv([
      ['Address', 'Name'],
      ['192.0.2.10', 'first claim'],
      ['192.0.2.11', 'fine'],
      ['192.0.2.10', 'second claim'],
    ]));
    expect(out.conflicts).toEqual(['192.0.2.10']);
    expect(out.entries.map((e) => e.address)).toEqual(['192.0.2.11']);
    expect(out.skipped[0]!.why).toContain('also on line 2');
  });

  it('falls back to in-use for a kind it does not recognise, and drops a bad assignment', () => {
    const out = parseIpamCsv(csv([
      ['Address', 'Held as', 'Used as'],
      ['192.0.2.10', 'nonsense', 'nonsense'],
      ['192.0.2.11', 'reserved', ''],
    ]));
    expect(out.entries[0]!.kind).toBe('in-use');
    expect(out.entries[0]!.assignment).toBeUndefined();
    expect(out.entries[1]!.kind).toBe('reserved');
  });

  it('a file with no Address column is refused with a reason, not half-read', () => {
    const out = parseIpamCsv(csv([['Name', 'Note'], ['CORE-SW1', 'spare']]));
    expect(out.entries).toEqual([]);
    expect(out.skipped[0]!.why).toContain('no Address column');
  });

  it('an empty file is nothing rather than a crash', () => {
    expect(parseIpamCsv('')).toEqual({ entries: [], wantedSubnets: [], skipped: [], conflicts: [] });
    expect(parseIpamCsv('\n\n')).toEqual({ entries: [], wantedSubnets: [], skipped: [], conflicts: [] });
  });
});
