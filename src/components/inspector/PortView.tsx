/**
 * The port at each end of a link (LT-235): what it is plugged into, its
 * status, speed and duplex, its VLAN or trunk, and its error counters — from
 * the crawl's reading of each device — so a link that is "up" but dropping
 * frames can be seen for what it is.
 */
import { shortInterface } from '../../lib/topology';
import type { DeviceNodeData, InventoryPort } from '../../types/domain';

export function findPort(d: DeviceNodeData | undefined, label: string | undefined): InventoryPort | undefined {
  if (!d?.inventory || !label?.trim()) return undefined;
  const want = shortInterface(label).toLowerCase();
  return d.inventory.ports.find((p) => shortInterface(p.port).toLowerCase() === want);
}

function End({ device, port, partner }: { device: DeviceNodeData | undefined; port: string; partner: string }) {
  const p = findPort(device, port);
  const e = p?.errors;
  const bad = e && (e.input > 0 || e.crc > 0 || e.output > 0 || e.collisions > 0);
  return (
    <div className="cv-port-end">
      <h4>
        {device?.label ?? 'A device'} <span className="cv-mono">{port || 'no port named'}</span>
      </h4>
      {!p ? (
        <p className="cv-help">{port ? 'No crawl has read this port yet.' : 'Name the port to see what a crawl read about it.'}</p>
      ) : (
        <dl className="cv-port-facts">
          <dt>Plugged into</dt><dd>{partner}</dd>
          <dt>Status</dt><dd>{p.status}</dd>
          <dt>Speed</dt><dd>{[p.speed, p.duplex].filter(Boolean).join(', ') || '—'}</dd>
          <dt>VLAN</dt><dd>{p.mode === 'trunk' ? `trunk${p.vlan !== undefined ? `, native ${p.vlan}` : ''}${p.trunkVlans ? ` (${p.trunkVlans})` : ''}` : (p.vlan ?? p.mode ?? '—')}</dd>
          <dt>Errors</dt>
          <dd className={bad ? 'is-warning' : ''}>
            {e ? `${e.input} in (${e.crc} CRC), ${e.output} out, ${e.collisions} collisions, ${e.drops} dropped, ${e.resets} resets` : 'not read'}
          </dd>
        </dl>
      )}
    </div>
  );
}

export function PortView({
  source,
  target,
  sourcePort,
  targetPort,
}: {
  source: DeviceNodeData | undefined;
  target: DeviceNodeData | undefined;
  sourcePort: string;
  targetPort: string;
}) {
  return (
    <section className="cv-section cv-port-view" aria-label="Ports">
      <h3>Ports</h3>
      <End device={source} port={sourcePort} partner={`${target?.label ?? '?'} ${targetPort}`.trim()} />
      <End device={target} port={targetPort} partner={`${source?.label ?? '?'} ${sourcePort}`.trim()} />
    </section>
  );
}
