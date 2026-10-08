/**
 * The address register, which the admin edits,
 * with ranges, a fuller record per address, and the
 * device's own addresses editable from here.
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
 * Nothing ships in it. There are no example subnets and no default plan:
 * an empty register says what it is for and waits.
 */
import { createContext, useContext, useMemo, useState } from 'react';

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
  type IpamCustomField,
  type IpamState,
  type RangeKind,
  entriesOf,
} from '../lib/ipam';
import { cleanCustom, customValueProblem, visibleColumns, type AddressColumn } from '../lib/ipamMeta';
import { allNodes } from '../lib/pages';
import type { BulkAction } from '../lib/ipamBulk';
import { describeBulk, planBulk } from '../lib/ipamBulk';
import { matchesFilter, parseFilter } from '../lib/ipamFilter';
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
  /** Empty means none. */
  siteId: string;
  tenantId: string;
  custom: Record<string, string>;
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
  /** Free labels, comma separated as typed. */
  tags: string;
  /** An empty site or tenant means "as the subnet". */
  siteId: string;
  tenantId: string;
  deviceId: string;
  deviceInterface: string;
  custom: Record<string, string>;
}
/** A device's own address, which belongs to the diagram. */
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

const blankSubnet: SubnetForm = { cidr: '', name: '', vlan: '', note: '', siteId: '', tenantId: '', custom: {} };
const blankAddress = (address = ''): AddressForm => ({
  address, label: '', kind: 'reserved', assignment: 'static',
  hostname: '', fqdn: '', mac: '', owner: '', purpose: '', note: '', tags: '',
  siteId: '', tenantId: '', deviceId: '', deviceInterface: '', custom: {},
});

/**
 * What every form and row in the register needs to know and none of
 * them owns — the sites, tenants and fields, the devices an address can be
 * linked to, and which columns this machine shows. A context rather than
 * another eight props threaded through `SubnetRows`, which has enough.
 */
interface RegisterMeta {
  ipam: IpamState | undefined;
  fields: IpamCustomField[];
  devices: { id: string; label: string }[];
  columns: AddressColumn[];
}
const Meta = createContext<RegisterMeta>({ ipam: undefined, fields: [], devices: [], columns: [] });

/** The first custom value that will not do, as a sentence, or null. */
function customProblem(fields: readonly IpamCustomField[], on: 'subnet' | 'address', values: Record<string, string>) {
  for (const f of fields) {
    if (!f.on.includes(on)) continue;
    const problem = customValueProblem(f, values[f.id] ?? '');
    if (problem) return problem;
  }
  return null;
}

/**
 * What a row has to contain to survive the filter box.
 *
 * A bare word still searches everything a person might remember, as it
 * always did. On top of that the box now understands `tag:pci`, `vlan:14`,
 * `source:crawled` and the rest, and a leading `-` excludes — which is what
 * makes a register of two hundred addresses answerable rather than scrollable.
 */
const matches = (a: IpamAddress, needle: string, fields: readonly IpamCustomField[] = []) =>
  matchesFilter(a, parseFilter(needle, fields));

export function IpamPanel() {
  const doc = useStore((s) => s.doc);
  const model = useMemo(() => buildIpam(allNodes(doc), doc.ipam), [doc]);
  const hidden = useStore((s) => s.settings.registerHiddenColumns);
  const fields = useMemo(() => doc.ipam?.customFields ?? [], [doc.ipam?.customFields]);
  const meta = useMemo((): RegisterMeta => ({
    ipam: doc.ipam,
    fields,
    devices: allNodes(doc)
      .filter((n) => n.type === 'device')
      .map((n) => ({ id: n.id, label: String((n.data as { label?: string })?.label ?? '').trim() || n.id }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    columns: visibleColumns(hidden, fields),
  }), [doc, fields, hidden]);

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
  // One decision applied to everything the filter found. The bar only
  // appears once a filter is narrowing the list, because "do this to all of
  // them" is only a sensible offer when "them" is a chosen set.
  const [bulkKind, setBulkKind] = useState<BulkAction['kind']>('add-tags');
  const [bulkValue, setBulkValue] = useState('');
  const matching = useMemo(
    () => model.blocks.flatMap((b) => b.addresses.filter((a) => matches(a, filter, fields))),
    [model.blocks, filter, fields],
  );
  const bulkAction = useMemo((): BulkAction => {
    const tags = bulkValue.split(',');
    switch (bulkKind) {
      case 'add-tags': return { kind: 'add-tags', tags };
      case 'remove-tags': return { kind: 'remove-tags', tags };
      case 'set-kind': return { kind: 'set-kind', value: (ENTRY_KINDS.includes(bulkValue as EntryKind) ? bulkValue : 'in-use') as EntryKind };
      case 'set-purpose': return { kind: 'set-purpose', value: bulkValue };
      default: return { kind: 'set-owner', value: bulkValue };
    }
  }, [bulkKind, bulkValue]);
  const bulkPlan = useMemo(() => planBulk(matching, bulkAction), [matching, bulkAction]);
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
    // A field that will not take its value says so before anything
    // is written, rather than storing it and failing a filter later.
    const bad = customProblem(fields, 'subnet', subnetForm.custom);
    if (bad) {
      setProblem(bad);
      return;
    }
    const patch = {
      name: subnetForm.name, vlan, note: subnetForm.note,
      siteId: subnetForm.siteId || undefined,
      tenantId: subnetForm.tenantId || undefined,
      custom: cleanCustom(fields, 'subnet', subnetForm.custom),
    };
    // A declared subnet is edited; a derived one is adopted by declaring it.
    const said = block?.subnetId
      ? useStore.getState().updateIpamSubnet(block.subnetId, { cidr: subnetForm.cidr, ...patch })
      : useStore.getState().addIpamSubnet(subnetForm.cidr, patch);
    setProblem(said);
    if (!said) closeForms();
  };

  const saveEntry = (id?: string) => {
    if (!entryForm) return;
    // Tags are typed as text and stored as a list, lower-cased and
    // deduplicated — a register where `PCI` and `pci` are two tags is one
    // nobody trusts. Clearing the box removes them rather than storing [''].
    const { tags: typed, siteId, tenantId, deviceId, deviceInterface, custom, ...rest } = entryForm;
    const tags = [...new Set(typed.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
    const bad = customProblem(fields, 'address', custom);
    if (bad) {
      setProblem(bad);
      return;
    }
    const patch = {
      ...rest,
      ...(tags.length ? { tags } : { tags: undefined }),
      // Empty means "as the subnet" for where and whose, and "not on
      // a device" for the link — stored as nothing rather than as "".
      siteId: siteId || undefined,
      tenantId: tenantId || undefined,
      deviceId: deviceId || undefined,
      deviceInterface: deviceId ? deviceInterface || undefined : undefined,
      custom: cleanCustom(fields, 'address', custom),
    };
    const said = id ? useStore.getState().updateIpamEntry(id, patch) : useStore.getState().addIpamEntry(patch);
    setProblem(said);
    if (!said) closeForms();
  };

  const saveDevice = (a: IpamAddress) => {
    if (!deviceForm || !a.nodeId) return;
    const said = useStore.getState().editDeviceAddress(a.nodeId, a.addressId, deviceForm);
    setProblem(said);
    if (!said) closeForms();
  };

  const saveRange = (id?: string) => {
    if (!rangeForm) return;
    const said = id ? useStore.getState().updateIpamRange(id, rangeForm) : useStore.getState().addIpamRange(rangeForm);
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
      siteId: b.siteId ?? '',
      tenantId: b.tenantId ?? '',
      custom: { ...b.custom },
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
      // The entry's own answers, not the row's: a site the row inherited
      // from its subnet is not one the address holds, and saving the form
      // must not quietly make it one.
      const own = entriesOf(doc.ipam).find((e) => e.id === a.entryId);
      setEditingEntry(a.entryId);
      setEntryForm({
        siteId: own?.siteId ?? '',
        tenantId: own?.tenantId ?? '',
        deviceId: own?.deviceId ?? '',
        deviceInterface: own?.deviceInterface ?? '',
        custom: { ...own?.custom },
        address: a.address, label: a.label, kind: a.kind ?? 'reserved',
        assignment: a.assignment ?? 'static', hostname: a.hostname ?? '', fqdn: a.fqdn ?? '',
        mac: a.mac ?? '', owner: a.owner ?? '', purpose: a.purpose ?? '', note: a.note ?? '',
        tags: (a.tags ?? []).join(', '),
      });
      return;
    }
    // A device's own address: the same edit the inspector makes.
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
    <Meta.Provider value={meta}>
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
        <ColumnChooser />
        {/* A filter worth keeping. A view holds only the query, so it
            cannot go stale — reopening it asks the register again. */}
        <select className="cv-input cv-ipam-views" aria-label={t('ipam.views')}
          value=""
          onChange={(e) => {
            const v = (doc.ipam?.views ?? []).find((x) => x.id === e.target.value);
            if (v) setFilter(v.query);
          }}>
          <option value="">{t('ipam.views')}</option>
          {(doc.ipam?.views ?? []).map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
        {filter.trim() !== '' && (
          <button type="button" className="cv-btn cv-btn-small"
            onClick={() => {
              const name = window.prompt(t('ipam.viewName'), filter.trim().slice(0, 40));
              if (name === null) return;
              setProblem(useStore.getState().saveIpamView(name, filter));
            }}>
            {t('ipam.saveView')}
          </button>
        )}
        {(doc.ipam?.views ?? []).some((v) => v.query === filter.trim()) && (
          <button type="button" className="cv-btn cv-btn-small"
            onClick={() => {
              const v = (doc.ipam?.views ?? []).find((x) => x.query === filter.trim());
              if (v) useStore.getState().removeIpamView(v.id);
            }}>
            {t('ipam.forgetView')}
          </button>
        )}
        {filter.trim() !== '' && (
          <span className="cv-ipam-bulk">
            <select className="cv-input" aria-label={t('ipam.bulkAction')} value={bulkKind}
              onChange={(e) => setBulkKind(e.target.value as BulkAction['kind'])}>
              <option value="add-tags">{t('ipam.bulkAddTags')}</option>
              <option value="remove-tags">{t('ipam.bulkRemoveTags')}</option>
              <option value="set-owner">{t('ipam.bulkOwner')}</option>
              <option value="set-purpose">{t('ipam.bulkPurpose')}</option>
              <option value="set-kind">{t('ipam.bulkKind')}</option>
            </select>
            <input className="cv-input cv-ipam-bulk-value" value={bulkValue}
              aria-label={t('ipam.bulkValue')} placeholder={t('ipam.bulkValue')}
              onChange={(e) => setBulkValue(e.target.value)} />
            <button type="button" className="cv-btn cv-btn-small"
              disabled={bulkPlan.changes.length === 0}
              onClick={() => {
                const n = useStore.getState().applyIpamBulk(bulkPlan.changes, t(`ipam.bulkWhat.${bulkKind}` as 'ipam.bulkWhat.add-tags'));
                setBulkValue('');
                setProblem(n ? null : null);
              }}>
              {t('ipam.bulkApply', { count: bulkPlan.changes.length })}
            </button>
            <span className="cv-help">{describeBulk(bulkPlan)}</span>
          </span>
        )}
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
                  onRemoveRange={(id) => useStore.getState().removeIpamRange(id)}
                  onSaveEntry={saveEntry}
                  onSaveDevice={saveDevice}
                  onEditAddress={editAddress}
                  onRemoveEntry={(id) => useStore.getState().removeIpamEntry(id)}
                  onRemove={b.subnetId ? () => useStore.getState().removeIpamSubnet(b.subnetId!) : undefined}
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
    </Meta.Provider>
  );
}

/**
 * Which columns the address table shows.
 *
 * What is remembered is what was *hidden*, on this machine only — two people
 * reading one register may want different columns, and a field added next
 * week appears without anybody having to find it.
 */
function ColumnChooser() {
  const { fields } = useContext(Meta);
  const hidden = useStore((s) => s.settings.registerHiddenColumns);
  const setSettings = useStore((s) => s.setSettings);
  const every = visibleColumns([], fields);
  return (
    <details className="cv-ipam-columns">
      <summary>{t('ipam.columns')}</summary>
      <div className="cv-ipam-columns-list">
        {every.map((c) => (
          <label key={c} className="cv-check">
            <input type="checkbox" checked={!hidden.includes(c)}
              onChange={(e) => setSettings({
                registerHiddenColumns: e.target.checked ? hidden.filter((x) => x !== c) : [...hidden, c],
              })} />
            {columnLabel(c, fields)}
          </label>
        ))}
        <p className="cv-help">{t('ipam.columnsHelp')}</p>
      </div>
    </details>
  );
}

function columnLabel(c: AddressColumn, fields: readonly IpamCustomField[]): string {
  if (c.startsWith('custom:')) return fields.find((f) => `custom:${f.id}` === c)?.name ?? c;
  switch (c) {
    case 'name': return t('ipam.colName');
    case 'heldAs': return t('ipam.colHeldAs');
    case 'usedAs': return t('ipam.colUsedAs');
    case 'hostname': return t('ipam.colHostname');
    case 'interface': return t('ipam.colInterface');
    case 'device': return t('ipam.colDevice');
    case 'mac': return t('ipam.colMac');
    case 'owner': return t('ipam.colOwner');
    case 'purpose': return t('ipam.colPurpose');
    case 'site': return t('ipam.colSite');
    case 'tenant': return t('ipam.colTenant');
    case 'tags': return t('ipam.colTags');
    case 'inRange': return t('ipam.colInRange');
    default: return t('ipam.colKnownFrom');
  }
}

/** Where an inherited answer came from, said quietly after the answer. */
function inherited(from: 'own' | 'device' | 'subnet') {
  if (from === 'own') return null;
  return <span className="cv-help"> ({from === 'subnet' ? t('ipam.fromSubnetHint') : t('ipam.fromDeviceHint')})</span>;
}

function cellFor(c: AddressColumn, a: IpamAddress) {
  if (c.startsWith('custom:')) return a.custom?.[c.slice('custom:'.length)] ?? '';
  switch (c) {
    case 'name': return a.label;
    case 'heldAs': return a.kind ? kindWord(a.kind) : '';
    case 'usedAs': return a.assignment ? assignmentWord(a.assignment) : '';
    case 'hostname': return a.hostname ?? '';
    case 'interface': return a.interfaceLabel ?? a.deviceInterface ?? '';
    case 'device':
      return a.deviceMissing ? <span className="cv-help">{t('ipam.deviceRemoved')}</span> : (a.deviceLabel ?? '');
    case 'mac': return a.mac ?? '';
    case 'owner': return a.owner ?? '';
    case 'purpose': return a.purpose ?? '';
    case 'site': return a.site ? <>{a.site.name}{inherited(a.site.from)}</> : '';
    case 'tenant': return a.tenant ? <>{a.tenant.name}{inherited(a.tenant.from)}</> : '';
    case 'tags': return (a.tags ?? []).join(', ');
    case 'inRange':
      return <span className="cv-help">{a.inRange ? (a.inRange.name ?? rangeWord(a.inRange.kind)) : ''}</span>;
    default: return <span className="cv-help">{sourceWord(a)}</span>;
  }
}

/** Site and tenant selects. `inherit` offers "as the subnet" in place of none. */
function WhereWhose({
  siteId, tenantId, onChange, inherit,
}: {
  siteId: string;
  tenantId: string;
  onChange: (patch: { siteId?: string; tenantId?: string }) => void;
  inherit: boolean;
}) {
  const { ipam } = useContext(Meta);
  const empty = inherit ? t('ipam.fromSubnet') : t('ipam.none');
  return (
    <>
      <label className="cv-field cv-field-narrow">
        <span>{t('ipam.site')}</span>
        <select className="cv-input" value={siteId} onChange={(e) => onChange({ siteId: e.target.value })}>
          <option value="">{empty}</option>
          {(ipam?.sites ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <label className="cv-field cv-field-narrow">
        <span>{t('ipam.tenant')}</span>
        <select className="cv-input" value={tenantId} onChange={(e) => onChange({ tenantId: e.target.value })}>
          <option value="">{empty}</option>
          {(ipam?.tenants ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
    </>
  );
}

/** One input per field of the operator's that applies to this kind of record. */
function CustomInputs({
  on, values, onChange,
}: {
  on: 'subnet' | 'address';
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  const { fields } = useContext(Meta);
  return (
    <>
      {fields.filter((f) => f.on.includes(on)).map((f) => (
        <label key={f.id} className="cv-field cv-field-narrow">
          <span>{f.name}</span>
          {f.type === 'choice' ? (
            <select className="cv-input" value={values[f.id] ?? ''}
              onChange={(e) => onChange({ ...values, [f.id]: e.target.value })}>
              <option value="" />
              {(f.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input className="cv-input" value={values[f.id] ?? ''} autoComplete="off"
              type={f.type === 'date' ? 'date' : 'text'}
              inputMode={f.type === 'number' ? 'decimal' : undefined}
              onChange={(e) => onChange({ ...values, [f.id]: e.target.value })} />
          )}
        </label>
      ))}
    </>
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
      <WhereWhose siteId={form.siteId} tenantId={form.tenantId} inherit={false}
        onChange={(patch) => set({ ...form, ...patch })} />
      <CustomInputs on="subnet" values={form.custom} onChange={(custom) => set({ ...form, custom })} />
      <Field label={t('ipam.note')} value={form.note} onEnter={onSave} wide onChange={(v) => set({ ...form, note: v })} />
      <button type="button" className="cv-btn cv-btn-start" onClick={onSave}>{label}</button>
      <button type="button" className="cv-btn cv-btn-small" onClick={onCancel}>{t('ipam.cancel')}</button>
    </div>
  );
}

/** Everything the register knows about one address it owns. */
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
      <Field label={t('ipam.tags')} value={form.tags} onEnter={onSave} onChange={(v) => set({ ...form, tags: v })} />
      <Field label={t('ipam.purpose')} value={form.purpose} onEnter={onSave}
        onChange={(v) => set({ ...form, purpose: v })} />
      <WhereWhose siteId={form.siteId} tenantId={form.tenantId} inherit
        onChange={(patch) => set({ ...form, ...patch })} />
      <DevicePicker deviceId={form.deviceId} deviceInterface={form.deviceInterface}
        onChange={(patch) => set({ ...form, ...patch })} />
      <CustomInputs on="address" values={form.custom} onChange={(custom) => set({ ...form, custom })} />
      <Field label={t('ipam.note')} value={form.note} onEnter={onSave} wide onChange={(v) => set({ ...form, note: v })} />
      <button type="button" className="cv-btn cv-btn-start" onClick={onSave}>{label}</button>
      <button type="button" className="cv-btn cv-btn-small" onClick={onCancel}>{t('ipam.cancel')}</button>
      <p className="cv-help cv-ipam-kind-help">{t(`ipam.kindHelp.${form.kind}`)}</p>
    </div>
  );
}

/** A device's own address. Saving writes through to the device. */
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
  // The columns this machine shows, and the address and actions
  // either side of them.
  const { columns: addressColumns, fields } = useContext(Meta);
  const span = addressColumns.length + 2;
  const shown = block.addresses.filter((a) => matches(a, filter, fields));
  return (
    <>
      <tr className="cv-ipam-subnet">
        <td>
          <button type="button" className="cv-link" aria-expanded={open} onClick={onToggle}>
            {open ? '▾' : '▸'} {block.cidr}
          </button>
        </td>
        <td>
          {block.name ?? ''}
          <WhereWhoseNote siteId={block.siteId} tenantId={block.tenantId} />
        </td>
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

            {/* The addresses get their own headings. They used to be
                laid out under the subnet's, where an interface label printed
                under "Used" and a MAC under "Free". */}
            <table className="cv-table cv-ipam-addresses">
              <thead>
                <tr>
                  <th>{t('ipam.colAddress')}</th>
                  {addressColumns.map((c) => <th key={c}>{columnLabel(c, fields)}</th>)}
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const deviceKey = `${a.nodeId}-${a.addressId ?? a.address}`;
                  if (a.entryId && editingEntry === a.entryId && entryForm) {
                    return (
                      <tr key={a.entryId} className="cv-ipam-form-row">
                        <td colSpan={span}>
                          <AddressFields form={entryForm} set={setEntryForm}
                            onSave={() => onSaveEntry(a.entryId)} onCancel={onCancel} label={t('ipam.save')} />
                        </td>
                      </tr>
                    );
                  }
                  if (!a.entryId && editingDevice === deviceKey && deviceForm) {
                    return (
                      <tr key={deviceKey} className="cv-ipam-form-row">
                        <td colSpan={span}>
                          <DeviceFields form={deviceForm} set={setDeviceForm} onSave={() => onSaveDevice(a)}
                            onCancel={onCancel} device={a.label} />
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={`${a.address}-${a.entryId ?? deviceKey}`} title={a.note ?? undefined}>
                      <td>{a.address}</td>
                      {addressColumns.map((c) => <td key={c}>{cellFor(c, a)}</td>)}
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
                    <td colSpan={span} className="cv-help">
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

/** The device an address is on, and which of its interfaces. */
function DevicePicker({
  deviceId, deviceInterface, onChange,
}: {
  deviceId: string;
  deviceInterface: string;
  onChange: (patch: { deviceId?: string; deviceInterface?: string }) => void;
}) {
  const { devices } = useContext(Meta);
  // A link to a device since deleted stays selectable, so opening the form
  // does not quietly break it — it says what it is instead.
  const missing = deviceId && !devices.some((d) => d.id === deviceId);
  return (
    <>
      <label className="cv-field cv-field-narrow">
        <span>{t('ipam.device')}</span>
        <select className="cv-input" value={deviceId} onChange={(e) => onChange({ deviceId: e.target.value })}>
          <option value="">{t('ipam.notOnDevice')}</option>
          {missing && <option value={deviceId}>{t('ipam.deviceRemoved')}</option>}
          {devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      </label>
      {deviceId && (
        <label className="cv-field cv-field-narrow">
          <span>{t('ipam.deviceInterface')}</span>
          <input className="cv-input" value={deviceInterface} autoComplete="off"
            onChange={(e) => onChange({ deviceInterface: e.target.value })} />
        </label>
      )}
    </>
  );
}

/** A subnet's site and tenant, quietly, under its name. */
function WhereWhoseNote({ siteId, tenantId }: { siteId?: string; tenantId?: string }) {
  const { ipam } = useContext(Meta);
  const site = siteId ? ipam?.sites?.find((x) => x.id === siteId)?.name : undefined;
  const tenant = tenantId ? ipam?.tenants?.find((x) => x.id === tenantId)?.name : undefined;
  if (!site && !tenant) return null;
  return (
    <span className="cv-help cv-ipam-where">
      {' '}{site && tenant ? t('ipam.whereWhose', { site, tenant }) : site ?? tenant}
    </span>
  );
}
