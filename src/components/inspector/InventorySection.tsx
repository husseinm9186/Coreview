/**
 * What the last crawl read from a device (LT-200–204): uptime, each port with
 * its status, speed and VLAN, the VLANs, spanning tree and the routing table.
 *
 * Read-only: it is the device's own account at the time it was asked, and a
 * re-crawl replaces it. Tables start closed, so a 48-port switch does not push
 * the rest of the inspector off the screen.
 */
import { formatUptime } from '../../lib/inventory';
import type { DeviceInventory } from '../../types/domain';
import { t } from '../../i18n';

export function InventorySection({ inventory, uptimeWhy }: { inventory: DeviceInventory; uptimeWhy?: string | null }) {
  const up = inventory.ports.filter((p) => p.status === 'connected').length;
  const blocked = inventory.spanningTree.filter((i) => i.blocked.length > 0);
  const rootOf = inventory.spanningTree.filter((i) => i.isRoot).length;
  return (
    <section className="cv-section cv-inventory" aria-label={t('inventorySection.fromTheLastCrawl')}>
      <h3>{t('inventorySection.fromTheLastCrawl')}</h3>
      <p className="cv-help">
        Read {new Date(inventory.collectedAt).toLocaleString()}
        {inventory.uptimeSeconds != null && <> · <span title={uptimeWhy ?? undefined}>up {formatUptime(inventory.uptimeSeconds)}</span></>}
      </p>

      {inventory.ports.length > 0 && (
        <details>
          <summary>
            Ports <span className="cv-palette-count">{up}/{inventory.ports.length} connected</span>
          </summary>
          <div className="cv-table-scroll">
            <table className="cv-table cv-inventory-table">
              <thead>
                <tr><th>{t('inventorySection.port')}</th><th>{t('inventorySection.status')}</th><th>{t('inventorySection.speed')}</th><th>{t('inventorySection.vlan')}</th><th>{t('inventorySection.errors')}</th><th>{t('inventorySection.description')}</th></tr>
              </thead>
              <tbody>
                {inventory.ports.map((p) => (
                  <tr key={p.port} className={p.status === 'connected' ? '' : 'is-dim'}>
                    <td className="cv-mono">{p.port}</td>
                    <td>{p.status}</td>
                    <td>{[p.speed, p.duplex].filter(Boolean).join(' ')}</td>
                    <td title={p.trunkVlans ? `Trunk VLANs ${p.trunkVlans}` : undefined}>
                      {p.mode === 'trunk' ? `trunk${p.vlan != null ? ` (native ${p.vlan})` : ''}` : p.mode === 'routed' ? 'routed' : (p.vlan ?? '')}
                    </td>
                    <td className={p.errors && (p.errors.input || p.errors.output || p.errors.crc) ? 'is-warning' : ''}>
                      {p.errors ? `${p.errors.input + p.errors.output}` : ''}
                    </td>
                    <td>{p.description ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {inventory.vlans.length > 0 && (
        <details>
          <summary>
            VLANs <span className="cv-palette-count">{inventory.vlans.length}</span>
          </summary>
          <ul className="cv-inventory-vlans">
            {inventory.vlans.map((v) => (
              <li key={v.id}>
                <span className="cv-mono">{v.id}</span> {v.name}
              </li>
            ))}
          </ul>
        </details>
      )}

      {inventory.spanningTree.length > 0 && (
        <details>
          <summary>
            Spanning tree{' '}
            <span className="cv-palette-count">
              root for {rootOf} of {inventory.spanningTree.length}
              {blocked.length > 0 ? ` · ${blocked.length} with blocked ports` : ''}
            </span>
          </summary>
          <table className="cv-table cv-inventory-table">
            <thead>
              <tr><th>{t('inventorySection.instance')}</th><th>{t('inventorySection.root')}</th><th>{t('inventorySection.rootPort')}</th><th>{t('inventorySection.blocked')}</th></tr>
            </thead>
            <tbody>
              {inventory.spanningTree.map((i) => (
                <tr key={i.instance}>
                  <td className="cv-mono">{i.instance}</td>
                  <td>{i.isRoot ? 'this switch' : (i.rootBridge ?? '')}</td>
                  <td>{i.rootPort ?? ''}</td>
                  <td className={i.blocked.length ? 'is-warning' : ''}>{i.blocked.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {inventory.routes.length > 0 && (
        <details>
          <summary>
            Routes <span className="cv-palette-count">{inventory.routes.length}</span>
          </summary>
          <table className="cv-table cv-inventory-table">
            <thead>
              <tr><th>{t('inventorySection.prefix')}</th><th>{t('inventorySection.from')}</th><th>{t('inventorySection.nextHop')}</th><th>{t('inventorySection.interface')}</th></tr>
            </thead>
            <tbody>
              {inventory.routes.map((r, i) => (
                <tr key={`${r.prefix}-${i}`}>
                  <td className="cv-mono">{r.prefix}</td>
                  <td>{r.protocol}</td>
                  <td className="cv-mono">{r.nextHops.join(', ')}</td>
                  <td>{r.interface ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
