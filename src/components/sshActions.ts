/**
 * Opening a shell on a device (LT-320, LT-321): from the canvas menu, and
 * from the inspector's action row (LT-677). One place, so both ask the same
 * questions in the same order and report the same refusals.
 */
import { ipc } from '../lib/ipc';
import { planSsh, sshAddress } from '../lib/sshLaunch';
import { t } from '../i18n';
import { useStore } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

/**
 * Opens a shell on a device and puts its tab in front (LT-320).
 *
 * The two ways this fails before anything is sent — no address, no credential
 * of its own — are decided by `planSsh` and reported as themselves. A timeout
 * would be the wrong answer to both.
 */
export async function openSsh(nodeId: string, data: DeviceNodeData) {
  const store = useStore.getState();
  // LT-330: the project's login is what a device with none of its own uses.
  const plan = planSsh(data, store.doc.credentialDefaults?.ssh);
  if (!plan.ok) {
    store.setStatusMessage(t(plan.reason === 'noAddress' ? 'ssh.noAddress' : 'ssh.noCredential'));
    return;
  }
  store.setStatusMessage(t('ssh.opening', { name: plan.label }));
  store.requestPanelTab('ssh');
  try {
    // A size the device can use straight away; the terminal tells it the real
    // one as soon as it has been laid out.
    const { keepaliveSeconds, logByDefault } = store.settings.terminal;
    const id = await ipc.sshOpen(plan.address, plan.credentialId, { cols: 120, rows: 30 }, undefined, keepaliveSeconds);
    useStore.getState().openSshTab({ id, address: plan.address, label: plan.label, nodeId, status: 'open', credentialId: plan.credentialId });
    useStore.getState().setStatusMessage(null);
    // LT-324: logging every session without being asked each time.
    const folder = useStore.getState().settings.backupFolder;
    if (logByDefault && folder) {
      await ipc
        .sshLogStart(id, { folder, device: plan.label, address: plan.address, site: data.site ?? '' })
        .catch((e: unknown) => useStore.getState().setStatusMessage(e instanceof Error ? e.message : String(e)));
    }
  } catch (e: unknown) {
    useStore.getState().setStatusMessage(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Hands the device to whatever terminal the machine already has (LT-321).
 *
 * The username goes with it and the password does not: every external client
 * that takes one takes it on a command line, where the rest of the machine can
 * read it. The client asks. Coreview then knows nothing about the session —
 * no transcript, no colouring, no keepalive, which is what the panel is for.
 */
export async function openSshElsewhere(data: DeviceNodeData) {
  const store = useStore.getState();
  const address = sshAddress(data);
  if (!address) {
    store.setStatusMessage(t('ssh.noAddress'));
    return;
  }
  try {
    const argv = await ipc.sshExternal(address, await sshUsername(data), undefined, store.settings.terminal.externalCommand);
    store.setStatusMessage(t('ssh.externalRan', { command: argv[0] ?? '' }));
  } catch (e: unknown) {
    store.setStatusMessage(e instanceof Error ? e.message : String(e));
  }
}

/**
 * The username an external client should be handed.
 *
 * It comes out of the vault's *summary* — the label and username of a saved
 * credential, which is not a secret and is already listed in Settings. The
 * password stays where it is. With no credential chosen there is nothing to
 * pass, and the client asks for both.
 */
async function sshUsername(data: DeviceNodeData): Promise<string> {
  const id = data.sshCredentialId?.trim();
  if (!id) return '';
  const saved = await ipc.listCredentials().catch(() => []);
  return saved.find((c) => c.id === id)?.username ?? '';
}
