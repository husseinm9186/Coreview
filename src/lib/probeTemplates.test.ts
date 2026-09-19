import { describe, expect, it } from 'vitest';

import type { Probe } from '../types/domain';
import { probeFromTemplate, targetOf, templateFromProbe, withTemplate } from './probeTemplates';

const probe: Probe = {
  id: 'p1', projectId: 'proj', objectKind: 'node', objectId: 'n1', name: 'Health', kind: 'https', target: '192.0.2.10',
  tcpPort: 8443, intervalSeconds: 30, timeoutMs: 2000, failureThreshold: 2, recoveryThreshold: 1, warningLatencyMs: 250,
  enabled: true, maintenance: false, isPrimary: true, httpPath: '/health', ignoreCertErrors: true, expectedBody: 'OK',
};

describe('probe templates (LT-222)', () => {
  it('keeps a probe’s settings and drops what belongs to its device', () => {
    const t = templateFromProbe(probe, ' HTTPS health ', 't1');
    expect(t).toEqual({
      id: 't1', name: 'HTTPS health', kind: 'https', tcpPort: 8443, intervalSeconds: 30, timeoutMs: 2000, failureThreshold: 2,
      recoveryThreshold: 1, warningLatencyMs: 250, httpPath: '/health', ignoreCertErrors: true, expectedBody: 'OK',
    });
    expect(JSON.stringify(t)).not.toContain('192.0.2.10');
  });

  it('makes a probe for another device, aimed at its address and not primary', () => {
    const p = probeFromTemplate(templateFromProbe(probe, 'HTTPS health', 't1'), 'node', 'n2', 'proj', '192.0.2.11', 'p2');
    expect(p).toMatchObject({ id: 'p2', objectId: 'n2', target: '192.0.2.11', kind: 'https', httpPath: '/health', isPrimary: false, enabled: true, name: 'HTTPS health' });
  });

  it('aims at the primary address, and replaces a template saved again by name', () => {
    expect(targetOf({ addresses: [{ id: 'a', label: 'L', address: '198.51.100.1', isPrimary: false }, { id: 'b', label: 'M', address: '192.0.2.1', isPrimary: true }] } as never)).toBe('192.0.2.1');
    const list = withTemplate([], templateFromProbe(probe, 'Health', 't1'));
    const again = withTemplate(list, { ...templateFromProbe(probe, 'health', 't9'), intervalSeconds: 60 });
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe('t1');
    expect(again[0]!.intervalSeconds).toBe(60);
  });
});
