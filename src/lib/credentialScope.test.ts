import { describe, expect, it } from 'vitest';

import { credentialsUsedBy, staleCredentials, withoutStaleCredentials } from './credentialScope';
import type { ProjectDocument } from '../state/store';

const device = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'device' as const,
  position: { x: 0, y: 0 },
  data: { label: id, deviceType: 'access-switch', tags: [], ...over },
});

const doc = (over: Partial<ProjectDocument> = {}): ProjectDocument =>
  ({
    activePageId: 'p1',
    probes: [],
    pages: [{ id: 'p1', name: 'Core', canvas: {}, edges: [], nodes: [] }],
    ...over,
  }) as unknown as ProjectDocument;

describe('which credentials a project refers to (LT-335)', () => {
  it('finds the project login, the rules and every device', () => {
    const d = doc({
      credentialDefaults: { ssh: 'a', snmp: ['b', 'c'] },
      credentialRules: [{ id: 'r1', scope: 'subnet', value: '192.0.2.0/24', credentialId: 'd' }],
      pages: [
        {
          id: 'p1',
          name: 'Core',
          canvas: {},
          edges: [],
          nodes: [device('sw', { sshCredentialId: 'e', snmpCredentialId: 'f' }), device('bare')],
        },
      ],
    } as unknown as Partial<ProjectDocument>);
    expect([...credentialsUsedBy(d)].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('ignores blank and whitespace-only references', () => {
    const d = doc({ credentialDefaults: { ssh: '   ', snmp: [''] } } as Partial<ProjectDocument>);
    expect(credentialsUsedBy(d).size).toBe(0);
  });

  it('is empty for a project that has never saved one', () => {
    expect(credentialsUsedBy(doc()).size).toBe(0);
  });
});

describe('references the vault no longer has', () => {
  const d = doc({
    credentialDefaults: { ssh: 'gone', snmp: ['here', 'also-gone'] },
    pages: [
      {
        id: 'p1',
        name: 'Core',
        canvas: {},
        edges: [],
        nodes: [device('sw', { sshCredentialId: 'gone', snmpCredentialId: 'here' })],
      },
    ],
  } as unknown as Partial<ProjectDocument>);
  const vault = [{ id: 'here' }];

  it('names them, and only them', () => {
    expect(staleCredentials(d, vault)).toEqual(['also-gone', 'gone']);
  });

  it('takes them out of every place they are held', () => {
    const cleaned = withoutStaleCredentials(d, vault);
    expect(cleaned).toBeTruthy();
    expect(cleaned!.credentialDefaults?.ssh).toBeUndefined();
    expect(cleaned!.credentialDefaults?.snmp).toEqual(['here']);
    const node = cleaned!.pages[0]!.nodes[0]!;
    expect((node.data as { sshCredentialId?: string }).sshCredentialId).toBeUndefined();
    // And leaves alone the one that is still there.
    expect((node.data as { snmpCredentialId?: string }).snmpCredentialId).toBe('here');
  });

  it('says there is nothing to do rather than making a new document', () => {
    // Otherwise looking at a healthy project marks it dirty on every render,
    // which is an endless loop dressed as a feature.
    expect(withoutStaleCredentials(doc({ credentialDefaults: { ssh: 'here' } } as Partial<ProjectDocument>), vault))
      .toBeNull();
    expect(withoutStaleCredentials(doc(), [])).toBeNull();
  });

  it('a project opened on a machine with an empty vault loses every reference', () => {
    // Not an error: the vault is per machine, and the project travelled.
    const cleaned = withoutStaleCredentials(d, []);
    expect(cleaned!.credentialDefaults?.ssh).toBeUndefined();
    expect(cleaned!.credentialDefaults?.snmp).toEqual([]);
    expect(credentialsUsedBy(cleaned!).size).toBe(0);
  });
});
