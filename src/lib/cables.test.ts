import { describe, expect, it } from 'vitest';

import { CABLES, CABLE_TYPES, cableTag, centreLabel, isCableType } from './cables';

describe('cable types (LT-167)', () => {
  it('offers the seven the mission names, each with its own tag', () => {
    expect(CABLE_TYPES).toEqual(['copper', 'fiber-sm', 'fiber-mm', 'coax', 'wireless', 'wan', 'trunk']);
    const tags = CABLE_TYPES.map((c) => CABLES[c].tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('knows a cable type from anything else, prototype keys included', () => {
    expect(isCableType('fiber-sm')).toBe(true);
    expect(isCableType('toString')).toBe(false);
    expect(isCableType(undefined)).toBe(false);
  });

  it('leads the centre label with the tag', () => {
    expect(centreLabel({ cableType: 'fiber-sm', label: '10G uplink' })).toBe('SMF · 10G uplink');
    expect(centreLabel({ cableType: 'wireless', label: '' })).toBe('Wi-Fi');
    expect(centreLabel({ label: 'Uplink' })).toBe('Uplink');
    expect(centreLabel({ label: '  ' })).toBe('');
    expect(cableTag({})).toBe('');
  });
});
