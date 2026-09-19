/**
 * What a screen reader says for a device or a link on the canvas (LT-241).
 *
 * The drawing is pictures and positions; a person who cannot see it needs the
 * same facts in words — what the thing is, what it is called, where to reach
 * it, and for a link, what it joins and on which ports. Live status is read
 * from the device itself, which already says it.
 */
import type { DeviceNodeData, LinkData, NoteNodeData } from '../types/domain';
import type { TopoEdge, TopoNode } from '../state/store';

export function nodeAriaLabel(n: TopoNode, typeLabel: (type: string) => string): string {
  if (n.type === 'note') {
    const d = n.data as NoteNodeData;
    const first = (d.body ?? '').split('\n').find((l) => l.trim()) ?? '';
    return ['Note', d.title, first].filter(Boolean).join(': ');
  }
  const d = n.data as DeviceNodeData;
  const address = (d.addresses ?? []).find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address;
  return [
    `${typeLabel(d.deviceType)} ${d.label}`.trim(),
    d.role,
    address,
    d.locked ? 'locked' : '',
    d.maintenance ? 'in maintenance' : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export function edgeAriaLabel(e: TopoEdge, nameOf: (id: string) => string): string {
  const d = (e.data ?? {}) as Partial<LinkData>;
  const end = (id: string, port?: string) => `${nameOf(id)}${port ? ` ${port}` : ''}`;
  const what = d.kind === 'leader' ? 'Pointer' : d.layer3 ? 'Layer 3 link' : 'Link';
  return [`${what} from ${end(e.source, d.sourcePortLabel)} to ${end(e.target, d.targetPortLabel)}`, d.label, d.maintenance ? 'in maintenance' : '']
    .filter(Boolean)
    .join(', ');
}
