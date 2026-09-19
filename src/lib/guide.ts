/**
 * The guided tour a sample project carries (LT-271): a few steps through what
 * Coreview is for, each ticked off by doing it rather than by pressing Next.
 *
 * A step is done when its condition has been true once — selecting a device
 * counts even after something else is selected — so what has been seen is
 * recorded on the document and survives closing the project.
 */
import type { HealthStatus, ProbeRuntime } from '../types/domain';

export interface GuideState {
  selectedDevice: boolean;
  selectedLink: boolean;
  sessionRunning: boolean;
  runtime: ReadonlyMap<string, ProbeRuntime>;
  /** Steps already recorded on the document. */
  done: readonly string[];
}

export interface GuideStep {
  id: string;
  title: string;
  detail: string;
  /** True when the step can be seen to be done now. Steps that are noted by
   *  an action elsewhere — a search, a report — have none. */
  now?: (s: GuideState) => boolean;
}

const answered = (runtime: ReadonlyMap<string, ProbeRuntime>, status: HealthStatus) => [...runtime.values()].some((r) => r.status === status);

export const GUIDE_STEPS: GuideStep[] = [
  {
    id: 'select',
    title: 'Pick a device',
    detail: 'Click Core switch. The inspector on the right shows what is known about it: its addresses, the checks that watch it, what it is plugged into.',
    now: (s) => s.selectedDevice,
  },
  {
    id: 'link',
    title: 'Look at a link',
    detail: 'Click the line from Core switch to Access switch 1. You will see the port at each end, its speed and VLAN, and the error counters a crawl read.',
    now: (s) => s.selectedLink,
  },
  {
    id: 'validate',
    title: 'Start validation',
    detail: 'Press Start validation at the top. Every device with an address is checked from this computer, over and over, until you stop.',
    now: (s) => s.sessionRunning,
  },
  {
    id: 'answer',
    title: 'Watch the answers come in',
    detail: 'The edge firewall is on 127.0.0.1, this computer, so it goes green. The rest use documentation addresses nobody owns, so they go red — which is what a real outage looks like.',
    now: (s) => answered(s.runtime, 'healthy') && answered(s.runtime, 'down'),
  },
  {
    id: 'search',
    title: 'Find anything',
    detail: 'Press Ctrl+K (⌘K on a Mac) and type "acc sw". Search covers every device, address, port and VLAN on every page.',
  },
  {
    id: 'report',
    title: 'Make a report',
    detail: 'Export → Report as PDF…, choose Post-change verification, and see what is down set out with the drawing.',
  },
];

export interface GuideProgress {
  step: GuideStep;
  done: boolean;
}

export function guideProgress(s: GuideState): GuideProgress[] {
  return GUIDE_STEPS.map((step) => ({ step, done: s.done.includes(step.id) || Boolean(step.now?.(s)) }));
}

/** Steps whose condition holds now but which are not recorded yet. */
export function newlyDone(s: GuideState): string[] {
  return GUIDE_STEPS.filter((step) => !s.done.includes(step.id) && step.now?.(s)).map((step) => step.id);
}
