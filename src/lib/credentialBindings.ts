/**
 * Which saved credential to try on which device (LT-199, LT-209).
 *
 * Two places say it: a device's own **Saved credentials** in the inspector, and
 * the project's rules by subnet or vendor in the crawl panel. Both are ids into
 * the vault — never a secret — and both go to the crawl as one list; Rust opens
 * the vault and tries the most specific match first.
 */
import { allNodes } from './pages';
import type { ProjectDocument } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

export type BindingScope = 'device' | 'subnet' | 'vendor';

export interface CredentialRule {
  id: string;
  scope: 'subnet' | 'vendor';
  value: string;
  credentialId: string;
}

export interface BindingInput {
  scope: BindingScope;
  value: string;
  credentialId: string;
}

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** What is wrong with a rule's value, or null. */
export function ruleProblem(rule: Pick<CredentialRule, 'scope' | 'value'>): string | null {
  const v = rule.value.trim();
  if (!v) return rule.scope === 'subnet' ? 'Give a subnet, like 192.0.2.0/24.' : 'Give a vendor or platform word, like FortiSwitch.';
  if (rule.scope === 'subnet') {
    const m = CIDR.exec(v);
    if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) return `${v} is not a subnet like 192.0.2.0/24.`;
  }
  return null;
}

/** Every binding a crawl should know about: each device's own saved
 *  credentials (by its addresses and name), then the project's rules. */
export function bindingsFor(doc: ProjectDocument): BindingInput[] {
  const out: BindingInput[] = [];
  const seen = new Set<string>();
  const add = (b: BindingInput) => {
    const key = `${b.scope}|${b.value.toLowerCase()}|${b.credentialId}`;
    if (seen.has(key) || !b.value.trim()) return;
    seen.add(key);
    out.push(b);
  };
  for (const n of allNodes(doc)) {
    if (n.type !== 'device') continue;
    const d = n.data as DeviceNodeData;
    for (const credentialId of [d.sshCredentialId, d.snmpCredentialId]) {
      if (!credentialId) continue;
      for (const a of d.addresses ?? []) if (a.address) add({ scope: 'device', value: a.address, credentialId });
      if (d.hostname) add({ scope: 'device', value: d.hostname, credentialId });
    }
  }
  for (const r of doc.credentialRules ?? []) {
    if (ruleProblem(r) || !r.credentialId) continue;
    add({ scope: r.scope, value: r.value.trim(), credentialId: r.credentialId });
  }
  return out;
}
