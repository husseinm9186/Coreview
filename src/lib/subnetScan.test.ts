import { describe, expect, it } from 'vitest';
import { scannedOf, sweptLine } from './subnetScan';

describe('the box beside a subnet', () => {
  it('sends only ticked subnets that are still listed, each once', () => {
    expect(scannedOf(['192.0.2.0/24', '198.51.100.0/24'], ['192.0.2.0/24', ' 192.0.2.0/24', '203.0.113.0/24'])).toEqual(['192.0.2.0/24']);
    expect(scannedOf([], ['192.0.2.0/24'])).toEqual([]);
  });

  it('says plainly when nothing answered from this computer', () => {
    expect(sweptLine({ subnet: '192.0.2.0/24', tried: 254, answered: 0 })).toMatch(/none of 254.*through their neighbours/);
    expect(sweptLine({ subnet: '192.0.2.0/24', tried: 254, answered: 1 })).toMatch(/1 of 254 .* is logged into/);
    expect(sweptLine({ subnet: '192.0.2.0/24', tried: 254, answered: 7 })).toMatch(/7 of 254 .* are logged into/);
  });
});
