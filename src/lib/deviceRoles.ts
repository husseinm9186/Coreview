/**
 * What counts as "the network" rather than what is plugged into it.
 *
 * A crawl of a real estate finds far more endpoints than infrastructure — one
 * FortiSwitch contributes thirty-five MACs and a FortiGate forty-six DHCP
 * leases — and reviewing thirty endpoints one tick at a time is a chore
 * rather than a choice. The choice an engineer actually makes is
 * "infrastructure only" against "everything discovered", so that is the
 * choice offered.
 *
 * **Servers are infrastructure here, and that is a judgement worth stating.**
 * A server is a thing somebody drew on purpose and expects to see on a
 * topology; a phone, a camera, a printer and a laptop are things the network
 * carries. `unknown` is deliberately *not* infrastructure: a device nothing
 * could identify is far more often a workstation than a switch, and putting
 * every unidentified MAC on the diagram is what "infrastructure only" exists
 * to avoid.
 */
import type { DeviceClassName } from './ipc';

/** The classes "Infrastructure only" selects, in the order they are drawn. */
export const INFRASTRUCTURE_CLASSES: readonly DeviceClassName[] = [
  'router',
  'switch',
  'firewall',
  'wireless-controller',
  'access-point',
  'server',
] as const;

/** Whether a device class is part of the network rather than a thing on it. */
export function isInfrastructure(klass: DeviceClassName): boolean {
  return INFRASTRUCTURE_CLASSES.includes(klass);
}

/**
 * How many of a set of rows each choice would tick, so a button can say what
 * it will do before it is pressed rather than after.
 */
export function roleCounts<T extends { klass: DeviceClassName }>(
  rows: readonly T[],
): { infrastructure: number; everything: number } {
  return {
    infrastructure: rows.filter((r) => isInfrastructure(r.klass)).length,
    everything: rows.length,
  };
}
