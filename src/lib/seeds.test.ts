import { describe, expect, it } from 'vitest';

import { seedsFromCsv } from './seeds';

describe('crawl seeds from a CSV (LT-207)', () => {
  it('takes the address column when there is one', () => {
    const csv = 'Name,Management IP,Notes\nCORE-SW1,192.0.2.10,core\nACC-SW1,192.0.2.11,"third floor, west"\n';
    expect(seedsFromCsv(csv)).toEqual(['192.0.2.10', '192.0.2.11']);
  });

  it('prefers an address column to a name column', () => {
    expect(seedsFromCsv('hostname,ip\ncore-sw1,192.0.2.10\n')).toEqual(['192.0.2.10']);
    expect(seedsFromCsv('hostname,site\ncore-sw1.example.test,HQ\n')).toEqual(['core-sw1.example.test']);
  });

  it('without a heading, takes only cells that are addresses or ranges, once each', () => {
    const csv = 'switch,192.0.2.10\nrouter,198.51.100.0/30\nthing,192.0.2.10\nnotes,hello world\n';
    expect(seedsFromCsv(csv)).toEqual(['192.0.2.10', '198.51.100.0/30']);
  });

  it('is empty for an empty file', () => {
    expect(seedsFromCsv('')).toEqual([]);
  });
});
