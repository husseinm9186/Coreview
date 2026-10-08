/**
 * Intent checks over what a crawl normalised.
 *
 * the findings are what the crawl saw that is wrong on its face — a
 * one-way link, a loop, a duplicate MAC. These are rules the operator
 * writes about how the estate is *meant* to be, evaluated against the same
 * crawl: every trunk carries VLAN N; an access port sits on an allowed
 * VLAN; nothing runs half-duplex; both ends of a link agree on speed and
 * duplex; a device has been up at least N days. Each failure names the
 * device and the port or figure that decided it, and nothing is claimed for
 * a device the crawl did not read that table from.
 *
 * **Only what is collected can be checked.** BPDU guard, port security and
 * the like are not read by any crawl today, so there is no rule for them
 * here — a rule that always passed because nothing was read would be worse
 * than none.
 */
import type { CrawledDevice, Neighbor } from './ipc';
import type { Finding } from './crawlFindings';
import { shortInterface } from './topology';

export type IntentRule =
  | { id: string; kind: 'trunkCarriesVlan'; vlan: number }
  | { id: string; kind: 'accessVlanAllowed'; vlans: number[] }
  | { id: string; kind: 'noHalfDuplex' }
  | { id: string; kind: 'linkEndsAgree' }
  | { id: string; kind: 'uptimeAtLeastDays'; days: number };

export type IntentKind = IntentRule['kind'];

export const INTENT_KINDS: { kind: IntentKind; label: string; takes: 'vlan' | 'vlans' | 'days' | null }[] = [
  { kind: 'trunkCarriesVlan', label: 'Every trunk carries VLAN', takes: 'vlan' },
  { kind: 'accessVlanAllowed', label: 'Access ports only on VLANs', takes: 'vlans' },
  { kind: 'noHalfDuplex', label: 'No port runs half-duplex', takes: null },
  { kind: 'linkEndsAgree', label: 'Both ends of a link agree on speed and duplex', takes: null },
  { kind: 'uptimeAtLeastDays', label: 'Every device up at least (days)', takes: 'days' },
];

export function ruleLabel(rule: IntentRule): string {
  switch (rule.kind) {
    case 'trunkCarriesVlan':
      return `Every trunk carries VLAN ${rule.vlan}`;
    case 'accessVlanAllowed':
      return `Access ports only on VLANs ${rule.vlans.join(', ')}`;
    case 'noHalfDuplex':
      return 'No port runs half-duplex';
    case 'linkEndsAgree':
      return 'Both ends of a link agree on speed and duplex';
    case 'uptimeAtLeastDays':
      return `Every device up at least ${rule.days} days`;
  }
}

export function newIntentRule(kind: IntentKind, value = ''): IntentRule {
  const id = `intent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const n = Number(value);
  switch (kind) {
    case 'trunkCarriesVlan':
      return { id, kind, vlan: Number.isFinite(n) ? n : 0 };
    case 'accessVlanAllowed':
      return { id, kind, vlans: value.split(/[,\s]+/).map(Number).filter((v) => Number.isFinite(v) && v > 0) };
    case 'noHalfDuplex':
      return { id, kind };
    case 'linkEndsAgree':
      return { id, kind };
    case 'uptimeAtLeastDays':
      return { id, kind, days: Number.isFinite(n) ? n : 0 };
  }
}

/** Whether a stored rule has what it needs to be evaluated. */
export function ruleComplete(rule: IntentRule): boolean {
  switch (rule.kind) {
    case 'trunkCarriesVlan':
      return rule.vlan > 0;
    case 'accessVlanAllowed':
      return rule.vlans.length > 0;
    case 'uptimeAtLeastDays':
      return rule.days > 0;
    default:
      return true;
  }
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && shortInterface(a).toLowerCase() === shortInterface(b).toLowerCase();

const half = (duplex: string) => /half|^h$/i.test(duplex.trim());
const known = (v: string) => v.trim() !== '' && !/^(auto|a-?|unknown|--)$/i.test(v.trim());

/** Every failure of every complete rule, worst first, as findings. */
export function intentFindings(devices: readonly CrawledDevice[], rules: readonly IntentRule[]): Finding[] {
  const out: Finding[] = [];
  const byName = new Map(devices.map((d) => [d.hostname.trim().toLowerCase(), d]));
  // A link is reported once however many sides advertised it.
  const linksSeen = new Set<string>();
  const fail = (rule: IntentRule, message: string, names: string[]) =>
    out.push({ kind: 'intent', severity: 'warning', message: `${ruleLabel(rule)}: ${message}`, devices: names });

  for (const rule of rules.filter(ruleComplete)) {
    for (const d of devices) {
      const portVlans = d.portVlans ?? [];
      const ports = d.ports ?? [];
      switch (rule.kind) {
        case 'trunkCarriesVlan':
          for (const p of portVlans) {
            if (p.mode === 'trunk' && !p.trunkVlans.includes(rule.vlan)) {
              fail(rule, `${d.hostname} ${p.port} is a trunk without it (carries ${p.trunkVlans.length ? p.trunkVlans.join(', ') : 'nothing'}).`, [d.hostname]);
            }
          }
          break;
        case 'accessVlanAllowed':
          for (const p of portVlans) {
            if (p.mode === 'access' && p.vlan != null && !rule.vlans.includes(p.vlan)) {
              fail(rule, `${d.hostname} ${p.port} is an access port on VLAN ${p.vlan}.`, [d.hostname]);
            }
          }
          break;
        case 'noHalfDuplex':
          for (const p of ports) {
            if (half(p.duplex) && /connected|up/i.test(p.status)) {
              fail(rule, `${d.hostname} ${p.port} is ${p.duplex.trim()} at ${p.speed.trim() || 'an unknown speed'}.`, [d.hostname]);
            }
          }
          break;
        case 'linkEndsAgree':
          for (const n of d.neighbors) {
            const other = byName.get((n.shortName || n.deviceId).trim().toLowerCase());
            if (!other || !n.localInterface || !n.remoteInterface) continue;
            const ends = [`${d.hostname}|${shortInterface(n.localInterface)}`, `${other.hostname}|${shortInterface(n.remoteInterface)}`].sort().join('~').toLowerCase();
            if (linksSeen.has(ends)) continue;
            linksSeen.add(ends);
            const mine = ports.find((p) => same(p.port, n.localInterface));
            const theirs = (other.ports ?? []).find((p) => same(p.port, n.remoteInterface));
            if (!mine || !theirs) continue;
            const speedOff = known(mine.speed) && known(theirs.speed) && mine.speed.trim() !== theirs.speed.trim();
            const duplexOff = known(mine.duplex) && known(theirs.duplex) && mine.duplex.trim().toLowerCase() !== theirs.duplex.trim().toLowerCase();
            if (speedOff || duplexOff) {
              fail(
                rule,
                `${d.hostname} ${mine.port} is ${mine.speed.trim() || '?'}/${mine.duplex.trim() || '?'}, ${other.hostname} ${theirs.port} is ${theirs.speed.trim() || '?'}/${theirs.duplex.trim() || '?'}.`,
                [d.hostname, other.hostname],
              );
            }
          }
          break;
        case 'uptimeAtLeastDays':
          if (d.uptimeSeconds != null && d.uptimeSeconds < rule.days * 86_400) {
            const days = Math.floor(d.uptimeSeconds / 86_400);
            fail(rule, `${d.hostname} has been up ${days} day${days === 1 ? '' : 's'}.`, [d.hostname]);
          }
          break;
      }
    }
  }
  return out;
}

/** Which rules could not be judged at all because no device carried the
 *  table they need — said, rather than passed. */
export function intentUnjudged(devices: readonly CrawledDevice[], rules: readonly IntentRule[]): IntentRule[] {
  const anyVlans = devices.some((d) => (d.portVlans ?? []).length > 0);
  const anyPorts = devices.some((d) => (d.ports ?? []).length > 0);
  const anyUptime = devices.some((d) => d.uptimeSeconds != null);
  return rules.filter(ruleComplete).filter((r) => {
    switch (r.kind) {
      case 'trunkCarriesVlan':
      case 'accessVlanAllowed':
        return !anyVlans;
      case 'noHalfDuplex':
      case 'linkEndsAgree':
        return !anyPorts;
      case 'uptimeAtLeastDays':
        return !anyUptime;
    }
  });
}

/** For the neighbour type's sake, so a rule file never depends on the panel. */
export type { Neighbor as IntentNeighbor };
