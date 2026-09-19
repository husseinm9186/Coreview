import { describe, expect, it } from 'vitest';

import { PAGING_CHOICES, isPagingMode, parseCommandList } from './showCommands';

describe('show commands (LT-149)', () => {
  it('reads one command per line, dropping blanks and repeats', () => {
    expect(parseCommandList('show version\n\n  show clock  \r\nshow version\n')).toEqual([
      'show version',
      'show clock',
    ]);
    expect(parseCommandList('')).toEqual([]);
    expect(parseCommandList(undefined)).toEqual([]);
  });

  it('offers every paging mode the backend understands, once each', () => {
    const values = PAGING_CHOICES.map((c) => c.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual([
      'auto', 'cisco-ios', 'cisco-asa', 'palo-alto', 'forti-os', 'aruba-hp', 'juniper', 'huawei-h3c', 'none',
    ]);
    expect(isPagingMode('cisco-asa')).toBe(true);
    expect(isPagingMode('reload')).toBe(false);
  });

  it('never makes a saved configuration change to stop FortiOS paging', () => {
    const forti = PAGING_CHOICES.find((c) => c.value === 'forti-os')!;
    expect(forti.sends).not.toMatch(/config system console|set output/);
  });
});
