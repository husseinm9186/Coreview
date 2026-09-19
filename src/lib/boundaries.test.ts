import { describe, expect, it } from 'vitest';

import { BOUNDARIES, BOUNDARY_KINDS, boundaryChip, boundaryIdProblem, isBoundaryKind } from './boundaries';

describe('logical boundaries (LT-166)', () => {
  it('offers the six kinds the mission names, each drawn differently', () => {
    expect(BOUNDARY_KINDS).toEqual(['vlan', 'subnet', 'security-zone', 'vrf', 'bgp-as', 'ospf-area']);
    const dashes = BOUNDARY_KINDS.map((k) => BOUNDARIES[k].dash);
    expect(new Set(dashes).size).toBe(dashes.length);
  });

  it('knows a kind from anything else', () => {
    expect(isBoundaryKind('vrf')).toBe(true);
    expect(isBoundaryKind('toString')).toBe(false);
    expect(isBoundaryKind(undefined)).toBe(false);
  });

  it('checks a VLAN ID', () => {
    expect(boundaryIdProblem('vlan', '1')).toBeNull();
    expect(boundaryIdProblem('vlan', '4094')).toBeNull();
    for (const bad of ['0', '4095', '10a', '-1', '1.5']) expect(boundaryIdProblem('vlan', bad), bad).not.toBeNull();
  });

  it('checks a subnet, IPv4 and IPv6', () => {
    for (const ok of ['192.0.2.0/24', '0.0.0.0/0', '2001:db8::/32', '2001:db8:0:0:0:0:0:1/128', '::/0']) {
      expect(boundaryIdProblem('subnet', ok), ok).toBeNull();
    }
    for (const bad of ['192.0.2.0', '192.0.2.0/33', '300.0.2.0/24', '2001:db8::/129', '2001:db8::1::/64', 'lan/24', '1.2.3.4/24/1']) {
      expect(boundaryIdProblem('subnet', bad), bad).not.toBeNull();
    }
  });

  it('checks a VRF name and a zone name', () => {
    expect(boundaryIdProblem('vrf', 'MGMT_1')).toBeNull();
    expect(boundaryIdProblem('vrf', 'has space')).not.toBeNull();
    expect(boundaryIdProblem('security-zone', 'DMZ')).toBeNull();
    expect(boundaryIdProblem('security-zone', 'x'.repeat(61))).not.toBeNull();
  });

  it('checks an AS number, plain and asdot', () => {
    for (const ok of ['64500', '4294967295', '1.10', '0.1']) expect(boundaryIdProblem('bgp-as', ok), ok).toBeNull();
    for (const bad of ['0', '4294967296', '0.0', '65536.1', 'AS64500']) expect(boundaryIdProblem('bgp-as', bad), bad).not.toBeNull();
  });

  it('checks an OSPF area, number or dotted', () => {
    for (const ok of ['0', '51', '0.0.0.1']) expect(boundaryIdProblem('ospf-area', ok), ok).toBeNull();
    for (const bad of ['0.0.1', 'backbone', '-1']) expect(boundaryIdProblem('ospf-area', bad), bad).not.toBeNull();
  });

  it('does not complain about an identifier not typed yet', () => {
    for (const k of BOUNDARY_KINDS) expect(boundaryIdProblem(k, '  ')).toBeNull();
  });

  it('titles the chip by kind', () => {
    expect(boundaryChip({ boundaryKind: 'vlan', boundaryId: '20' })).toBe('VLAN 20');
    expect(boundaryChip({ boundaryKind: 'subnet', boundaryId: '192.0.2.0/24' })).toBe('192.0.2.0/24');
    expect(boundaryChip({ boundaryKind: 'bgp-as', boundaryId: '64500' })).toBe('AS 64500');
    expect(boundaryChip({ boundaryKind: 'ospf-area', boundaryId: '0' })).toBe('Area 0');
    expect(boundaryChip({ boundaryKind: 'vrf' })).toBe('VRF');
    expect(boundaryChip({ boundaryKind: 'subnet' })).toBe('Subnet');
    expect(boundaryChip({})).toBe('');
  });
});
