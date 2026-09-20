/**
 * Which saved credentials belong to the project in front of you (LT-335).
 *
 * The vault is one encrypted store per machine and that is deliberate: the key
 * is derived from one passphrase, held once, and zeroed on lock (D-006). Every
 * project on the machine shares it.
 *
 * What must **not** be shared is the view. Opening project B and seeing the
 * logins project A saved is the leak the operator reported — not of the
 * secrets, which never leave the vault, but of the fact that they exist, their
 * labels and their usernames. A project should show its own.
 *
 * "Its own" is derivable and needs no new storage: a credential belongs to a
 * project when the project refers to it — as its global SSH or SNMP login, or
 * on one of its devices. Everything here is pure.
 */
import { allNodes } from './pages';
import type { ProjectDocument } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

/** Every credential id this project refers to, anywhere. */
export function credentialsUsedBy(doc: ProjectDocument): Set<string> {
  const used = new Set<string>();
  const add = (id: string | undefined | null) => {
    const t = id?.trim();
    if (t) used.add(t);
  };
  add(doc.credentialDefaults?.ssh);
  for (const id of doc.credentialDefaults?.snmp ?? []) add(id);
  for (const rule of doc.credentialRules ?? []) add(rule.credentialId);
  for (const node of allNodes(doc)) {
    if (node.type !== 'device') continue;
    const d = node.data as DeviceNodeData;
    add(d.sshCredentialId);
    add(d.snmpCredentialId);
  }
  return used;
}

/**
 * The references this project holds that the vault no longer has.
 *
 * A project stores ids and the vault outlives any one project, so an id goes
 * stale whenever a credential is wiped — or whenever the project is opened on
 * a different machine, whose vault never had it. Neither is an error; both
 * used to be, loudly and in the wrong place ("That saved credential no longer
 * exists", on a crawl that had nothing to do with it).
 */
export function staleCredentials(doc: ProjectDocument, inVault: { id: string }[]): string[] {
  const have = new Set(inVault.map((c) => c.id));
  return [...credentialsUsedBy(doc)].filter((id) => !have.has(id)).sort();
}

/**
 * The document with every stale reference removed.
 *
 * Returns `null` when there was nothing to do, so a caller can avoid marking a
 * project dirty — and avoid an endless loop — just for looking at it.
 */
export function withoutStaleCredentials(
  doc: ProjectDocument,
  inVault: { id: string }[],
): ProjectDocument | null {
  const stale = new Set(staleCredentials(doc, inVault));
  if (stale.size === 0) return null;

  const defaults = doc.credentialDefaults;
  const nextDefaults = defaults
    ? {
        ...defaults,
        ssh: defaults.ssh && stale.has(defaults.ssh) ? undefined : defaults.ssh,
        snmp: (defaults.snmp ?? []).filter((id) => !stale.has(id)),
      }
    : undefined;

  return {
    ...doc,
    credentialDefaults: nextDefaults,
    credentialRules: (doc.credentialRules ?? []).filter((r) => !stale.has(r.credentialId)),
    pages: doc.pages.map((page) => ({
      ...page,
      nodes: page.nodes.map((node) => {
        if (node.type !== 'device') return node;
        const d = node.data as DeviceNodeData;
        if (!stale.has(d.sshCredentialId ?? '') && !stale.has(d.snmpCredentialId ?? '')) return node;
        return {
          ...node,
          data: {
            ...d,
            sshCredentialId: stale.has(d.sshCredentialId ?? '') ? undefined : d.sshCredentialId,
            snmpCredentialId: stale.has(d.snmpCredentialId ?? '') ? undefined : d.snmpCredentialId,
          },
        };
      }),
    })),
  };
}
