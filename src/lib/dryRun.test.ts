import { describe, expect, it } from 'vitest';

import { credentialOrder, dryRun } from './dryRun';

const label = (id: string) => ({ core: 'Core login', site: 'Site login', forti: 'Forti login', snmp: 'SNMP' })[id] ?? id;

describe('a crawl dry run (LT-211)', () => {
  const base = {
    seed: '192.0.2.10, core-sw1.example.test, 198.51.100.0/29, 10.0.0.0/8, bad_name!, 203.0.113.5',
    subnets: ['192.0.2.0/24', '198.51.100.0/30'],
    maxHops: 3,
    maxDevices: 500,
    port: 22,
    concurrency: 8,
    perHostTimeoutSecs: 300,
    retries: 2,
    secondFactor: false,
    bindings: [
      { scope: 'vendor' as const, value: 'FortiSwitch', credentialId: 'forti' },
      { scope: 'subnet' as const, value: '192.0.2.0/24', credentialId: 'site' },
      { scope: 'device' as const, value: '192.0.2.10', credentialId: 'core' },
    ],
  };

  it('describes each seed without sending anything', () => {
    const plan = dryRun(base, label, 'the login typed above');
    expect(plan.seeds).toEqual([
      { kind: 'address', seed: '192.0.2.10', allowed: true, credentials: ['Core login', 'Site login (192.0.2.0/24)', 'Forti login (if a neighbour reports FortiSwitch)', 'the login typed above'] },
      { kind: 'hostname', seed: 'core-sw1.example.test' },
      { kind: 'range', seed: '198.51.100.0/29', addresses: 6, allowed: 3, credentials: ['Forti login (if a neighbour reports FortiSwitch)', 'the login typed above'] },
      { kind: 'invalid', seed: '10.0.0.0/8', reason: 'larger than a /20; sweep it first' },
      { kind: 'invalid', seed: 'bad_name!', reason: 'not an address, a range or a hostname' },
      { kind: 'address', seed: '203.0.113.5', allowed: false, credentials: ['Forti login (if a neighbour reports FortiSwitch)', 'the login typed above'] },
    ]);
  });

  it('lists the limits and only the commands the run asks for', () => {
    const plan = dryRun({ ...base, details: { routes: false, spanningTree: true, vlans: false }, secondFactor: true }, label, 'x');
    expect(plan.limits).toContain('8 at once, logging in one at a time for the push factor');
    expect(plan.limits).toContain('Give up on a device after 5 min; retry one that does not answer 2 times');
    expect(plan.commands).toContain('show spanning-tree');
    expect(plan.commands).not.toContain('show ip route');
    expect(plan.commands).not.toContain('show vlan brief');
    expect(plan.snmp).toMatch(/No SNMP/);
  });

  it('warns when there is no subnet limit', () => {
    expect(dryRun({ ...base, subnets: [] }, label, 'x').limits[1]).toMatch(/No subnet limit/);
  });

  it('orders credentials the way the crawl does: device, narrowest subnet, vendor, then the run', () => {
    expect(credentialOrder('192.0.2.200', [
      { scope: 'subnet', value: '192.0.2.0/24', credentialId: 'site' },
      { scope: 'subnet', value: '192.0.2.128/25', credentialId: 'core' },
    ], label, 'run')).toEqual(['Core login (192.0.2.128/25)', 'Site login (192.0.2.0/24)', 'run']);
  });
});
