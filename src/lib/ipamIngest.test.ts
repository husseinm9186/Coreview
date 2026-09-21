import { describe, expect, it } from 'vitest';

import type { AttachedDevice, CrawlResult, CrawledDevice } from './ipc';
import type { IpamEntry } from './ipam';
import { asEntry, planIngest } from './ipamIngest';

const attached = (a: Partial<AttachedDevice>): AttachedDevice => ({
  mac: '00:00:5e:00:53:99', port: 'Gi0/9', address: null, vendor: null,
  hostname: null, class: null, vlan: null, portPopulation: 1, ...a,
});

const device = (d: Partial<CrawledDevice>): CrawledDevice =>
  ({
    hostname: 'LAB-ACCESS-SW1', address: '192.0.2.11',
    addresses: [{ ip: '192.0.2.11', interface: 'Vlan1', isManagement: false }],
    probeTarget: '192.0.2.11', class: 'switch', platform: null, serial: null,
    version: null, neighbors: [], hops: 0, reachedBy: 'ssh', attached: [], ...d,
  }) as CrawledDevice;

const result = (devices: CrawledDevice[]): CrawlResult =>
  ({ devices, notVisited: [], failures: [], cancelled: false }) as CrawlResult;

const entry = (address: string): IpamEntry =>
  ({ id: address, address, label: 'typed by hand', kind: 'in-use' }) as IpamEntry;

describe('ingesting what a crawl saw (LT-299)', () => {
  it('takes a device its own addresses', () => {
    const plan = planIngest(result([device({})]));
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      address: '192.0.2.11', hostname: 'LAB-ACCESS-SW1', seenOn: 'LAB-ACCESS-SW1 Vlan1', isDeviceItself: true,
    });
  });

  it('takes what a device learned, which is the part no diagram holds', () => {
    const plan = planIngest(result([
      device({ attached: [attached({ address: '192.0.2.60', hostname: 'PRINTER-2F', port: 'Gi0/7', vlan: '14' })] }),
    ]));
    const printer = plan.candidates.find((c) => c.address === '192.0.2.60');
    expect(printer).toMatchObject({ hostname: 'PRINTER-2F', seenOn: 'LAB-ACCESS-SW1 Gi0/7', vlan: '14', isDeviceItself: false });
  });

  it('names a nameless thing by its maker, then by where it was seen', () => {
    const plan = planIngest(result([
      device({ attached: [
        attached({ address: '192.0.2.61', vendor: 'Hewlett Packard' }),
        attached({ address: '192.0.2.62', port: 'Gi0/8' }),
      ] }),
    ]));
    expect(plan.candidates.find((c) => c.address === '192.0.2.61')!.label).toBe('Hewlett Packard');
    expect(plan.candidates.find((c) => c.address === '192.0.2.62')!.label).toBe('seen on LAB-ACCESS-SW1 Gi0/8');
  });

  it('leaves alone what the register already holds, and counts it', () => {
    const plan = planIngest(result([device({})]), [entry('192.0.2.11')]);
    expect(plan.candidates).toEqual([]);
    expect(plan.alreadyHeld).toBe(1);
  });

  it('does not overwrite something typed by hand', () => {
    const existing = [entry('192.0.2.11')];
    const plan = planIngest(result([device({})]), existing);
    expect(plan.candidates.some((c) => c.address === '192.0.2.11')).toBe(false);
    expect(existing[0]!.label).toBe('typed by hand');
  });

  it('counts one address once however many devices saw it', () => {
    const plan = planIngest(result([
      device({ hostname: 'SW1', addresses: [], attached: [attached({ address: '192.0.2.90' })] }),
      device({ hostname: 'SW2', addresses: [], attached: [attached({ address: '192.0.2.90' })] }),
    ]));
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]!.seenOn).toContain('SW1');
  });

  it('prefers the device own claim over something that merely learned of it', () => {
    const plan = planIngest(result([
      device({ hostname: 'CORE', addresses: [{ ip: '192.0.2.5', interface: 'Lo0', isManagement: false }] }),
      device({ hostname: 'SW2', addresses: [], attached: [attached({ address: '192.0.2.5', hostname: 'guessed' })] }),
    ]));
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({ isDeviceItself: true, hostname: 'CORE' });
  });

  it('says once that IPv6 is not something this register holds', () => {
    const plan = planIngest(result([
      device({ addresses: [{ ip: '2001:db8::1', interface: 'Lo0', isManagement: false }, { ip: '2001:db8::1', interface: 'Lo1', isManagement: false }] }),
    ]));
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped).toEqual([{ value: '2001:db8::1', why: 'IPv6 — the register holds IPv4' }]);
  });

  it('an empty or absent crawl plans nothing rather than throwing', () => {
    expect(planIngest(null)).toEqual({ candidates: [], alreadyHeld: 0, skipped: [] });
    expect(planIngest(result([]))).toEqual({ candidates: [], alreadyHeld: 0, skipped: [] });
  });

  it('records an ingested address as observed, never as intended', () => {
    const plan = planIngest(result([
      device({ attached: [attached({ address: '192.0.2.60', hostname: 'PRINTER-2F', port: 'Gi0/7', vlan: '14' })] }),
    ]));
    const e = asEntry(plan.candidates.find((c) => c.address === '192.0.2.60')!);
    expect(e.kind).toBe('in-use');
    expect(e.note).toBe('Seen by a crawl on LAB-ACCESS-SW1 Gi0/7, VLAN 14');
  });
});
