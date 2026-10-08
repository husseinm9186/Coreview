import { describe, expect, it } from 'vitest';
import { intentFindings, intentUnjudged, newIntentRule, ruleComplete, ruleLabel, type IntentRule } from './intentChecks';
import type { CrawledDevice, Neighbor } from './ipc';

// Invented, on documentation addresses.
const neighbour = (name: string, local: string, remote: string): Neighbor => ({
  deviceId: name, serial: null, shortName: name, addresses: [{ ip: '192.0.2.99', interface: null, isManagement: false }],
  localInterface: local, remoteInterface: remote, platform: null, capabilities: [], version: null, class: 'switch', discoveredBy: 'cdp', chassisId: null, vendor: null,
});
const device = (hostname: string, over: Partial<CrawledDevice>): CrawledDevice => ({
  hostname, serial: null, address: '192.0.2.1', addresses: [], probeTarget: '192.0.2.1', class: 'switch', platform: null, version: null,
  neighbors: [], hops: 0, reachedBy: 'ssh', attached: [], ...over,
});

const core = device('CORE', {
  neighbors: [neighbour('ACCESS', 'Gi1/0/1', 'Gi0/24')],
  portVlans: [
    { port: 'Gi1/0/1', mode: 'trunk', vlan: null, trunkVlans: [10, 20] },
    { port: 'Gi1/0/2', mode: 'trunk', vlan: null, trunkVlans: [10, 20, 30] },
    { port: 'Gi1/0/3', mode: 'access', vlan: 99, trunkVlans: [] },
  ],
  ports: [
    { port: 'Gi1/0/1', description: '', status: 'connected', vlan: 'trunk', duplex: 'a-full', speed: 'a-1000', media: '' },
    { port: 'Gi1/0/3', description: '', status: 'connected', vlan: '99', duplex: 'a-half', speed: 'a-100', media: '' },
  ],
  uptimeSeconds: 3 * 86_400,
});
const access = device('ACCESS', {
  ports: [{ port: 'Gi0/24', description: '', status: 'connected', vlan: 'trunk', duplex: 'a-full', speed: 'a-100', media: '' }],
  portVlans: [{ port: 'Gi0/2', mode: 'access', vlan: 10, trunkVlans: [] }],
  uptimeSeconds: 40 * 86_400,
});

const rules: IntentRule[] = [
  { id: 'a', kind: 'trunkCarriesVlan', vlan: 30 },
  { id: 'b', kind: 'accessVlanAllowed', vlans: [10, 20] },
  { id: 'c', kind: 'noHalfDuplex' },
  { id: 'd', kind: 'linkEndsAgree' },
  { id: 'e', kind: 'uptimeAtLeastDays', days: 7 },
];

describe('intent checks over the crawl', () => {
  it('names the device and the port that broke each rule', () => {
    const found = intentFindings([core, access], rules);
    expect(found.map((f) => f.message)).toEqual([
      'Every trunk carries VLAN 30: CORE Gi1/0/1 is a trunk without it (carries 10, 20).',
      'Access ports only on VLANs 10, 20: CORE Gi1/0/3 is an access port on VLAN 99.',
      'No port runs half-duplex: CORE Gi1/0/3 is a-half at a-100.',
      'Both ends of a link agree on speed and duplex: CORE Gi1/0/1 is a-1000/a-full, ACCESS Gi0/24 is a-100/a-full.',
      'Every device up at least 7 days: CORE has been up 3 days.',
    ]);
    expect(found.every((f) => f.kind === 'intent' && f.severity === 'warning')).toBe(true);
    expect(found[3]?.devices).toEqual(['CORE', 'ACCESS']);
  });

  it('claims nothing for a device without the table, and says which rules nobody could judge', () => {
    const bare = device('BARE', {});
    expect(intentFindings([bare], rules)).toEqual([]);
    expect(intentUnjudged([bare], rules).map((r) => r.kind)).toEqual(['trunkCarriesVlan', 'accessVlanAllowed', 'noHalfDuplex', 'linkEndsAgree', 'uptimeAtLeastDays']);
    expect(intentUnjudged([core, access], rules)).toEqual([]);
  });

  it('builds a rule from what was typed and knows when it is not ready', () => {
    const r = newIntentRule('accessVlanAllowed', '10, 20 x 0');
    expect(r).toMatchObject({ kind: 'accessVlanAllowed', vlans: [10, 20] });
    expect(ruleComplete(newIntentRule('trunkCarriesVlan', ''))).toBe(false);
    expect(ruleComplete(newIntentRule('noHalfDuplex'))).toBe(true);
    expect(ruleLabel(newIntentRule('uptimeAtLeastDays', '30'))).toBe('Every device up at least 30 days');
  });
});
