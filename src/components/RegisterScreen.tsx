/**
 * The address register, on a screen of its own (LT-300).
 *
 * It used to be two tabs in the bottom panel — "Addresses" for the table and
 * "IPAM" for the hierarchy and the tools — which is a distinction that exists
 * because one was built before the other, and which nobody could explain. They
 * are one thing: the register. This is that thing, with the table as its first
 * view.
 *
 * A screen rather than a panel because the register is not *about* the diagram.
 * It is the second job this application does, and the tall views — a split
 * review, a deep hierarchy — were being clipped by a panel sized for watching a
 * scan run.
 *
 * The diagram stays mounted behind it, so leaving comes back to the same
 * selection and the same viewport.
 */
import { useState } from 'react';

import { t } from '../i18n';
import { IpamPanel } from './IpamPanel';
import { IpamWorkbench, type WorkbenchView } from './IpamWorkbench';
import { useStore } from '../state/store';

/** One bar of five, not a bar of two with another inside it. */
type View = 'addresses' | WorkbenchView;

const VIEWS: { id: View; label: () => string }[] = [
  { id: 'addresses', label: () => t('register.addresses') },
  { id: 'hierarchy', label: () => t('lab.hierarchy') },
  { id: 'allocate', label: () => t('lab.allocate') },
  { id: 'split', label: () => t('lab.splitMerge') },
  { id: 'history', label: () => t('lab.history') },
];

export function RegisterScreen() {
  const close = useStore((s) => s.setRegisterOpen);
  const name = useStore((s) => s.meta?.name ?? '');
  const [view, setView] = useState<View>('addresses');

  return (
    <div className="cv-register" data-region="register">
      <div className="cv-register-head">
        <h1 className="cv-register-title">
          {t('register.title')}
          {name && <span className="cv-register-project"> · {name}</span>}
        </h1>
        <div className="cv-tabs cv-register-tabs" role="tablist" aria-label={t('register.title')}>
          {VIEWS.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={view === v.id}
              tabIndex={view === v.id ? 0 : -1}
              className={view === v.id ? 'is-active' : ''} onClick={() => setView(v.id)}>
              {v.label()}
            </button>
          ))}
        </div>
        <button type="button" className="cv-btn cv-register-back" onClick={() => close(false)}>
          {t('register.back')}
        </button>
      </div>

      <div className="cv-register-body">
        {view === 'addresses' ? <IpamPanel /> : <IpamWorkbench view={view} />}
      </div>
    </div>
  );
}
