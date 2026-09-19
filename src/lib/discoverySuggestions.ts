/**
 * What to put in the discovery form, from what the project already knows
 * (LT-296).
 *
 * "I need it to auto populate the fileds in discovery please." A scan of an
 * estate that is already drawn should not start on an empty form: the project
 * holds the subnets (the register, LT-285) and the addresses of the devices on
 * the diagram, and between them they are a better first guess than anything
 * typed from memory.
 *
 * **Proposed, never applied.** This returns suggestions; the form offers them
 * behind a button. A scan reaches out to real equipment and stays something
 * the operator starts deliberately — nothing here begins one.
 */
import { buildIpam, type IpamState } from './ipam';
import { allNodes } from './pages';
import type { ProjectDocument, TopoNode } from '../state/store';
import type { DeviceNodeData, DeviceType } from '../types/domain';

/**
 * Device classes worth starting a crawl from, best first.
 *
 * A crawl walks neighbours, so where it starts decides what it finds: from a
 * core switch it reaches the estate, from a printer it reaches nothing. The
 * order is the order an engineer would pick by hand.
 */
const SEED_ORDER: readonly DeviceType[] = [
  'core-switch',
  'l3-switch',
  'distribution-switch',
  'router',
  'firewall',
  'access-switch',
  'l2-switch',
  'wireless-controller',
];

const rank = (type: DeviceType | undefined): number => {
  const at = SEED_ORDER.indexOf(type as DeviceType);
  return at < 0 ? SEED_ORDER.length : at;
};

export interface DiscoverySuggestion {
  /** Addresses to start from, best first. */
  seeds: string[];
  /** Subnets the crawl should stay inside. */
  subnets: string[];
  /** Devices with an address that is not IPv4, or none at all — said out loud
   *  so a short list of seeds does not look like a mistake. */
  skipped: number;
}

/** The most an estate needs to be reached: past this it is a list nobody
 *  reads, and a crawl from ten switches has already found the rest. */
const MOST_SEEDS = 10;

export function discoverySuggestions(doc: ProjectDocument, most = MOST_SEEDS): DiscoverySuggestion {
  const model = buildIpam(allNodes(doc), doc.ipam as IpamState | undefined);

  // Subnets: what the register holds, which is the declared ones plus every
  // block a connected route or an address implies. In address order, as the
  // register shows them.
  const subnets = model.blocks.map((b) => b.cidr);

  const candidates: { address: string; rank: number; crawled: boolean; label: string }[] = [];
  let skipped = 0;
  for (const n of allNodes(doc) as TopoNode[]) {
    if (n.type !== 'device') continue;
    const d = (n.data ?? {}) as Partial<DeviceNodeData>;
    const at = rank(d.deviceType);
    if (at === SEED_ORDER.length) continue;
    const address = d.addresses?.find((a) => a.isPrimary && a.address.trim())?.address
      ?? d.addresses?.find((a) => a.address.trim())?.address;
    if (!address) {
      skipped += 1;
      continue;
    }
    candidates.push({
      address: address.trim(),
      rank: at,
      // A device a crawl has already reached is known to answer, which makes
      // it a better seed than one nobody has tried.
      crawled: Boolean(d.discoveredVia),
      label: String(d.label ?? n.id),
    });
  }

  candidates.sort(
    (a, b) => a.rank - b.rank || Number(b.crawled) - Number(a.crawled) || a.label.localeCompare(b.label),
  );

  const seeds: string[] = [];
  for (const c of candidates) {
    if (seeds.includes(c.address)) continue;
    seeds.push(c.address);
    if (seeds.length >= most) break;
  }

  return { seeds, subnets, skipped };
}
