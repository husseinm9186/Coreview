import { describe, expect, it } from 'vitest';

import { guessKind, guessMapping, headerRowOf, mapRows } from './columnMap';
import { nodesToCsv, parseCsv } from './csv';

describe('column mapping (LT-245)', () => {
  it('guesses an inventory with its own spellings', () => {
    const header = ['Hostname', 'Mgmt IP', 'Manufacturer', 'Serial No', 'Location', 'Comments'];
    expect(guessKind(header)).toBe('devices');
    const m = guessMapping(header, 'devices');
    expect(m).toMatchObject({ name: 0, address: 1, vendor: 2, serial: 3, site: 4, notes: 5, type: null });
  });

  it('keeps a Hostname column apart when there is a Name column', () => {
    // The columns this app's own export writes.
    const header = parseCsv(nodesToCsv([]))[0]!;
    const m = guessMapping(header, 'devices');
    expect(header[m.name!]).toBe('Name');
    expect(header[m.address!]).toBe('IP');
  });

  it('recognises a link list and reads it through the mapping', () => {
    const grid = [['Device A', 'Port A', 'Device B', 'Port B', 'Cable ID'], ['CORE-SW1', 'Gi1/0/1', 'EDGE-RTR1', 'Gi0/0', 'C-0101'], ['', '', '', '', ''], ['CORE-SW1', 'Gi1/0/2', '', '', '']];
    expect(guessKind(grid[0]!)).toBe('links');
    const m = guessMapping(grid[0]!, 'links');
    const r = mapRows(grid, m, 'links');
    expect(r.rows).toEqual([{ source: 'CORE-SW1', target: 'EDGE-RTR1', sourcePort: 'Gi1/0/1', targetPort: 'Gi0/0', label: 'C-0101', healthRule: 'both-endpoints' }]);
    expect(r.errors).toEqual(['Row 4: needs both ends; skipped.']);
  });

  it('reads devices, undoing the formula guard an export adds', () => {
    const grid = [['Inventory, level 2'], ['Name', 'IP', 'Rack', 'Tags'], ["'=SW1", '192.0.2.1', 'R01', 'core; lab'], ['', '192.0.2.2', '', '']];
    const at = headerRowOf(grid);
    expect(at).toBe(1);
    const r = mapRows(grid, guessMapping(grid[at]!, 'devices'), 'devices', at);
    expect(r.kind).toBe('devices');
    expect(r.rows[0]).toMatchObject({ name: '=SW1', address: '192.0.2.1', rack: 'R01', tags: ['core', 'lab'], probeType: 'icmp' });
    expect(r.errors).toEqual(['Row 4: no name; skipped.']);
  });

  it('lets the person override a guess, including leaving a field out', () => {
    const grid = [['Name', 'IP', 'Backup IP'], ['SW1', '192.0.2.1', '198.51.100.1']];
    const m = { ...guessMapping(grid[0]!, 'devices'), address: 2 };
    expect(mapRows(grid, m, 'devices').rows[0]!).toMatchObject({ address: '198.51.100.1' });
    expect(mapRows(grid, { ...m, address: null }, 'devices').rows[0]!).toMatchObject({ address: '' });
  });
});
