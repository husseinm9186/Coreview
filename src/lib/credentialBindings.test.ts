import { describe, expect, it } from 'vitest';

import type { ProjectDocument, TopoNode } from '../state/store';
import { bindingsFor, ruleProblem } from './credentialBindings';

const dev = (id: string, data: Record<string, unknown>) =>
  ({ id, type: 'device', position: { x: 0, y: 0 }, data: { label: id, deviceType: 'switch', tags: [], addresses: [], locked: false, maintenance: false, showDetails: false, ...data } }) as unknown as TopoNode;
const doc = (nodes: TopoNode[], rules: ProjectDocument['credentialRules'] = []) =>
  ({ pages: [{ id: 'p', name: 'P', nodes, edges: [], canvas: {} }], activePageId: 'p', probes: [], credentialRules: rules }) as unknown as ProjectDocument;

describe('credential bindings (LT-199, LT-209)', () => {
  it('binds a device’s saved credentials by each of its addresses and its name', () => {
    const got = bindingsFor(doc([
      dev('a', { hostname: 'CORE-SW1', sshCredentialId: 'c-ssh', snmpCredentialId: 'c-snmp',
        addresses: [{ id: '1', label: 'M', address: '192.0.2.10', isPrimary: true }, { id: '2', label: 'L', address: '198.51.100.1', isPrimary: false }] }),
      dev('b', { addresses: [{ id: '3', label: 'M', address: '192.0.2.11', isPrimary: true }] }),
    ]));
    expect(got).toEqual([
      { scope: 'device', value: '192.0.2.10', credentialId: 'c-ssh' },
      { scope: 'device', value: '198.51.100.1', credentialId: 'c-ssh' },
      { scope: 'device', value: 'CORE-SW1', credentialId: 'c-ssh' },
      { scope: 'device', value: '192.0.2.10', credentialId: 'c-snmp' },
      { scope: 'device', value: '198.51.100.1', credentialId: 'c-snmp' },
      { scope: 'device', value: 'CORE-SW1', credentialId: 'c-snmp' },
    ]);
  });

  it('adds the project’s rules after, leaving out any that are incomplete or wrong', () => {
    const got = bindingsFor(doc([], [
      { id: 'r1', scope: 'subnet', value: ' 192.0.2.0/24 ', credentialId: 'site' },
      { id: 'r2', scope: 'vendor', value: 'FortiSwitch', credentialId: 'forti' },
      { id: 'r3', scope: 'subnet', value: '192.0.2.0', credentialId: 'x' },
      { id: 'r4', scope: 'vendor', value: 'Aruba', credentialId: '' },
    ]));
    expect(got).toEqual([
      { scope: 'subnet', value: '192.0.2.0/24', credentialId: 'site' },
      { scope: 'vendor', value: 'FortiSwitch', credentialId: 'forti' },
    ]);
  });

  it('says what is wrong with a rule', () => {
    expect(ruleProblem({ scope: 'subnet', value: '192.0.2.0/24' })).toBeNull();
    expect(ruleProblem({ scope: 'subnet', value: '192.0.2.300/24' })).toMatch(/not a subnet/);
    expect(ruleProblem({ scope: 'subnet', value: '' })).toMatch(/Give a subnet/);
    expect(ruleProblem({ scope: 'vendor', value: 'aruba' })).toBeNull();
  });
});
