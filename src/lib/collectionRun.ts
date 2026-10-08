/**
 * A collection run on the Collect tab, kept outside the panel.
 *
 * The panel unmounts when another tab is shown, and a run started from it
 * goes on in the backend. Whether one is running, the last two hundred lines
 * of what the collector said, and which run just finished live in the
 * store, so the panel shows them whenever it is mounted. One listener,
 * started the first time the panel asks and never removed: the events must
 * be heard with no panel. The same move as the Discover run.
 */
import { sweptLine } from './subnetScan';
import { ipc, type CollectionEvent } from './ipc';
import { useStore } from '../state/store';
import { t } from '../i18n';

const hosts = new Map<string, string>();

/** One line of the live log for an event, or nothing for the quiet ones. */
export function describeCollectionEvent(e: CollectionEvent): string | null {
  const host = 'deviceId' in e ? (hosts.get(e.deviceId) ?? e.deviceId) : '';
  switch (e.kind) {
    case 'identified':
      return t('collect.identified', { host, os: e.os, probe: e.probe });
    case 'probe':
      return e.flags.length ? t('collect.probed', { host, cmd: e.cmd, flags: e.flags.join(', ') }) : t('collect.probedNothing', { host, cmd: e.cmd });
    case 'planned':
      return t('collect.planned', { host, steps: e.steps, skipped: e.skipped });
    case 'step':
      return t('collect.stepDone', { host, cmd: e.context ? `${e.cmd} [${e.context}]` : e.cmd, status: e.status, rows: e.rows, ms: e.durationMs });
    case 'deviceDone':
      return e.failure ? t('collect.deviceFailed', { host: e.host, failure: e.failure }) : t('collect.deviceDone', { host: e.host, commands: e.commands });
    case 'finished':
      return e.cancelled ? t('collect.cancelled', { devices: e.devices }) : t('collect.finished', { devices: e.devices, failed: e.failed });
    case 'failed':
      return t('collect.failed', { error: e.error });
    case 'scanned':
      return sweptLine(e);
    default:
      return null;
  }
}

let watching = false;

/** Start listening, once. Safe to call from every mount. */
export function watchCollectionRuns(): void {
  if (watching) return;
  watching = true;
  void ipc.onCollectionEvent((e: CollectionEvent) => {
    if (e.kind === 'device') hosts.set(e.deviceId, e.host);
    const store = useStore.getState();
    const line = describeCollectionEvent(e);
    const run = store.collectionRun;
    const live = line ? [...run.live.slice(-199), line] : run.live;
    if (e.kind === 'finished' || e.kind === 'failed') {
      store.setCollectionRun({ live, busy: false, finished: e.kind === 'finished' ? e.runId : run.finished });
    } else if (line) {
      store.setCollectionRun({ live });
    }
  });
}
