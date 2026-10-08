/**
 * A Discover-devices run on the collector, kept outside the panel.
 *
 * The panel unmounts when another tab is shown, and a run started from it
 * goes on in the backend. What the run is doing, which devices failed and
 * why, and its result when it ends live in the store, so the panel shows
 * them whenever it is mounted. One listener, started the first time the
 * panel asks and never removed: the events must be heard with no panel.
 */
import { sweptLine } from './subnetScan';
import { ipc } from './ipc';
import type { CollectionEvent, CollectionInput, CredentialInput } from './ipc';
import { useStore } from '../state/store';
import { t } from '../i18n';

export type DiscoverRun = {
  /** `pending` until the backend names the run. */
  runId: string;
  status: string;
  failures: { address: string; reason: string }[];
};

/** A device's failure code, as the collector reports it, in words. */
export function reasonFor(code: string): string {
  switch (code) {
    case 'auth':
      return t('discover.failure.auth');
    case 'host_key':
      return t('discover.failure.hostKey');
    case 'timeout':
      return t('discover.failure.timeout');
    case 'unrecognised':
      return t('discover.failure.unrecognised');
    case 'sidecar':
      return t('discover.failure.sidecar');
    case 'store':
      return t('discover.failure.store');
    default:
      return t('discover.failure.other', { code });
  }
}

let watching = false;
const hosts = new Map<string, string>();

/** Start listening, once. Safe to call from every mount. */
export function watchDiscoverRuns(): void {
  if (watching) return;
  watching = true;
  void ipc.onCollectionEvent((e: CollectionEvent) => {
    const store = useStore.getState();
    const run = store.discoverRun;
    if (!run) return;
    if (e.kind === 'started') {
      if (run.runId === 'pending') store.setDiscoverRun({ ...run, runId: e.runId });
      return;
    }
    if (run.runId !== e.runId) return;
    if (e.kind === 'device') {
      hosts.set(e.deviceId, e.host);
      store.setDiscoverRun({ ...run, status: t('discover.collecting', { host: e.host }) });
    }
    // The last command a device answered, so a stall says where.
    if (e.kind === 'step') store.setDiscoverRun({ ...run, status: t('discover.collectingStep', { host: hosts.get(e.deviceId) ?? e.deviceId, cmd: e.cmd }) });
    // What a ticked subnet's sweep found.
    if (e.kind === 'scanned') store.setDiscoverRun({ ...run, status: sweptLine(e) });
    // Why a device failed, kept with its address.
    if (e.kind === 'deviceDone' && e.failure) store.setDiscoverRun({ ...run, failures: [...run.failures, { address: e.host, reason: reasonFor(e.failure) }] });
    if (e.kind === 'failed') {
      store.setDiscoverRun(null);
      store.setPendingCrawlResult({ devices: [], notVisited: [], label: e.error, failures: run.failures });
    }
    if (e.kind === 'finished') {
      const failures = useStore.getState().discoverRun?.failures ?? run.failures;
      void ipc
        .collectionTopology(e.runId, { collapseBundles: true, collapseStacks: true, placeholders: true, minConfidence: 0 })
        .then((topo) => {
          useStore.getState().setPendingCrawlResult({
            devices: topo.devices,
            notVisited: topo.notVisited,
            label: t('discover.collected', { devices: t('plural.device', { count: e.devices }), failed: e.failed, run: e.runId }),
            failures,
          });
        })
        .catch((err: unknown) => {
          useStore.getState().setPendingCrawlResult({ devices: [], notVisited: [], label: err instanceof Error ? err.message : String(err), failures });
        })
        .finally(() => useStore.getState().setDiscoverRun(null));
    }
  });
}

/** Start a run and note it in the store; the listener does the rest. */
export async function startDiscoverRun(input: CollectionInput, credentials: CredentialInput | undefined, backup?: CredentialInput): Promise<void> {
  const store = useStore.getState();
  hosts.clear();
  store.setDiscoverRun({ runId: 'pending', status: t('discover.starting'), failures: [] });
  try {
    const runId = await ipc.startCollection(input, credentials, backup);
    const now = useStore.getState().discoverRun;
    if (now && now.runId === 'pending') useStore.getState().setDiscoverRun({ ...now, runId });
  } catch (err) {
    useStore.getState().setDiscoverRun(null);
    throw err;
  }
}
