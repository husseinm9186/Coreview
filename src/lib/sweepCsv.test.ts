import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { parsePortList, sweepCsv } from './sweepCsv';
import type { SweepHit } from './ipc';

describe('the sweep\'s ports and export (LT-440)', () => {
  it('reads a typed port list: numbers in range, once each, in order', () => {
    expect(parsePortList('22, 161 443;22 0 70000 abc 8291')).toEqual([22, 161, 443, 8291]);
    expect(parsePortList('')).toEqual([]);
  });

  it('writes one row per hit with what the sweep learned', () => {
    const hit = (over: Partial<SweepHit>): SweepHit => ({
      ip: '192.0.2.10', rttMs: 1.26, hostname: 'printer-2', nameSource: 'mdns', mac: '00:00:5e:00:53:01', vendor: 'Contoso',
      ports: [{ port: 9100, service: 'JetDirect' }, { port: 4000, service: '' }], serial: null, product: null, webServer: null, webTitle: null,
      ...over,
    } as SweepHit);
    const rows = parseCsv(sweepCsv([hit({}), hit({ ip: '192.0.2.11', hostname: null, nameSource: null, ports: [], rttMs: null })]));
    expect(rows[0]).toEqual(['Address', 'Name', 'Name from', 'MAC', 'Manufacturer', 'RTT ms', 'Open ports', 'Serial']);
    expect(rows[1]).toEqual(['192.0.2.10', 'printer-2', 'mdns', '00:00:5e:00:53:01', 'Contoso', '1.3', '9100/JetDirect 4000', '']);
    expect(rows[2]).toEqual(['192.0.2.11', '', '', '00:00:5e:00:53:01', 'Contoso', '', '', '']);
  });
});
