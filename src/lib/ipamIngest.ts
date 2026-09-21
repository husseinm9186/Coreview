/**
 * What a crawl saw, written into the register (LT-299).
 *
 * `buildIpam` reads addresses off the devices **drawn on the diagram**, so a
 * device nobody drew contributes nothing to the register. That is most of what
 * a crawl finds: one FortiSwitch contributed thirty-five MACs and one
 * FortiGate forty-six DHCP leases, and none of it was drawn. The register
 * therefore answered "which subnets are in use" from what somebody had
 * remembered to draw rather than from the network.
 *
 * This reads the whole crawl — every device's own addresses, and everything
 * those devices learned on their ports, which is where the ARP tables, MAC
 * tables and DHCP leases have already been merged (LT-134, LT-332).
 *
 * **Observed is not intended, and the register keeps knowing the difference**
 * (D-052). An ingested address says a device answered there; it does not say
 * anyone allocated it. Nothing here writes to a DHCP or DNS server, and
 * nothing is ever auto-released: an address that stops answering is something
 * to report, never something to recycle.
 *
 * Like the CSV import, this **plans** rather than applies. An address the
 * register already holds is counted and left alone — re-importing a crawl must
 * not overwrite what somebody typed.
 */
import type { CrawlResult } from './ipc';
import type { IpamEntry } from './ipam';
import { toValue } from './ipam';

export interface IngestCandidate {
  address: string;
  /** The best name anything had for it, or a description of where it was seen. */
  label: string;
  hostname?: string;
  mac?: string;
  /** The device that saw it, and the port — so a person can judge the row. */
  seenOn: string;
  vlan?: string;
  /** True when this is a crawled device's own address rather than something
   *  it learned about. Those are the ones worth trusting most. */
  isDeviceItself: boolean;
}

export interface IngestPlan {
  /** Addresses the register does not hold, in the order they were seen. */
  candidates: IngestCandidate[];
  /** How many observed addresses the register already holds. */
  alreadyHeld: number;
  /** Observed values that are not addresses this register can hold. */
  skipped: { value: string; why: string }[];
}

/** Everything a crawl observed that the register does not already hold. */
export function planIngest(
  result: CrawlResult | null | undefined,
  existing: readonly IpamEntry[] = [],
): IngestPlan {
  const plan: IngestPlan = { candidates: [], alreadyHeld: 0, skipped: [] };
  if (!result) return plan;

  const held = new Set(existing.map((e) => e.address.trim()));
  const seen = new Set<string>();
  const skippedOnce = new Set<string>();

  const offer = (c: IngestCandidate) => {
    const address = c.address.trim();
    if (toValue(address) === null) {
      // IPv6 and anything unparseable: said once, not once per sighting.
      if (!skippedOnce.has(address)) {
        skippedOnce.add(address);
        plan.skipped.push({
          value: address,
          why: address.includes(':') ? 'IPv6 — the register holds IPv4' : 'not an IPv4 address',
        });
      }
      return;
    }
    if (held.has(address)) {
      if (!seen.has(address)) {
        seen.add(address);
        plan.alreadyHeld += 1;
      }
      return;
    }
    // First sighting wins: a device's own address is offered before anything
    // that merely learned about it, because the devices are walked first.
    if (seen.has(address)) return;
    seen.add(address);
    plan.candidates.push({ ...c, address });
  };

  // A device's own addresses first — the surest thing a crawl knows.
  for (const d of result.devices) {
    for (const a of d.addresses ?? []) {
      offer({
        address: a.ip,
        label: d.hostname,
        hostname: d.hostname,
        seenOn: a.interface ? `${d.hostname} ${a.interface}` : d.hostname,
        isDeviceItself: true,
      });
    }
  }

  // Then everything those devices learned: ARP, MAC tables and DHCP leases,
  // already merged onto the port or SSID each was seen on.
  for (const d of result.devices) {
    for (const at of d.attached ?? []) {
      if (!at.address) continue;
      offer({
        address: at.address,
        label: at.hostname ?? at.vendor ?? `seen on ${d.hostname} ${at.port}`,
        ...(at.hostname ? { hostname: at.hostname } : {}),
        ...(at.mac ? { mac: at.mac } : {}),
        seenOn: `${d.hostname} ${at.port}`,
        ...(at.vlan ? { vlan: at.vlan } : {}),
        isDeviceItself: false,
      });
    }
  }

  return plan;
}

/** A candidate as the register stores it. Observed, never claimed as intended. */
export function asEntry(c: IngestCandidate): Omit<IpamEntry, 'id'> {
  return {
    address: c.address,
    label: c.label,
    kind: 'in-use',
    ...(c.hostname ? { hostname: c.hostname } : {}),
    ...(c.mac ? { mac: c.mac } : {}),
    note: `Seen by a crawl on ${c.seenOn}${c.vlan ? `, VLAN ${c.vlan}` : ''}`,
  };
}
