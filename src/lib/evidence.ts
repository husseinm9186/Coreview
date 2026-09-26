/**
 * Why a device says what it says (LT-438, D-050).
 *
 * A crawl writes a class, a platform, an uptime and a set of addresses onto
 * a device, and each came from somewhere — a prompt, `show version`, an
 * SNMP object, a neighbour's advertisement, a MAC's maker. `Evidence`
 * travels with the value; this turns it into the sentence the inspector
 * shows beside the field. Nothing here invents a source: a field with no
 * evidence gets no sentence, which is the honest answer for anything typed
 * by hand.
 */
import type { Evidence } from './ipc';
import { t } from '../i18n';

/** The sources a crawl writes, in words. Anything unlisted is shown as is. */
const SOURCE_WORDS: Record<string, string> = {
  prompt: 'the device’s own prompt',
  'ssh:show version': 'show version over SSH',
  'ssh:show ip interface brief': 'show ip interface brief over SSH',
  'snmp:sysName': 'SNMP sysName',
  'snmp:sysDescr': 'SNMP sysDescr',
  'snmp:sysServices': 'SNMP sysServices',
  'snmp:sysUpTime': 'SNMP sysUpTime',
  'snmp:entity-mib': 'the ENTITY-MIB over SNMP',
  'snmp:reached-on': 'the address it answered SNMP on',
  'neighbour-report': 'a neighbour’s advertisement',
  oui: 'the maker behind its MAC',
  'fortigate:wtp': 'the FortiGate that manages it',
  'meraki:dashboard': 'the Meraki Dashboard',
  typed: 'somebody typing it',
};

export function sourceWords(source: string): string {
  return SOURCE_WORDS[source] ?? source;
}

/** One sentence: what read it, who reported it, and when. */
export function whySays(evidence: Record<string, Evidence> | undefined, field: string, nowMs = Date.now()): string | null {
  const e = evidence?.[field];
  if (!e) return null;
  const parts: string[] = [t('evidence.readFrom', { source: sourceWords(e.source) })];
  if (e.seenBy) parts.push(t('evidence.reportedBy', { device: e.seenBy }));
  if (e.seenAtMs != null) parts.push(t('evidence.when', { ago: agoWords(nowMs - e.seenAtMs) }));
  const detail = e.detail?.trim();
  return `${parts.join(', ')}.${detail ? ` ${t('evidence.itSaid', { detail })}` : ''}`;
}

function agoWords(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return t('evidence.minutesAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 48) return t('evidence.hoursAgo', { count: hours });
  return t('evidence.daysAgo', { count: Math.floor(hours / 24) });
}
