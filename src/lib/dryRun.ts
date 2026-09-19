/**
 * A crawl's dry run (LT-211): what a run with these settings would do, worked
 * out here, with nothing sent to the network — no ping, no DNS lookup, no port
 * check, no login.
 *
 * So it says what it can know without a packet: each seed and whether the
 * subnet limit lets it in, how big a range is before it is narrowed, which
 * saved credentials each address would be tried with and in what order, the
 * limits, and the commands a device would be asked. What only the network can
 * answer — which names resolve, which addresses in a range listen, who the
 * neighbours are — it says it does not know.
 */
import type { BindingInput } from './credentialBindings';
import type { CrawlInput } from './ipc';

export type DrySeed =
  | { kind: 'address'; seed: string; allowed: boolean; credentials: string[] }
  | { kind: 'range'; seed: string; addresses: number; allowed: number; credentials: string[] }
  | { kind: 'hostname'; seed: string }
  | { kind: 'invalid'; seed: string; reason: string };

export interface DryRunPlan {
  seeds: DrySeed[];
  limits: string[];
  commands: string[];
  snmp: string;
}

const MAX_RANGE_HOSTS = 4094;

export function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

export function parseCidr(text: string): { network: number; prefix: number } | null {
  const [addr, len] = text.split('/');
  const ip = addr ? ipToInt(addr) : null;
  const prefix = Number(len);
  if (ip === null || !/^\d{1,2}$/.test(len ?? '') || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  return { network: Math.floor(ip / size) * size, prefix };
}

export function inCidr(ip: number, c: { network: number; prefix: number }): boolean {
  const size = 2 ** (32 - c.prefix);
  return ip >= c.network && ip < c.network + size;
}

function hostsOf(c: { network: number; prefix: number }): number {
  if (c.prefix >= 31) return 2 ** (32 - c.prefix);
  return 2 ** (32 - c.prefix) - 2;
}

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

/** The credentials an address would be tried with, most specific first — the
 *  same order the crawl uses in Rust — then the run's own login. Vendor
 *  bindings need a neighbour's word first, so they are listed as conditional. */
export function credentialOrder(
  address: string,
  bindings: readonly BindingInput[],
  label: (id: string) => string,
  runLogin: string,
): string[] {
  const ip = ipToInt(address);
  const ranked: { rank: number; index: number; text: string }[] = [];
  bindings.forEach((b, index) => {
    if (b.scope === 'device' && b.value.toLowerCase() === address.toLowerCase()) {
      ranked.push({ rank: 1000, index, text: label(b.credentialId) });
    } else if (b.scope === 'subnet' && ip !== null) {
      const c = parseCidr(b.value);
      if (c && inCidr(ip, c)) ranked.push({ rank: 100 + c.prefix, index, text: `${label(b.credentialId)} (${b.value})` });
    } else if (b.scope === 'vendor') {
      ranked.push({ rank: 10, index, text: `${label(b.credentialId)} (if a neighbour reports ${b.value})` });
    }
  });
  ranked.sort((a, b) => b.rank - a.rank || a.index - b.index);
  return [...ranked.map((r) => r.text), runLogin];
}

export function dryRun(
  input: Pick<CrawlInput, 'seed' | 'subnets' | 'maxHops' | 'maxDevices' | 'port' | 'details' | 'reverseDns' | 'concurrency' | 'perHostTimeoutSecs' | 'retries' | 'secondFactor'> & {
    bindings?: BindingInput[];
    snmpCount?: number;
    transport?: CrawlInput['transport'];
  },
  label: (id: string) => string,
  runLogin: string,
): DryRunPlan {
  const subnets = input.subnets.map(parseCidr).filter((c): c is NonNullable<typeof c> => c !== null);
  const allowed = (ip: number) => subnets.length === 0 || subnets.some((c) => inCidr(ip, c));
  const bindings = input.bindings ?? [];
  const seeds: DrySeed[] = [];
  for (const raw of input.seed.split(/[\s,;]+/)) {
    const seed = raw.trim();
    if (!seed) continue;
    if (seed.includes('/')) {
      const c = parseCidr(seed);
      if (!c) {
        seeds.push({ kind: 'invalid', seed, reason: 'not a range like 192.0.2.0/24' });
      } else if (hostsOf(c) > MAX_RANGE_HOSTS) {
        seeds.push({ kind: 'invalid', seed, reason: 'larger than a /20; sweep it first' });
      } else {
        const first = c.prefix >= 31 ? c.network : c.network + 1;
        let inside = 0;
        for (let i = 0; i < hostsOf(c); i++) if (allowed(first + i)) inside++;
        const sample = `${[first >>> 24, (first >>> 16) & 255, (first >>> 8) & 255, first & 255].join('.')}`;
        seeds.push({ kind: 'range', seed, addresses: hostsOf(c), allowed: inside, credentials: credentialOrder(sample, bindings.filter((b) => b.scope !== 'device'), label, runLogin) });
      }
    } else if (ipToInt(seed) !== null) {
      seeds.push({ kind: 'address', seed, allowed: allowed(ipToInt(seed)!), credentials: credentialOrder(seed, bindings, label, runLogin) });
    } else if (HOSTNAME.test(seed) && /[a-z]/i.test(seed)) {
      seeds.push({ kind: 'hostname', seed });
    } else {
      seeds.push({ kind: 'invalid', seed, reason: 'not an address, a range or a hostname' });
    }
  }

  const limits = [
    `Up to ${input.maxHops} hop${input.maxHops === 1 ? '' : 's'} from a seed and ${input.maxDevices} devices`,
    input.subnets.length ? `Only inside ${input.subnets.join(', ')}` : 'No subnet limit — a crawl can follow a link out of the estate',
    `${input.concurrency ?? 4} at once${input.secondFactor ? ', logging in one at a time for the push factor' : ''}`,
    `Give up on a device after ${Math.round((input.perHostTimeoutSecs ?? 300) / 60)} min; retry one that does not answer ${input.retries ?? 1} time${(input.retries ?? 1) === 1 ? '' : 's'}`,
    `${input.transport === 'telnet' ? 'Telnet' : input.transport === 'sshThenTelnet' ? 'SSH, then telnet' : 'SSH'} on port ${input.port}`,
  ];

  const d = input.details ?? { routes: true, spanningTree: true, vlans: true };
  const commands = [
    'show cdp neighbors detail',
    'show lldp neighbors detail',
    'show ip interface brief',
    'show version',
    'show ip arp',
    'show mac address-table',
    'show etherchannel summary',
    'show ip route 0.0.0.0',
    'show switch, show stackwise-virtual, show switch virtual',
    ...(d.routes ? ['show ip route', 'show ipv6 route'] : []),
    ...(d.spanningTree ? ['show spanning-tree'] : []),
    ...(d.vlans ? ['show vlan brief', 'show interfaces trunk', 'show interfaces status'] : []),
  ];

  const snmp = input.snmpCount
    ? `SNMP, ${input.snmpCount} credential${input.snmpCount === 1 ? '' : 's'}, for a device that refuses SSH`
    : 'No SNMP: a device that refuses SSH is reported as failed';

  return { seeds, limits, commands, snmp };
}
