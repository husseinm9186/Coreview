import { readFileSync, writeFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { backupCheck, backupInput, crawlInput, credentialInput, eventRow, probeConfig, projectPackage, saveCredential, sweepOptions, visioDrawing } from './ipcPayloads';
import type { EventRow, Probe } from '../types/domain';

// Every field set, and one field the backend does not declare on each object,
// which the builders must drop. Obviously fake secrets (CLAUDE.md).
const extra = { injected: 'dropped' };

const probe = {
  id: 'probe-1', projectId: 'project-1', objectKind: 'node', objectId: 'node-1', name: 'Primary', kind: 'https', target: 'core-sw1.example.test',
  tcpPort: 443, intervalSeconds: 5, timeoutMs: 1000, failureThreshold: 3, recoveryThreshold: 2, warningLatencyMs: 100, enabled: true,
  maintenance: false, isPrimary: true, notes: 'kept in the document, not sent', httpPath: '/health', ignoreCertErrors: false,
  expectedAddress: '192.0.2.10', expectedBody: 'ok', udpPayload: 'ntp', dnsServer: '192.0.2.53', dnsRecord: 'A', snmpCredentialId: 'cred-snmp', ...extra,
} as unknown as Probe;

const payloads: Record<string, unknown> = {
  probe_config: probeConfig(probe),
  project_package: projectPackage({
    meta: { id: 'project-1', name: 'Lab', customer: 'Example Co', site: 'HQ', ticket: 'CHG-1', engineer: 'Sam', description: '', createdAt: 1, updatedAt: 2, archived: false, ...extra },
    documentVersion: 1,
    document: { pages: [], anything: 'the document is opaque to Rust' },
    ...extra,
  } as never),
  event_row: eventRow({
    id: 'event-1', projectId: 'project-1', sessionId: 'session-1', timestampMs: 3, objectType: 'node', objectId: 'node-1', objectName: 'CORE-SW1',
    eventType: 'transition', previousStatus: 'healthy', currentStatus: 'down', probeType: 'icmp', target: '192.0.2.10', rttMs: 1.5, message: 'No reply', ...extra,
  } as EventRow),
  credential_input: credentialInput({ username: 'reader', password: 'not-a-real-password', enablePassword: 'not-a-real-enable', ...extra }),
  crawl_input: crawlInput({
    seed: '192.0.2.1', subnets: ['192.0.2.0/24'], crawlClasses: ['switch'], maxHops: 3, maxDevices: 200, secondFactor: false,
    addressPreference: 'management', interfaceName: 'Vlan1', port: 22, transport: 'ssh', vdom: 'root',
    snmp: [{ version: 'v3', community: 'not-a-real-community', username: 'reader', authProtocol: 'sha', authPassword: 'not-a-real-auth', privacy: 'aes 256', privacyPassword: 'not-a-real-priv', ...extra }],
    credentialId: 'cred-ssh', snmpCredentialIds: ['cred-snmp'], details: { routes: true, spanningTree: false, vlans: true, ...extra },
    bindings: [{ scope: 'subnet', value: '192.0.2.0/24', credentialId: 'cred-ssh', ...extra }], reverseDns: true, concurrency: 4,
    perHostTimeoutSecs: 120, retries: 1, ...extra,
  }),
  backup_input: backupInput({
    credentialId: 'cred-ssh', targets: [{ address: '192.0.2.10', name: 'CORE-SW1', commands: ['show version'], site: 'HQ', ...extra }],
    kinds: ['running', 'startup'], secondFactor: false, port: 22, showCommands: ['show inventory'], paging: 'auto', filePattern: '{device}-{stamp}', ...extra,
  }),
  sweep_options: sweepOptions({ timeoutMs: 800, concurrency: 64, identify: true, scanPorts: true, ...extra }),
  save_credential: saveCredential({ id: 'cred-ssh', label: 'Read-only', kind: 'ssh', username: 'reader', secret: 'not-a-real-password', secondSecret: 'not-a-real-enable', detail: '', ...extra }),
  check: backupCheck({ id: 'check-1', name: 'NTP synchronised', command: 'show ntp status', expect: 'contains', pattern: 'synchronized', ignoreCase: true, ...extra }),
  visio_drawing: visioDrawing({
    title: 'Lab', ...extra,
    pages: [{ name: 'Core', width: 1584, height: 1224, ...extra,
      shapes: [{ id: 'a', name: 'CORE-SW1', x: 0, y: 0, width: 76, height: 76, ...extra }],
      links: [{ from: 'a', to: 'a', label: 'Gi0/1', points: [[10, 20]], ...extra }] }],
  }),
};

const fixture = (name: string) => new URL(`../../src-tauri/fixtures/ipc/${name}.json`, import.meta.url);

describe('what the backend is sent (LT-259)', () => {
  for (const [name, payload] of Object.entries(payloads)) {
    it(`${name} matches its fixture, with nothing undeclared`, () => {
      const json = `${JSON.stringify(payload, null, 2)}\n`;
      if (process.env.UPDATE_IPC_FIXTURES) writeFileSync(fixture(name), json);
      expect(json).not.toContain('injected');
      expect(json).toBe(readFileSync(fixture(name), 'utf8'));
    });
  }

  it('keeps a probe\'s document-only fields out of what the engine is sent', () => {
    const sent = payloads.probe_config as Record<string, unknown>;
    expect(sent).not.toHaveProperty('is_primary');
    expect(sent).not.toHaveProperty('notes');
    expect(sent).toHaveProperty('snmp_credential_id', 'cred-snmp');
  });
});
