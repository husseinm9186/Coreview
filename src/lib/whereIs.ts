/**
 * "Where is this?" — one search over everything a crawl found.
 *
 * The question an engineer actually asks is *where is this thing plugged in*,
 * and every piece of the answer is already collected. A crawl knows what each
 * switch learned on each port: a MAC, often an address, sometimes a name, the
 * VLAN, and how many addresses share the port. None of it was searchable.
 *
 * **Nothing new is gathered.** This is a query over `attached` — the merged
 * MAC tables, ARP tables, DHCP leases and FortiGate device store that
 * `CrawledDevice` already carries — plus the crawled devices themselves.
 *
 * Two things follow from that, and both matter:
 *
 * - **Most answers are about things that are not on the diagram.** A printer
 *   nobody drew is still a MAC on a port, and this finds it. That is the
 *   difference between this and `search.ts`, which searches the document.
 * - **A wireless client's "port" is its SSID.** A FortiGate reports its
 *   clients with the SSID where a switch reports a port, so asking where a
 *   phone is answers with the network it is on and the controller that saw
 *   it, without a separate wireless search.
 *
 * Matching is deliberately literal rather than fuzzy. The palette is
 * fuzzy because it is a jump-to; this is an answer to a question about one
 * device, and `aa:bb` quietly matching a VLAN name would make it untrustworthy.
 * A MAC matches however either side punctuates it, an address matches whole or
 * by leading octets, and text matches as a substring.
 */
import type { CrawledDevice, DeviceClassName } from './ipc';
import { macKey } from './topology';

/** Which field a hit matched on, so the result can say why it is there. */
export type WhereField = 'mac' | 'address' | 'hostname' | 'vendor' | 'port' | 'vlan' | 'serial';

export interface WhereHit {
  mac: string | null;
  address: string | null;
  hostname: string | null;
  vendor: string | null;
  deviceClass: DeviceClassName | null;
  /** The crawled device that saw it — the switch, or the firewall. */
  seenBy: string;
  /** The port it was learned on, or the SSID for a wireless client. */
  port: string;
  vlan: string | null;
  /** Distinct addresses sharing that port. */
  portPopulation: number;
  /** True where the port leads to another switch rather than to one thing.
   *  A hit on a shared port says which switch, not which socket. */
  sharedPort: boolean;
  /** True when the hit is a crawled device in its own right. */
  isDevice: boolean;
  matchedOn: WhereField;
}

/** An address matches whole, or by leading octets: `192.0.2` finds `192.0.2.10`. */
function addressMatches(value: string | null | undefined, query: string): boolean {
  if (!value) return false;
  if (value === query) return true;
  // Only treat it as an address prefix when the query looks like one, so that
  // a bare `10` does not match every address in the estate.
  if (!/^[0-9a-fA-F.:]+$/.test(query) || !query.includes('.')) return false;
  return value.startsWith(query.endsWith('.') ? query : `${query}.`);
}

function textMatches(value: string | null | undefined, lowerQuery: string): boolean {
  return !!value && value.toLowerCase().includes(lowerQuery);
}

/**
 * Everything a crawl knows about whatever the query names.
 *
 * Ordered by how sure the match is: a MAC or a whole address first, then a
 * device in its own right, then a name, then a maker. Within a rank the order
 * the crawl produced is kept, so repeated searches read the same way.
 */
export function whereIs(query: string, devices: CrawledDevice[]): WhereHit[] {
  const q = query.trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const wantedMac = macKey(q);
  const hits: { hit: WhereHit; rank: number }[] = [];

  for (const device of devices) {
    // The device itself. Asking where a switch is should not come back empty
    // just because nothing upstream had learned it.
    const deviceFields: [WhereField, boolean, number][] = [
      ['address', device.addresses.some((a) => addressMatches(a.ip, q)) || addressMatches(device.address, q), 1],
      ['hostname', textMatches(device.hostname, lower), 2],
      ['serial', textMatches(device.serial, lower), 2],
      ['vendor', textMatches(device.platform, lower), 3],
    ];
    const matchedField = deviceFields.find(([, ok]) => ok);
    if (matchedField) {
      hits.push({
        rank: matchedField[2],
        hit: {
          mac: null,
          address: device.address,
          hostname: device.hostname,
          vendor: device.platform,
          deviceClass: device.class,
          seenBy: device.hostname,
          port: '',
          vlan: null,
          portPopulation: 0,
          sharedPort: false,
          isDevice: true,
          matchedOn: matchedField[0],
        },
      });
    }

    for (const a of device.attached) {
      let field: WhereField | null = null;
      let rank = 9;
      if (wantedMac && macKey(a.mac) === wantedMac) {
        field = 'mac';
        rank = 0;
      } else if (addressMatches(a.address, q)) {
        field = 'address';
        rank = 1;
      } else if (textMatches(a.hostname, lower)) {
        field = 'hostname';
        rank = 2;
      } else if (textMatches(a.vendor, lower)) {
        field = 'vendor';
        rank = 3;
      } else if (textMatches(a.port, lower)) {
        // Covers an SSID as well as a port, because a wireless client reports
        // its SSID where a switch reports a port.
        field = 'port';
        rank = 4;
      } else if (textMatches(a.vlan, lower)) {
        field = 'vlan';
        rank = 4;
      }
      if (!field) continue;
      hits.push({
        rank,
        hit: {
          mac: a.mac,
          address: a.address,
          hostname: a.hostname,
          vendor: a.vendor,
          deviceClass: a.class,
          seenBy: device.hostname,
          port: a.port,
          vlan: a.vlan ?? null,
          portPopulation: a.portPopulation,
          sharedPort: a.portPopulation > 1,
          isDevice: false,
          matchedOn: field,
        },
      });
    }
  }

  return hits
    .map((h, i) => ({ ...h, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((h) => h.hit);
}
