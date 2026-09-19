/**
 * The address register (LT-285), which the admin edits (LT-288, LT-289),
 * with ranges (LT-294), a fuller record per address (LT-297), and the
 * device's own addresses editable from here (LT-295).
 *
 * An engineer keeps this in a spreadsheet beside the diagram, and the two
 * disagree within a month. Here the known half is not kept at all: it is read
 * from the devices on the diagram every time this is drawn, so an address that
 * moves in the project has already moved in the register. What is typed here
 * is the part no device can tell you — the subnets someone has decided on, the
 * addresses held back or in use elsewhere, and the spans a DHCP server owns.
 *
 * A subnet Coreview worked out for itself can be named, and naming it *adopts*
 * it: the register gains a declared entry, and from then on it can be edited
 * and removed like any other. Removing it returns the subnet to derived rather
 * than hiding the addresses on it, because the addresses are real.
 *
 * Nothing ships in it. There are no example subnets and no default plan
 * (D-027): an empty register says what it is for and waits.
 */
import { useMemo, useState } from 'react';

import { t } from '../i18n';
import {
  ASSIGNMENT_TYPES,
  ENTRY_KINDS,
  RANGE_KINDS,
  buildIpam,
  utilisation,
  type AssignmentType,
  type EntryKind,
  type IpamAddress,
  type IpamBlock,
  type RangeKind,
} from '../lib/ipam';
import { allNodes } from '../lib/pages';
import { useStore } from '../state/store';

/** Keys built from a value, so the catalogue check cannot see them. Both
 *  halves are unions, so TypeScript still refuses one that is not in `en.ts`. */
const kindWord = (kind: EntryKind) => t(`ipam.kind.${kind}`);
const assignmentWord = (a: AssignmentType) => t(`ipam.assignment.${a}`);
const rangeWord = (k: RangeKind) => t(`ipam.range.${k}`);
/** Where it was learned, never what it is held as — "Held as" is its own
 *  column, and printing the kind in both read as a stutter. */
const sourceWord = (a: IpamAddress) => t(`ipam.source.${a.source}`);

interface SubnetForm {
  cidr: string;
  name: string;
  vlan: string;
  note: string;
}
interface AddressForm {
  address: string;
  label: string;
  kind: EntryKind;
  assignment: AssignmentType;
  hostname: string;
  fqdn: string;
  mac: string;
  owner: string;
  purpose: string;
  note: string;
}
/** A device's own address, which belongs to the diagram (LT-295). */
interface DeviceForm {
  label: string;
  address: string;
  interfaceLabel: string;
  mac: string;
  hostname: string;
}
interface RangeForm {
  from: string;
  to: string;
  kind: RangeKind;
  name: string;
  note: string;
}

const blankSubnet: SubnetForm = { cidr: '', name: '', vlan: '', note: '' };
const blankAddress = (address = ''): AddressForm => ({
  address, label: '', kind: 'reserved', assignment: 'static',
  hostname: '', fqdn: '', mac: '', owner: '', purpose: '', note: '',
});

/** What a row has to contain to survive the filter box. */
const matches = (a: IpamAddress, needle: string) => {
  if (!needle.trim()) return true;
  const q = needle.trim().toLowerCase();
  return [a.address, a.label, a.hostname, a.fqdn, a.mac, a.owner, a.purpose, a.interfaceLabel, a.note]
    .some((v) => v?.toLowerCase().includes(q));
};

export function IpamPanel() {
  const doc = useStore((s) => s.doc);
  const store = useStore();
  const model = useMemo(() => buildIpam(allNodes(doc), doc.ipam), [doc]);

  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [subnetForm, setSubnetForm] = useState<SubnetForm>(blankSubnet);
  const [editingSubnet, setEditingSubnet] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [entryForm, setEntryForm] = useState<AddressForm | null>(null);
  const [editingEntry, setEditingEntry] = useState<string | null>(null);
  const [deviceForm, setDeviceForm] = useState<DeviceForm | null>(null);
  const [editingDevice, setEditingDevice] = useState<string | null>(null);
  const [rangeForm, setRangeForm] = useState<RangeForm | null>(null);
  const [rangingIn, setRangingIn] = useState<string | null>(null);
  const [editingRange, setEditingRange] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const known = model.blocks.reduce((n, b) => n + b.used + b.excluded, 0) + model.loose.length;
  const free = model.blocks.reduce((n, b) => n + b.free, 0);

  const toggle = (cidr: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(cidr)) next.add(cidr);
      return next;
    });

  const closeForms = () => {
    setAdding(false);
    setEditingSubnet(null);
    setAddingTo(null);
    setEditingEntry(null);
    setEntryForm(null);
    setEditingDevice(null);
    setDeviceForm(null);
    setRangingIn(null);
    setEditingRange(null);
    setRangeForm(null);
    setProblem(null);
  };

  /** The VLAN field, as a number, or the sentence saying why it is not one. */
  const vlanOf = (raw: string): number | undefined | string => {
    if (!raw.trim()) return undefined;
    const v = Number(raw.trim());
    return Number.isInteger(v) && v >= 1 && v <= 4094 ? v : t('ipam.vlanRange');
  };

  const saveSubnet = (block?: IpamBlock) => {
    const vlan = vlanOf(subnetForm.vlan);
    if (typeof vlan === 'string') {
      setProblem(vlan);
      return;
    }
    const patch = { name: subnetForm.name, vlan, note: subnetForm.note };
    // A declared subnet is edited; a derived one is adopted by declaring it.
    const said = block?.subnetId
      ? store.updateIpamSubnet(block.subnetId, { cidr: subnetForm.cidr, ...patch })
      : store.addIpamSubnet(subnetForm.cidr, patch);
    setProblem(said);
    if (!said) closeForms();
  };

  const saveEntry = (id?: string) => {
    if (!entryForm) return;
    const said = id ? store.updateIpamEntry(id, entryForm) : store.addIpamEntry(entryForm);
    setProblem(said);
    if (!said) closeForms();
  };

  const saveDevice = (a: IpamAddress) => {
    if (!deviceForm || !a.nodeId) return;
    const said = store.editDeviceAddress(a.nodeId, a.addressId, deviceForm);
    setProblem(said);
    if (!said) closeForms();
  };

  const saveRange = (id?: string) => {
    if (!rangeForm) return;
    const said = id ? store.updateIpamRange(id, rangeForm) : store.addIpamRange(rangeForm);
    setProblem(said);
    if (!said) closeForms();
  };

  const editSubnet = (b: IpamBlock) => {
    closeForms();
    setEditingSubnet(b.cidr);
    setSubnetForm({
      cidr: b.cidr,
      name: b.name ?? b.routeInterface ?? '',
      vlan: b.vlan === undefined ? '' : String(b.vlan),
      note: b.note ?? '',
    });
  };

  const addAddress = (b: IpamBlock) => {
    closeForms();
    setAddingTo(b.cidr);
    setEntryForm(blankAddress(b.nextFree ?? ''));
  };

  const addRange = (b: IpamBlock) => {
    closeForms();
    setRangingIn(b.cidr);
    setRangeForm({ from: b.nextFree ?? '', to: '', kind: 'dhcp', name: '', note: '' });
  };

  const editRange = (b: IpamBlock, r: IpamBlock['ranges'][number]) => {
    closeForms();
    setOpen((was) => new Set(was).add(b.cidr));
    setEditingRange(r.id);
    setRangeForm({ from: r.from, to: r.to, kind: r.kind, name: r.name ?? '', note: r.note ?? '' });
  };

  const editAddress = (a: IpamAddress) => {
    closeForms();
    if (a.entryId) {
      setEditingEntry(a.entryId);
      setEntryForm({
        address: a.address, label: a.label, kind: a.kind ?? 'reserved',
        assignment: a.assignment ?? 'static', hostname: a.hostname ?? '', fqdn: a.fqdn ?? '',
        mac: a.mac ?? '', owner: a.owner ?? '', purpose: a.purpose ?? '', note: a.note ?? '',
      });
      return;
    }
    // A device's own address: the same edit the inspector makes (LT-295).
    setEditingDevice(`${a.nodeId}-${a.addressId ?? a.address}`);
    setDeviceForm({
      label: a.label,
      address: a.address,
      interfaceLabel: a.interfaceLabel ?? '',
      mac: a.mac ?? '',
      hostname: a.hostname ?? '',
    });
  };

  const COLUMNS = 8;

  return (
    <div className="cv-ipam">
      <div className="cv-ipam-bar">
        <span className="cv-help">
          {t('ipam.summary', {
            subnets: t('ipam.subnets', { count: model.blocks.length }),
            known: t('ipam.known', { count: known }),
            free,
          })}
        </span>
        <button type="button" className="cv-btn cv-btn-small"
          onClick={() => {
            if (adding) return closeForms();
            closeForms();
            setAdding(true);
            setSubnetForm(blankSubnet);
          }}>
          {adding ? t('ipam.cancel') : t('ipam.addSubnet')}
        </button>
        <input className="cv-input cv-ipam-filter" value={filter} aria-label={t('ipam.filter')}
          placeholder={t('ipam.filterPlaceholder')} onChange={(e) => setFilter(e.target.value)} />
      </div>

      {adding && (
        <SubnetFields form={subnetForm} set={setSubnetForm} onSave={() => saveSubnet()}
          onCancel={closeForms} label={t('ipam.add')} />
      )}

      {problem && <p className="cv-problem">{problem}</p>}

      {model.blocks.length === 0 ? (
        <p className="cv-help cv-ipam-empty">{t('ipam.empty')}</p>
      ) : (
        <div className="cv-ipam-scroll">
          <table className="cv-table cv-ipam-table">
            <thead>
              <tr>
                <th>{t('ipam.colSubnet')}</th>
                <th>{t('ipam.colName')}</th>
                <th>{t('ipam.colVlan')}</th>
                <th>{t('ipam.colUsed')}</th>
                <th>{t('ipam.colFree')}</th>
                <th>{t('ipam.colNextFree')}</th>
                <th>{t('ipam.colKnownFrom')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {model.blocks.map((b) => (
                <SubnetRows
                  key={b.cidr}
                  block={b}
                  columns={COLUMNS}
                  filter={filter}
                  open={open.has(b.cidr)}
                  onToggle={() => toggle(b.cidr)}
                  editing={editingSubnet === b.cidr}
                  addingAddress={addingTo === b.cidr}
                  addingRange={rangingIn === b.cidr}
                  editingEntry={editingEntry}
                  editingDevice={editingDevice}
                  editingRange={editingRange}
                  subnetForm={subnetForm}
                  setSubnetForm={setSubnetForm}
                  entryForm={entryForm}
                  setEntryForm={setEntryForm}
                  deviceForm={deviceForm}
                  setDeviceForm={setDeviceForm}
                  rangeForm={rangeForm}
                  setRangeForm={setRangeForm}
                  onEdit={() => editSubnet(b)}
                  onSaveSubnet={() => saveSubnet(b)}
                  onAddAddress={() => addAddress(b)}
                  onAddRange={() => addRange(b)}
                  onEditRange={(r) => editRange(b, r)}
                  onSaveRange={saveRange}
                  onRemoveRange={(id) => store.removeIpamRange(id)}
                  onSaveEntry={saveEntry}
                  onSaveDevice={saveDevice}
                  onEditAddress={editAddress}
                  onRemoveEntry={(id) => store.removeIpamEntry(id)}
                  onRemove={b.subnetId ? () => store.removeIpamSubnet(b.subnetId!) : undefined}
                  onCancel={closeForms}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {model.skipped.length > 0 && (
        <p className="cv-help">
          {t('ipam.notCounted', { list: model.skipped.map((s) => `${s.label} (${s.address})`).join(', ') })}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  onEnter,
  wide = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  wide?: boolean;
  placeholder?: string;
}) {
  return (
    <label className={`cv-field${wide ? '' : ' cv-field-narrow'}`}>
      <span>{label}</span>
      <input className="cv-input" value={value} autoComplete="off" placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onEnter(); }} />
    </label>
  );
}

function SubnetFields({
  form, set, onSave, onCancel, label, note,
}: {
  form: SubnetForm;
  set: (f: SubnetForm) => void;
  onSave: () => void;
  onCancel: () => void;
  label: string;
  note?: string;
}) {
  return (
    <div className="cv-discover-form cv-ipam-add">
      {note && <p className="cv-help">{note}</p>}
      <Field label={t('ipam.subnetField')} value={form.cidr} onEnter={onSave}
        placeholder="10.20.30.0/24" onChange={(v) => set({ ...form, cidr: v })} />
      <Field label={t('ipam.name')} value={form.name} onEnter={onSave} onChange={(v) => set({ ...form, name: v })} />
      <Field label={t('ipam.colVlan')} value={form.vlan} onEnter={onSave} onChange={(v) => set({ ...form, vlan: v })} />
      <Field label={t('ipam.note')} value={form.note} onEnter={onSave} wide onChange={(v) => set({ ...form, note: v })} />
      <button type="button" className="cv-btn cv-btn-start" onClick={onSave}>{label}</button>
      <button type="button" className="cv-btn cv-btn-small" onClick={onCancel}>{t('ipam.cancel')}</button>
    </div>
  );
}

/** Everything the register knows about one address it owns (LT-297). */
function AddressFields({
  form, set, onSave, onCancel, label,
}: {
  form: AddressForm;
  set: (f: AddressForm) => void;
  onSave: () => void;
  onCancel: () => void;
  label: string;
}) {
  return (
    <div className="cv-discover-form cv-ipam-add">
      <Field label={t('ipam.addressField')} value={form.address} onEnter={onSave}
        onChange={(v) => set({ ...form, address: v })} />
      <Field label={t('ipam.name')} value={form.label} onEnter={onSave} placeholder={t('ipam.whatFor')}
        onChange={(v) => set({ ...form, label: v })} />
      <label className="cv-field cv-field-narrow">
        <span>{t('ipam.heldAs')}</span>
        <select className="cv-input" value={form.kind}
          onChange={(e) => set({ ...form, kind: e.target.value as EntryKind })}>
          {ENTRY_KINDS.map((k) => <option key={k} value={k}>{kindWord(k)}</option>)}
        </select>
      </label>
      <label className="cv-field cv-field-narrow">
        <span>{t('ipam.usedAs')}</span>
        <select className="cv-input" value={form.assignment}
          onChange={(e) => set({ ...form, assignment: e.target.value as AssignmentType })}>
          {ASSIGNMENT_TYPES.map((k) => <option key={k} value={k}>{assignmentWord(k)}</option>)}
        </select>
      </label>
      <Field label={t('ipam.hostname')} value={form.hostname} onEnter={onSave}
        onChange={(v) => set({ ...form, hostname: v })} />
      <Field label={t('ipam.fqdn')} value={form.fqdn} onEnter={onSave} onChange={(v) => set({ ...form, fqdn: v })} />
      <Field label={t('ipam.mac')} value={form.mac} onEnter={onSave} onChange={(v) => set({ ...form, mac: v })} />
      <Field label={t('ipam.owner')} value={form.owner} onEnter={onSave} onChange={(v) => set({ ...form, owner: v })} />
      <Field label={t('ipam.purpose')} value={form.purpose} onEnter={onSave}
        onChange={(v) => set({ ...form, purpose: v })} />
      <Field label={t('ipam.note')} value={form.note} onEnter={onSave} wide onChange={(v) => set({ ...form, note: v })} />
      <button type="button" className="cv-btn cv-btn-start" onClick={onSave}>{label}</button>
      <button type="button" className="cv-btn cv-btn-small" onClick={onCancel}>{t('ipam.cancel')}</button>
      <p className="cv-help cv-ipam-kind-help">{t(`ipam.kindHelp.${form.kind}`)}</p>
    </div>
  );
}

/** A device's own address. Saving writes through to the device (LT-295). */
function DeviceFields({
  form, set, onSave, onCancel, device,
}: {
  form: DeviceForm;
  set: (f: DeviceForm) => void;
  onSave: () => void;
  onCancel: () => void;
  device: string;
}) {
  return (
    <div className="cv-discover-form cv-ipam-add">
      <p className="cv-help">
        {t('ipam.editsDevice', { device })} {t('ipam.crawlWillCorrect')}
      </p>
      <Field label={t('ipam.addressField')} value={form.address} onEnter={onSave}
        onChange={(v) => set({ ...form, address: v })} />
      <Field label={t('ipam.name')} value={form.label} onEnter={onSave} onChange={(v) => set({ ...form, label: v })} />
      <Field label={t('ipam.interface')} value={form.interfaceLabel} onEnter={onSave}
        onChange={(v) => set({ ...form, interfaceLabel: v })} />
      <Field label={t('ipam.mac')} value={form.mac} onEnter={onSave} onChange={(v) => set({ ...form, mac: v })} />
      <Field label={t('ipam.hostname')} value={form.hostname} onEnter={onSave}
        onChange={(v) => set({ ...form, hostname: v })} />
      <button type="button" className="cv-btn cv-btn-start" onClick={onSave}>{t('ipam.save')}</button>
      <button type="button" className="cv-btn cv-btn-small" onClick={onCancel}>{t('ipam.cancel')}</button>
    </div>
  );
}

function RangeFields({
  form, set, onSave, onCancel, label,
}: {
  form: RangeForm;
  set: (f: RangeForm) => void;
  onSave: () => void;
  onCancel: () => void;
  label: string;
}) {
  return (
    <div className="cv-discover-form cv-ipam-add">
      <Field label={t('ipam.rangeFrom')} value={form.from} onEnter={onSave}
        onChange={(v) => set({ ...form, from: v })} />
      <Field label={t('ipam.rangeTo')} value={form.to} onEnter={onSave} onChange={(v) => set({ ...form, to: v })} />
      <label className="cv-field cv-field-narrow">
        <span>{t('ipam.rangeKind')}</span>
        <select className="cv-input" value={form.kind}
          onChange={(e) => set({ ...form, kind: e.target.value as RangeKind })}>
          {RANGE_KINDS.map((k) => <option key={k} value={k}>{rangeWord(k)}</option>)}
        </select>
      </label>
      <Field label={t('ipam.name')} value={form.name} onEnter={onSave} onChange={(v) => set({ ...form, name: v })} />
      <Field label={t('ipam.note')} value={form.note} onEnter={onSave} wide onChange={(v) => set({ ...form, note: v })} />
      <button type="button" className="cv-btn cv-btn-start" onClick={onSave}>{label}</button>
      <button type="button" className="cv-btn cv-btn-small" onClick={onCancel}>{t('ipam.cancel')}</button>
      <p className="cv-help cv-ipam-kind-help">{t(`ipam.rangeHelp.${form.kind}`)}</p>
    </div>
  );
}

function SubnetRows({
  block, columns, filter, open, onToggle, editing, addingAddress, addingRange,
  editingEntry, editingDevice, editingRange,
  subnetForm, setSubnetForm, entryForm, setEntryForm, deviceForm, setDeviceForm, rangeForm, setRangeForm,
  onEdit, onSaveSubnet, onAddAddress, onAddRange, onEditRange, onSaveRange, onRemoveRange,
  onSaveEntry, onSaveDevice, onEditAddress, onRemoveEntry, onRemove, onCancel,
}: {
  block: IpamBlock;
  columns: number;
  filter: string;
  open: boolean;
  onToggle: () => void;
  editing: boolean;
  addingAddress: boolean;
  addingRange: boolean;
  editingEntry: string | null;
  editingDevice: string | null;
  editingRange: string | null;
  subnetForm: SubnetForm;
  setSubnetForm: (f: SubnetForm) => void;
  entryForm: AddressForm | null;
  setEntryForm: (f: AddressForm) => void;
  deviceForm: DeviceForm | null;
  setDeviceForm: (f: DeviceForm) => void;
  rangeForm: RangeForm | null;
  setRangeForm: (f: RangeForm) => void;
  onEdit: () => void;
  onSaveSubnet: () => void;
  onAddAddress: () => void;
  onAddRange: () => void;
  onEditRange: (r: IpamBlock['ranges'][number]) => void;
  onSaveRange: (id?: string) => void;
  onRemoveRange: (id: string) => void;
  onSaveEntry: (id?: string) => void;
  onSaveDevice: (a: IpamAddress) => void;
  onEditAddress: (a: IpamAddress) => void;
  onRemoveEntry: (id: string) => void;
  onRemove?: () => void;
  onCancel: () => void;
}) {
  const used = utilisation(block);
  const declared = Boolean(block.subnetId);
  const shown = block.addresses.filter((a) => matches(a, filter));
  return (
    <>
      <tr className="cv-ipam-subnet">
        <td>
          <button type="button" className="cv-link" aria-expanded={open} onClick={onToggle}>
            {open ? '▾' : '▸'} {block.cidr}
          </button>
        </td>
        <td>{block.name ?? ''}</td>
        <td>{block.vlan ?? ''}</td>
        <td>
          <span className="cv-ipam-meter" title={t('ipam.utilisation', { percent: used, usable: block.usable })}>
            <span className="cv-ipam-meter-fill" style={{ width: `${used}%` }} />
          </span>
          {t('ipam.usedOf', { used: block.used, usable: block.usable })}
          {block.excluded > 0 && (
            <span className="cv-help"> · {t('ipam.excludedNote', { count: block.excluded })}</span>
          )}
          {block.pooled > 0 && <span className="cv-help"> · {t('ipam.pooled', { count: block.pooled })}</span>}
        </td>
        <td>{block.free}</td>
        <td>
          {block.nextFree ?? (
            <span className="cv-help">{block.prefix < 16 ? t('ipam.tooLarge') : t('ipam.noneLeft')}</span>
          )}
        </td>
        <td className="cv-help">
          {declared && block.alsoDerived
            ? t('ipam.alsoDerived', { origin: t(`ipam.origin.${block.alsoDerived}`) })
            : t(`ipam.origin.${block.origin}`)}
        </td>
        <td className="cv-ipam-actions">
          <button type="button" className="cv-btn cv-btn-small" onClick={onEdit}>
            {declared ? t('ipam.edit') : t('ipam.nameIt')}
          </button>
          <button type="button" className="cv-btn cv-btn-small" onClick={onAddAddress}>{t('ipam.addAddress')}</button>
          <button type="button" className="cv-btn cv-btn-small" onClick={onAddRange}>{t('ipam.addRange')}</button>
          {onRemove && (
            <button type="button" className="cv-btn cv-btn-small" onClick={onRemove}>{t('ipam.remove')}</button>
          )}
        </td>
      </tr>

      {editing && (
        <tr className="cv-ipam-form-row">
          <td colSpan={columns}>
            <SubnetFields form={subnetForm} set={setSubnetForm} onSave={onSaveSubnet} onCancel={onCancel}
              label={t('ipam.save')} note={declared ? undefined : t('ipam.adopted')} />
          </td>
        </tr>
      )}

      {addingAddress && entryForm && (
        <tr className="cv-ipam-form-row">
          <td colSpan={columns}>
            <AddressFields form={entryForm} set={setEntryForm} onSave={() => onSaveEntry()}
              onCancel={onCancel} label={t('ipam.add')} />
          </td>
        </tr>
      )}

      {addingRange && rangeForm && (
        <tr className="cv-ipam-form-row">
          <td colSpan={columns}>
            <RangeFields form={rangeForm} set={setRangeForm} onSave={() => onSaveRange()}
              onCancel={onCancel} label={t('ipam.add')} />
          </td>
        </tr>
      )}

      {open && (
        <tr className="cv-ipam-detail">
          <td colSpan={columns}>
            {block.ranges.length > 0 && (
              <table className="cv-table cv-ipam-ranges">
                <thead>
                  <tr>
                    <th>{t('ipam.rangeFrom')}</th>
                    <th>{t('ipam.rangeTo')}</th>
                    <th>{t('ipam.rangeKind')}</th>
                    <th>{t('ipam.colName')}</th>
                    <th>{t('ipam.colNote')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {block.ranges.map((r) =>
                    editingRange === r.id && rangeForm ? (
                      <tr key={r.id} className="cv-ipam-form-row">
                        <td colSpan={6}>
                          <RangeFields form={rangeForm} set={setRangeForm} onSave={() => onSaveRange(r.id)}
                            onCancel={onCancel} label={t('ipam.save')} />
                        </td>
                      </tr>
                    ) : (
                      <tr key={r.id}>
                        <td>{r.from}</td>
                        <td>{r.to}</td>
                        <td>{rangeWord(r.kind)}</td>
                        <td>{r.name ?? ''}</td>
                        <td className="cv-help">{r.note ?? ''}</td>
                        <td className="cv-ipam-actions">
                          <button type="button" className="cv-btn cv-btn-small" onClick={() => onEditRange(r)}>
                            {t('ipam.edit')}
                          </button>
                          <button type="button" className="cv-btn cv-btn-small" onClick={() => onRemoveRange(r.id)}>
                            {t('ipam.remove')}
                          </button>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            )}

            {/* LT-290: the addresses get their own headings. They used to be
                laid out under the subnet's, where an interface label printed
                under "Used" and a MAC under "Free". */}
            <table className="cv-table cv-ipam-addresses">
              <thead>
                <tr>
                  <th>{t('ipam.colAddress')}</th>
                  <th>{t('ipam.colName')}</th>
                  <th>{t('ipam.colHeldAs')}</th>
                  <th>{t('ipam.colUsedAs')}</th>
                  <th>{t('ipam.colHostname')}</th>
                  <th>{t('ipam.colInterface')}</th>
                  <th>{t('ipam.colMac')}</th>
                  <th>{t('ipam.colOwner')}</th>
                  <th>{t('ipam.colPurpose')}</th>
                  <th>{t('ipam.colInRange')}</th>
                  <th>{t('ipam.colKnownFrom')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const deviceKey = `${a.nodeId}-${a.addressId ?? a.address}`;
                  if (a.entryId && editingEntry === a.entryId && entryForm) {
                    return (
                      <tr key={a.entryId} className="cv-ipam-form-row">
                        <td colSpan={12}>
                          <AddressFields form={entryForm} set={setEntryForm}
                            onSave={() => onSaveEntry(a.entryId)} onCancel={onCancel} label={t('ipam.save')} />
                        </td>
                      </tr>
                    );
                  }
                  if (!a.entryId && editingDevice === deviceKey && deviceForm) {
                    return (
                      <tr key={deviceKey} className="cv-ipam-form-row">
                        <td colSpan={12}>
                          <DeviceFields form={deviceForm} set={setDeviceForm} onSave={() => onSaveDevice(a)}
                            onCancel={onCancel} device={a.label} />
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={`${a.address}-${a.entryId ?? deviceKey}`} title={a.note ?? undefined}>
                      <td>{a.address}</td>
                      <td>{a.label}</td>
                      <td>{a.kind ? kindWord(a.kind) : ''}</td>
                      <td>{a.assignment ? assignmentWord(a.assignment) : ''}</td>
                      <td title={a.fqdn ?? undefined}>{a.hostname ?? ''}</td>
                      <td>{a.interfaceLabel ?? ''}</td>
                      <td>{a.mac ?? ''}</td>
                      <td>{a.owner ?? ''}</td>
                      <td>{a.purpose ?? ''}</td>
                      <td className="cv-help">{a.inRange ? (a.inRange.name ?? rangeWord(a.inRange.kind)) : ''}</td>
                      <td className="cv-help">{sourceWord(a)}</td>
                      <td className="cv-ipam-actions">
                        <button type="button" className="cv-btn cv-btn-small" onClick={() => onEditAddress(a)}>
                          {t('ipam.edit')}
                        </button>
                        {a.entryId && (
                          <button type="button" className="cv-btn cv-btn-small" onClick={() => onRemoveEntry(a.entryId!)}>
                            {t('ipam.remove')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={12} className="cv-help">
                      {block.addresses.length === 0 ? t('ipam.nothingOn') : t('ipam.noMatch')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
