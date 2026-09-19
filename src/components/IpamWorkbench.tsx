/**
 * The IPAM tab (LT-297): the register seen as address space rather than as a
 * list of subnets.
 *
 * Four views, because they are four jobs. **Hierarchy** is where address space
 * is organised and handed out — containers, what is left in each, and which
 * routing table it is all in. **Allocate** is the wizard for "I need an address
 * for a new box", which is a different question from editing a row. **Split &
 * merge** changes the shape of a subnet, always through a plan that is shown
 * first. **History** is what happened to all of it.
 *
 * The Addresses tab is unchanged and still the place to read and edit rows.
 * This is the tab for the questions that need the whole picture at once.
 */
import { useMemo, useState } from 'react';

import { t } from '../i18n';
import {
  ASSIGNMENT_TYPES,
  DEFAULT_VRF,
  ENTRY_KINDS,
  buildIpam,
  utilisation,
  type AssignmentType,
  type EntryKind,
  type IpamBlock,
  type IpamContainerNode,
} from '../lib/ipam';
import { auditSentence } from '../lib/ipamAudit';
import { allocationProblems, freeBlocks, planMerge, planSplit } from '../lib/ipamPlan';
import { allNodes } from '../lib/pages';
import { formatTime } from '../lib/timeFormat';
import { useStore } from '../state/store';

export type WorkbenchView = 'hierarchy' | 'allocate' | 'split' | 'history';

const kindWord = (k: EntryKind) => t(`ipam.kind.${k}`);
const assignmentWord = (a: AssignmentType) => t(`ipam.assignment.${a}`);

/** `view` from outside means the screen above owns the tab bar (LT-300); on
 *  its own it keeps its own, which is how it lived in the bottom panel. */
export function IpamWorkbench({ view: fixed }: { view?: WorkbenchView } = {}) {
  const doc = useStore((s) => s.doc);
  const timeFormat = useStore((s) => s.settings.timeFormat);
  const store = useStore();
  const model = useMemo(() => buildIpam(allNodes(doc), doc.ipam), [doc]);

  const [own, setOwn] = useState<WorkbenchView>('hierarchy');
  const view = fixed ?? own;
  const setView = setOwn;
  const [vrfId, setVrfId] = useState<string>('');
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const say = (message: string | null, ok?: string) => {
    setProblem(message);
    setSaid(message ? null : (ok ?? null));
  };

  const inVrf = <T extends { vrfId: string }>(xs: readonly T[]) =>
    vrfId ? xs.filter((x) => x.vrfId === vrfId) : xs;

  const tab = (id: WorkbenchView, label: string) => (
    <button type="button" role="tab" aria-selected={view === id} tabIndex={view === id ? 0 : -1}
      className={view === id ? 'is-active' : ''} onClick={() => { setView(id); say(null); }}>
      {label}
    </button>
  );

  return (
    <div className="cv-lab">
      <div className="cv-lab-head">
        {!fixed && (
          <div className="cv-tabs cv-lab-tabs" role="tablist" aria-label={t('lab.tab')}>
            {tab('hierarchy', t('lab.hierarchy'))}
            {tab('allocate', t('lab.allocate'))}
            {tab('split', t('lab.splitMerge'))}
            {tab('history', t('lab.history'))}
          </div>
        )}
        <label className="cv-field cv-field-narrow">
          <span>{t('lab.vrf')}</span>
          <select className="cv-input" value={vrfId} onChange={(e) => setVrfId(e.target.value)}>
            <option value="">{t('lab.allVrfs')}</option>
            {model.vrfs.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      </div>

      {problem && <p className="cv-problem">{problem}</p>}
      {!problem && said && <p className="cv-help cv-lab-said">{said}</p>}

      {model.conflicts.length > 0 && (
        <div className="cv-lab-conflicts">
          <strong>{t('lab.conflicts', { count: model.conflicts.length })}</strong>
          <ul>
            {model.conflicts.slice(0, 6).map((c) => (
              <li key={`${c.vrfId}-${c.address}`}>
                {t('lab.conflictRow', {
                  address: c.address, cidr: c.cidr, who: c.holders.map((h) => h.label).join(' and '),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view === 'hierarchy' && (
        <Hierarchy model={model} vrfId={vrfId} store={store} say={say} inVrf={inVrf} />
      )}
      {view === 'allocate' && <Allocate model={model} vrfId={vrfId} store={store} say={say} />}
      {view === 'split' && <SplitMerge model={model} vrfId={vrfId} store={store} say={say} />}
      {view === 'history' && (
        <div className="cv-lab-view">
          <p className="cv-help cv-lab-note">{t('lab.historyNote')}</p>
          {(doc.ipam?.audit ?? []).length === 0 ? (
            <p className="cv-help">{t('lab.noHistory')}</p>
          ) : (
            <table className="cv-table">
              <thead>
                <tr><th>{t('lab.when')}</th><th>{t('lab.what')}</th><th>{t('lab.change')}</th></tr>
              </thead>
              <tbody>
                {(doc.ipam?.audit ?? []).map((e) => (
                  <tr key={e.id}>
                    <td className="cv-help">{formatTime(e.at, timeFormat)}</td>
                    <td>{auditSentence(e)}</td>
                    <td>
                      {(e.changes ?? []).length === 0 ? (
                        <span className="cv-help">—</span>
                      ) : (
                        <div className="cv-lab-diff">
                          {(e.changes ?? []).map((c, i) => (
                            <div key={`${c.field}-${i}`}>
                              {c.before !== undefined && <span className="cv-diff-out">− {c.field}: {c.before}</span>}
                              {c.before !== undefined && c.after !== undefined && ' '}
                              {c.after !== undefined && <span className="cv-diff-in">+ {c.field}: {c.after}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

type Store = ReturnType<typeof useStore.getState>;
type Say = (message: string | null, ok?: string) => void;

function Hierarchy({
  model, vrfId, store, say, inVrf,
}: {
  model: ReturnType<typeof buildIpam>;
  vrfId: string;
  store: Store;
  say: Say;
  inVrf: <T extends { vrfId: string }>(xs: readonly T[]) => readonly T[];
}) {
  const [addingContainer, setAddingContainer] = useState(false);
  const [cidr, setCidr] = useState('');
  const [name, setName] = useState('');
  const [managingVrfs, setManagingVrfs] = useState(false);
  const [vrfName, setVrfName] = useState('');
  const [takeFrom, setTakeFrom] = useState<string | null>(null);
  const [takePrefix, setTakePrefix] = useState('26');
  // LT-302: a subnet taken out of a container is defined as it is taken —
  // it used to be created nameless and then hunted down on the Addresses view.
  const [takeBlock, setTakeBlock] = useState('');
  const [takeName, setTakeName] = useState('');
  const [takeVlan, setTakeVlan] = useState('');
  const [takeNote, setTakeNote] = useState('');
  // LT-301: and a container can be edited, which it could not be at all.
  const [editing, setEditing] = useState<string | null>(null);
  const [editCidr, setEditCidr] = useState('');
  const [editName, setEditName] = useState('');
  const [editNote, setEditNote] = useState('');

  const openTake = (node: IpamContainerNode) => {
    setEditing(null);
    setTakeFrom(takeFrom === node.id ? null : node.id);
    setTakeBlock('');
    setTakeName('');
    setTakeVlan('');
    setTakeNote('');
    say(null);
  };

  const openEdit = (node: IpamContainerNode) => {
    setTakeFrom(null);
    setEditing(editing === node.id ? null : node.id);
    setEditCidr(node.cidr);
    setEditName(node.name);
    setEditNote(node.note ?? '');
    say(null);
  };

  const roots = inVrf(model.containers);
  const inContainer = new Set(
    model.containers.flatMap(function walk(c: IpamContainerNode): string[] {
      return [...c.subnets.map((b) => `${b.vrfId}|${b.cidr}`), ...c.children.flatMap(walk)];
    }),
  );
  const orphans = inVrf(model.blocks).filter((b) => !inContainer.has(`${b.vrfId}|${b.cidr}`));

  return (
    <div className="cv-lab-view">
      <div className="cv-lab-bar">
        <button type="button" className="cv-btn cv-btn-small"
          onClick={() => { setAddingContainer((a) => !a); say(null); }}>
          {addingContainer ? t('ipam.cancel') : t('lab.addContainer')}
        </button>
        <button type="button" className="cv-btn cv-btn-small" onClick={() => setManagingVrfs((m) => !m)}>
          {t('lab.vrfs')}
        </button>
        <span className="cv-help">{t('lab.declaredSubnets', { count: inVrf(model.blocks).length })}</span>
      </div>

      {addingContainer && (
        <div className="cv-discover-form cv-ipam-add">
          <p className="cv-help">{t('lab.containerHelp')}</p>
          <label className="cv-field cv-field-narrow">
            <span>{t('ipam.subnetField')}</span>
            <input className="cv-input" value={cidr} placeholder="10.0.0.0/8" autoComplete="off"
              onChange={(e) => setCidr(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('ipam.name')}</span>
            <input className="cv-input" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="button" className="cv-btn cv-btn-start"
            onClick={() => {
              const problem = store.addIpamContainer({ cidr, name, ...(vrfId ? { vrfId } : {}) });
              say(problem, `Added ${name}.`);
              if (!problem) { setCidr(''); setName(''); setAddingContainer(false); }
            }}>
            {t('ipam.add')}
          </button>
        </div>
      )}

      {managingVrfs && (
        <div className="cv-discover-form cv-ipam-add">
          <table className="cv-table cv-lab-vrfs">
            <tbody>
              {model.vrfs.map((v) => (
                <tr key={v.id}>
                  <td>{v.name}{v.id === DEFAULT_VRF.id && <span className="cv-help"> · built in</span>}</td>
                  <td className="cv-help">
                    {t('lab.inThisVrf', { count: model.blocks.filter((b) => b.vrfId === v.id).length })}
                  </td>
                  <td className="cv-ipam-actions">
                    {v.id !== DEFAULT_VRF.id && (
                      <button type="button" className="cv-btn cv-btn-small"
                        onClick={() => say(store.removeIpamVrf(v.id), `Removed ${v.name}.`)}>
                        {t('ipam.remove')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <label className="cv-field cv-field-narrow">
            <span>{t('lab.addVrf')}</span>
            <input className="cv-input" value={vrfName} autoComplete="off"
              onChange={(e) => setVrfName(e.target.value)} />
          </label>
          <button type="button" className="cv-btn cv-btn-start"
            onClick={() => {
              const problem = store.addIpamVrf({ name: vrfName });
              say(problem, `Added ${vrfName}.`);
              if (!problem) setVrfName('');
            }}>
            {t('ipam.add')}
          </button>
        </div>
      )}

      {roots.length === 0 ? (
        <p className="cv-help cv-ipam-empty">{t('lab.noContainers')}</p>
      ) : (
        <table className="cv-table cv-lab-tree">
          <thead>
            <tr>
              <th>{t('lab.container')}</th>
              <th>{t('lab.capacity')}</th>
              <th>{t('lab.allocated')}</th>
              <th>{t('lab.freeSpace')}</th>
              <th>{t('lab.usedAddresses')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {roots.map((c) => (
              <ContainerRows key={c.id} node={c} depth={0} store={store} say={say}
                takeFrom={takeFrom} openTake={openTake}
                takePrefix={takePrefix} setTakePrefix={setTakePrefix}
                takeBlock={takeBlock} setTakeBlock={setTakeBlock}
                takeName={takeName} setTakeName={setTakeName}
                takeVlan={takeVlan} setTakeVlan={setTakeVlan}
                takeNote={takeNote} setTakeNote={setTakeNote}
                editing={editing} openEdit={openEdit} closeForms={() => { setTakeFrom(null); setEditing(null); }}
                editCidr={editCidr} setEditCidr={setEditCidr}
                editName={editName} setEditName={setEditName}
                editNote={editNote} setEditNote={setEditNote} />
            ))}
          </tbody>
        </table>
      )}

      {orphans.length > 0 && (
        <>
          <h3 className="cv-lab-h3">{t('lab.orphans')}</h3>
          <table className="cv-table">
            <tbody>
              {orphans.map((b) => (
                <tr key={`${b.vrfId}-${b.cidr}`}>
                  <td className="mono">{b.cidr}</td>
                  <td>{b.name ?? ''}</td>
                  <td className="cv-help">{t('ipam.usedOf', { used: b.used, usable: b.usable })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function ContainerRows({
  node, depth, store, say,
  takeFrom, openTake, takePrefix, setTakePrefix,
  takeBlock, setTakeBlock, takeName, setTakeName, takeVlan, setTakeVlan, takeNote, setTakeNote,
  editing, openEdit, closeForms, editCidr, setEditCidr, editName, setEditName, editNote, setEditNote,
}: {
  node: IpamContainerNode;
  depth: number;
  store: Store;
  say: Say;
  takeFrom: string | null;
  openTake: (node: IpamContainerNode) => void;
  takePrefix: string;
  setTakePrefix: (v: string) => void;
  takeBlock: string;
  setTakeBlock: (v: string) => void;
  takeName: string;
  setTakeName: (v: string) => void;
  takeVlan: string;
  setTakeVlan: (v: string) => void;
  takeNote: string;
  setTakeNote: (v: string) => void;
  editing: string | null;
  openEdit: (node: IpamContainerNode) => void;
  closeForms: () => void;
  editCidr: string;
  setEditCidr: (v: string) => void;
  editName: string;
  setEditName: (v: string) => void;
  editNote: string;
  setEditNote: (v: string) => void;
}) {
  // "/24" is what a network engineer types. Reading it as a number gave NaN,
  // no free blocks, and a message about the container being full — which was
  // the wrong answer to the wrong question (LT-304).
  const prefix = Number(takePrefix.trim().replace(/^\//, ''));
  const goodPrefix = Number.isInteger(prefix) && prefix > 0 && prefix <= 32;
  const taking = takeFrom === node.id;
  const free = taking && goodPrefix ? freeBlocks(node, prefix, 8) : [];
  const chosen = free.find((b) => b.cidr === takeBlock) ?? free[0];

  /** What is using every address, when nothing is free. Said out loud, because
   *  "nothing of that size is free" is true and useless on its own (LT-302). */
  const usingItAll = [
    ...node.children.map((c) => t('lab.takenByOne', { cidr: c.cidr, name: c.name ? ` (${c.name})` : '' })),
    ...node.subnets.map((b) => t('lab.takenByOne', { cidr: b.cidr, name: b.name ? ` (${b.name})` : '' })),
  ];

  const take = () => {
    if (!chosen) return;
    const vlan = takeVlan.trim() ? Number(takeVlan.trim()) : undefined;
    if (vlan !== undefined && (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094)) {
      say(t('ipam.vlanRange'));
      return;
    }
    // One call: adding and then editing would write two lines of history for
    // one decision, and the second call would read a store captured at render.
    const problem = store.addIpamSubnet(chosen.cidr, {
      containerId: node.id,
      ...(takeName.trim() ? { name: takeName } : {}),
      ...(vlan !== undefined ? { vlan } : {}),
      ...(takeNote.trim() ? { note: takeNote } : {}),
      ...(node.vrfId !== DEFAULT_VRF.id ? { vrfId: node.vrfId } : {}),
    });
    say(problem, t('lab.tookIt', { cidr: chosen.cidr, container: node.name }));
    if (!problem) closeForms();
  };

  return (
    <>
      <tr className="cv-lab-container">
        <td style={{ paddingLeft: 10 + depth * 18 }}>
          <span className="cv-pill-container">container</span> <span className="mono">{node.cidr}</span>{' '}
          <span className="cv-dim">{node.name}</span>
        </td>
        <td className="mono">{node.capacity.toLocaleString()}</td>
        <td className="mono">{node.allocated.toLocaleString()}</td>
        <td className="mono">{node.freeSpace.toLocaleString()}</td>
        <td className="mono">{node.used.toLocaleString()} <span className="cv-help">of {node.usable.toLocaleString()}</span></td>
        <td className="cv-ipam-actions">
          <button type="button" className="cv-btn cv-btn-small" onClick={() => openEdit(node)}>
            {t('ipam.edit')}
          </button>
          <button type="button" className="cv-btn cv-btn-small" onClick={() => openTake(node)}>
            {t('lab.addSubnetHere')}
          </button>
          <button type="button" className="cv-btn cv-btn-small"
            onClick={() => { store.removeIpamContainer(node.id); say(null, `Removed ${node.name}.`); }}>
            {t('ipam.remove')}
          </button>
        </td>
      </tr>

      {editing === node.id && (
        <tr className="cv-ipam-form-row">
          <td colSpan={6}>
            <div className="cv-discover-form cv-ipam-add">
              <label className="cv-field cv-field-narrow">
                <span>{t('ipam.subnetField')}</span>
                <input className="cv-input" value={editCidr} autoComplete="off"
                  onChange={(e) => setEditCidr(e.target.value)} />
              </label>
              <label className="cv-field cv-field-narrow">
                <span>{t('ipam.name')}</span>
                <input className="cv-input" value={editName} autoComplete="off"
                  onChange={(e) => setEditName(e.target.value)} />
              </label>
              <label className="cv-field">
                <span>{t('ipam.note')}</span>
                <input className="cv-input" value={editNote} autoComplete="off"
                  onChange={(e) => setEditNote(e.target.value)} />
              </label>
              <button type="button" className="cv-btn cv-btn-start"
                onClick={() => {
                  const problem = store.updateIpamContainer(node.id, {
                    cidr: editCidr, name: editName, note: editNote,
                  });
                  say(problem, t('lab.containerSaved', { name: editName.trim() || node.name }));
                  if (!problem) closeForms();
                }}>
                {t('ipam.save')}
              </button>
              <button type="button" className="cv-btn cv-btn-small" onClick={closeForms}>
                {t('ipam.cancel')}
              </button>
            </div>
          </td>
        </tr>
      )}

      {taking && (
        <tr className="cv-ipam-form-row">
          <td colSpan={6}>
            <div className="cv-discover-form cv-ipam-add">
              <label className="cv-field cv-field-narrow">
                <span>{t('lab.prefix')}</span>
                <input className="cv-input" value={takePrefix} inputMode="numeric" autoComplete="off"
                  onChange={(e) => { setTakePrefix(e.target.value); setTakeBlock(''); }} />
              </label>
              {!goodPrefix ? (
                <p className="cv-help">{t('lab.badPrefix')}</p>
              ) : prefix <= node.prefix ? (
                <p className="cv-help">{t('lab.tooBig', { size: prefix, container: node.cidr })}</p>
              ) : free.length === 0 ? (
                <p className="cv-help">
                  {usingItAll.length
                    ? t('lab.takenBy', { what: usingItAll.join(', ') })
                    : t('lab.nothingFree')}
                </p>
              ) : (
                <>
                  <label className="cv-field cv-field-narrow">
                    <span>{t('lab.whichBlock')}</span>
                    <select className="cv-input" value={chosen?.cidr ?? ''}
                      onChange={(e) => setTakeBlock(e.target.value)}>
                      {free.map((b) => <option key={b.cidr} value={b.cidr}>{b.cidr}</option>)}
                    </select>
                  </label>
                  <label className="cv-field cv-field-narrow">
                    <span>{t('ipam.name')}</span>
                    <input className="cv-input" value={takeName} autoComplete="off"
                      onChange={(e) => setTakeName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') take(); }} />
                  </label>
                  <label className="cv-field cv-field-narrow">
                    <span>{t('ipam.colVlan')}</span>
                    <input className="cv-input" value={takeVlan} inputMode="numeric" autoComplete="off"
                      onChange={(e) => setTakeVlan(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') take(); }} />
                  </label>
                  <label className="cv-field">
                    <span>{t('ipam.note')}</span>
                    <input className="cv-input" value={takeNote} autoComplete="off"
                      onChange={(e) => setTakeNote(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') take(); }} />
                  </label>
                  <button type="button" className="cv-btn cv-btn-start" onClick={take}>
                    {t('lab.takeAndName')}
                  </button>
                </>
              )}
              <button type="button" className="cv-btn cv-btn-small" onClick={closeForms}>
                {t('ipam.cancel')}
              </button>
            </div>
          </td>
        </tr>
      )}

      {node.subnets.map((b) => (
        <tr key={`${b.vrfId}-${b.cidr}`} className="cv-lab-subnet">
          <td style={{ paddingLeft: 10 + (depth + 1) * 18 }}>
            <span className="cv-pill-subnet">subnet</span> <span className="mono">{b.cidr}</span>{' '}
            <span className="cv-dim">{b.name ?? ''}</span>
          </td>
          <td className="mono">{(2 ** (32 - b.prefix)).toLocaleString()}</td>
          <td className="cv-help">—</td>
          <td className="mono">{b.free.toLocaleString()}</td>
          <td className="mono">
            <span className="cv-ipam-meter" title={t('ipam.utilisation', { percent: utilisation(b), usable: b.usable })}>
              <span className="cv-ipam-meter-fill" style={{ width: `${utilisation(b)}%` }} />
            </span>
            {b.used.toLocaleString()} <span className="cv-help">of {b.usable.toLocaleString()}</span>
          </td>
          <td />
        </tr>
      ))}

      {node.children.map((c) => (
        <ContainerRows key={c.id} node={c} depth={depth + 1} store={store} say={say}
          takeFrom={takeFrom} openTake={openTake} takePrefix={takePrefix} setTakePrefix={setTakePrefix}
          takeBlock={takeBlock} setTakeBlock={setTakeBlock}
          takeName={takeName} setTakeName={setTakeName}
          takeVlan={takeVlan} setTakeVlan={setTakeVlan}
          takeNote={takeNote} setTakeNote={setTakeNote}
          editing={editing} openEdit={openEdit} closeForms={closeForms}
          editCidr={editCidr} setEditCidr={setEditCidr}
          editName={editName} setEditName={setEditName}
          editNote={editNote} setEditNote={setEditNote} />
      ))}
    </>
  );
}

function Allocate({
  model, vrfId, store, say,
}: {
  model: ReturnType<typeof buildIpam>;
  vrfId: string;
  store: Store;
  say: Say;
}) {
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState('');
  const [method, setMethod] = useState<'next' | 'specific'>('next');
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<EntryKind>('in-use');
  const [assignment, setAssignment] = useState<AssignmentType>('static');
  const [hostname, setHostname] = useState('');
  const [mac, setMac] = useState('');
  const [owner, setOwner] = useState('');
  const [purpose, setPurpose] = useState('');

  const candidates = model.blocks
    .filter((b) => !vrfId || b.vrfId === vrfId)
    .filter((b) => {
      const q = search.trim().toLowerCase();
      return !q || b.cidr.includes(q) || (b.name ?? '').toLowerCase().includes(q) || String(b.vlan ?? '').includes(q);
    });

  const block = model.blocks.find((b) => `${b.vrfId}|${b.cidr}` === chosen);
  const wanted = method === 'next' ? (block?.nextFree ?? '') : address;
  const problems = block && wanted ? allocationProblems(model.blocks, block, wanted, mac) : [];
  const ready = Boolean(block && wanted && problems.length === 0);

  return (
    <div className="cv-lab-view cv-lab-wizard">
      <section>
        <h3 className="cv-lab-h3">{t('lab.step', { n: 1 })} · {t('lab.pickSubnet')}</h3>
        <div className="cv-discover-form">
          <label className="cv-field">
            <span>{t('lab.searchSubnet')}</span>
            <input className="cv-input" value={search} autoComplete="off" onChange={(e) => setSearch(e.target.value)} />
          </label>
          <label className="cv-field">
            <span>{t('lab.pickSubnet')}</span>
            <select className="cv-input" value={chosen} onChange={(e) => { setChosen(e.target.value); say(null); }}>
              <option value="">—</option>
              {candidates.map((b) => (
                <option key={`${b.vrfId}|${b.cidr}`} value={`${b.vrfId}|${b.cidr}`}>
                  {b.cidr}{b.name ? ` · ${b.name}` : ''} — {b.free} free
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section>
        <h3 className="cv-lab-h3">{t('lab.step', { n: 2 })} · {t('lab.method')}</h3>
        <div className="cv-discover-form">
          <label className="cv-check cv-check-inline">
            <input type="radio" name="how" checked={method === 'next'} onChange={() => setMethod('next')} />
            {t('lab.nextFree')}{block?.nextFree ? ` — ${block.nextFree}` : ''}
          </label>
          <label className="cv-check cv-check-inline">
            <input type="radio" name="how" checked={method === 'specific'} onChange={() => setMethod('specific')} />
            {t('lab.specific')}
          </label>
          {method === 'specific' && (
            <label className="cv-field cv-field-narrow">
              <span>{t('ipam.addressField')}</span>
              <input className="cv-input" value={address} autoComplete="off"
                onChange={(e) => setAddress(e.target.value)} />
            </label>
          )}
        </div>
      </section>

      <section>
        <h3 className="cv-lab-h3">{t('lab.step', { n: 3 })} · {t('lab.details')}</h3>
        <div className="cv-discover-form">
          <label className="cv-field cv-field-narrow">
            <span>{t('ipam.name')}</span>
            <input className="cv-input" value={label} autoComplete="off" onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('ipam.heldAs')}</span>
            <select className="cv-input" value={kind} onChange={(e) => setKind(e.target.value as EntryKind)}>
              {ENTRY_KINDS.map((k) => <option key={k} value={k}>{kindWord(k)}</option>)}
            </select>
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('ipam.usedAs')}</span>
            <select className="cv-input" value={assignment}
              onChange={(e) => setAssignment(e.target.value as AssignmentType)}>
              {ASSIGNMENT_TYPES.map((k) => <option key={k} value={k}>{assignmentWord(k)}</option>)}
            </select>
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('ipam.hostname')}</span>
            <input className="cv-input" value={hostname} autoComplete="off"
              onChange={(e) => setHostname(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('ipam.mac')}</span>
            <input className="cv-input" value={mac} autoComplete="off" onChange={(e) => setMac(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('ipam.owner')}</span>
            <input className="cv-input" value={owner} autoComplete="off" onChange={(e) => setOwner(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('ipam.purpose')}</span>
            <input className="cv-input" value={purpose} autoComplete="off"
              onChange={(e) => setPurpose(e.target.value)} />
          </label>
        </div>
      </section>

      <section>
        <h3 className="cv-lab-h3">{t('lab.step', { n: 4 })} · {t('lab.check')}</h3>
        {!block ? (
          <p className="cv-help">{t('lab.pickFirst')}</p>
        ) : problems.length > 0 ? (
          <div className="cv-lab-problems">
            <p>{t('lab.wontAllocate')}</p>
            <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        ) : (
          <p className="cv-help">{t('lab.readyToAllocate', { address: wanted, cidr: block.cidr })}</p>
        )}
        <button type="button" className="cv-btn cv-btn-start" disabled={!ready}
          onClick={() => {
            if (!block) return;
            const problem = store.addIpamEntry({
              address: wanted,
              label,
              kind,
              assignment,
              ...(hostname.trim() ? { hostname } : {}),
              ...(mac.trim() ? { mac } : {}),
              ...(owner.trim() ? { owner } : {}),
              ...(purpose.trim() ? { purpose } : {}),
              ...(block.vrfId !== DEFAULT_VRF.id ? { vrfId: block.vrfId } : {}),
            });
            say(problem, t('lab.allocated1', { address: wanted, cidr: block.cidr }));
            if (!problem) { setLabel(''); setHostname(''); setMac(''); setOwner(''); setPurpose(''); setAddress(''); }
          }}>
          {t('lab.allocateIt')}
        </button>
      </section>
    </div>
  );
}

function SplitMerge({
  model, vrfId, store, say,
}: {
  model: ReturnType<typeof buildIpam>;
  vrfId: string;
  store: Store;
  say: Say;
}) {
  const declared = model.blocks.filter((b) => b.subnetId && (!vrfId || b.vrfId === vrfId));
  const [chosen, setChosen] = useState('');
  const [into, setInto] = useState('26');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');

  const keyOf = (b: IpamBlock) => `${b.vrfId}|${b.cidr}`;
  const block = declared.find((b) => keyOf(b) === chosen);
  const plan = block ? planSplit(block, Number(into)) : null;

  const a = declared.find((b) => keyOf(b) === first);
  const b2 = declared.find((b) => keyOf(b) === second);
  const merge = a && b2 ? planMerge(a, b2) : null;

  return (
    <div className="cv-lab-view">
      <p className="cv-help cv-lab-note">{t('lab.onlyDeclared')}</p>

      <section>
        <h3 className="cv-lab-h3">{t('lab.splitInto')}</h3>
        <div className="cv-discover-form">
          <label className="cv-field">
            <span>{t('ipam.colSubnet')}</span>
            <select className="cv-input" value={chosen} onChange={(e) => { setChosen(e.target.value); say(null); }}>
              <option value="">—</option>
              {declared.map((b) => (
                <option key={keyOf(b)} value={keyOf(b)}>{b.cidr}{b.name ? ` · ${b.name}` : ''}</option>
              ))}
            </select>
          </label>
          <label className="cv-field cv-field-narrow">
            <span>{t('lab.prefix')}</span>
            <input className="cv-input" value={into} inputMode="numeric" autoComplete="off"
              onChange={(e) => setInto(e.target.value)} />
          </label>
          <button type="button" className="cv-btn cv-btn-start"
            disabled={!plan || Boolean(plan.problem) || plan.straddling.length > 0}
            onClick={() => {
              if (!block || !plan) return;
              const problem = store.splitIpamSubnet(block.cidr, block.vrfId, Number(into));
              say(problem, t('lab.splitDone', { cidr: block.cidr, count: plan.children.length }));
              if (!problem) setChosen('');
            }}>
            {t('lab.splitIt')}
          </button>
        </div>

        {plan?.problem && <p className="cv-problem">{plan.problem}</p>}

        {plan && !plan.problem && (
          <>
            {plan.straddling.length > 0 && (
              <div className="cv-lab-problems">
                <p>{t('lab.straddles')}</p>
                <ul>
                  {plan.straddling.map((r) => (
                    <li key={r.id}>
                      {t('lab.straddleRow', {
                        name: r.name ?? r.kind, from: r.from, to: r.to, across: r.across.join(' and '),
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="cv-help">{t('lab.splitReview')}</p>
            <table className="cv-table">
              <thead>
                <tr>
                  <th>{t('ipam.colSubnet')}</th><th>{t('ipam.colAddress')}</th>
                  <th>{t('ipam.colUsed')}</th><th>{t('ipam.ranges', { count: 0 }).replace(/^0\s*/, '')}</th>
                </tr>
              </thead>
              <tbody>
                {plan.children.map((c) => (
                  <tr key={c.cidr}>
                    <td className="mono">{c.cidr}</td>
                    <td className="mono cv-help">{c.firstUsable} – {c.lastUsable}</td>
                    <td>{c.addresses.length}</td>
                    <td>{c.ranges.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section>
        <h3 className="cv-lab-h3">{t('lab.mergeTwo')}</h3>
        <div className="cv-discover-form">
          <label className="cv-field">
            <span>{t('lab.mergeFirst')}</span>
            <select className="cv-input" value={first} onChange={(e) => { setFirst(e.target.value); say(null); }}>
              <option value="">—</option>
              {declared.map((b) => <option key={keyOf(b)} value={keyOf(b)}>{b.cidr}</option>)}
            </select>
          </label>
          <label className="cv-field">
            <span>{t('lab.mergeSecond')}</span>
            <select className="cv-input" value={second} onChange={(e) => { setSecond(e.target.value); say(null); }}>
              <option value="">—</option>
              {declared.map((b) => <option key={keyOf(b)} value={keyOf(b)}>{b.cidr}</option>)}
            </select>
          </label>
          <button type="button" className="cv-btn cv-btn-start" disabled={!merge || Boolean(merge.problem)}
            onClick={() => {
              if (!a || !b2 || !merge || merge.problem) return;
              const problem = store.mergeIpamSubnets([a.cidr, b2.cidr], a.vrfId, merge.cidr);
              say(problem, t('lab.mergeDone', { parts: merge.parts.join(' and '), cidr: merge.cidr }));
              if (!problem) { setFirst(''); setSecond(''); }
            }}>
            {t('lab.mergeIt')}
          </button>
        </div>
        {merge?.problem && <p className="cv-problem">{merge.problem}</p>}
        {merge && !merge.problem && (
          <p className="cv-help">
            {t('lab.mergeResult', { cidr: merge.cidr, addresses: merge.addresses, ranges: merge.ranges })}
          </p>
        )}
      </section>
    </div>
  );
}
