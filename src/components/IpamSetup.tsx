/**
 * Sites, tenants and the operator's own fields (LT-298).
 *
 * The lists themselves, kept here rather than typed freely on each record so
 * that "HQ" and "hq " are one place, renaming a site renames it everywhere,
 * and a field defined once is offered on every record it applies to.
 *
 * Removing something in use is allowed, and says first what it will leave
 * behind: a site removed leaves its subnets and addresses with none, and a
 * field removed takes every value in it. Refusing instead would mean hunting
 * down every record by hand before a list could be tidied, which is how lists
 * stop being tidied.
 */
import { useState } from 'react';

import { t } from '../i18n';
import { CUSTOM_FIELD_TYPES, type CustomFieldType, type IpamCustomField } from '../lib/ipam';
import { fieldKey, usageOf } from '../lib/ipamMeta';
import { useStore } from '../state/store';

type PlaceKind = 'site' | 'tenant';

/** One empty list, shared. A selector returning a fresh `[]` each time never
 *  reads as unchanged, and the component renders forever. */
const NO_FIELDS: IpamCustomField[] = [];

export function IpamSetup() {
  return (
    <div className="cv-ipam-setup">
      <Places kind="site" />
      <Places kind="tenant" />
      <Fields />
    </div>
  );
}

function Places({ kind }: { kind: PlaceKind }) {
  const ipam = useStore((s) => s.doc.ipam);
  const save = useStore((s) => s.saveIpamPlace);
  const remove = useStore((s) => s.removeIpamPlace);
  const list = (kind === 'site' ? ipam?.sites : ipam?.tenants) ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const title = kind === 'site' ? t('setup.sites') : t('setup.tenants');
  const help = kind === 'site' ? t('setup.sitesHelp') : t('setup.tenantsHelp');

  const reset = () => {
    setEditing(null);
    setName('');
    setNote('');
    setProblem(null);
  };
  const submit = () => {
    const said = save(kind, editing === 'new' ? null : editing, { name, note });
    setProblem(said);
    if (!said) reset();
  };

  return (
    <section className="cv-ipam-setup-section" aria-label={title}>
      <h3>{title}</h3>
      <p className="cv-help">{help}</p>
      <table className="cv-table">
        <tbody>
          {list.length === 0 && (
            <tr><td className="cv-help">{kind === 'site' ? t('setup.noSites') : t('setup.noTenants')}</td></tr>
          )}
          {list.map((p) => {
            const used = usageOf(ipam, kind, p.id);
            return editing === p.id ? (
              <tr key={p.id}><td colSpan={4}>
                <PlaceForm name={name} note={note} setName={setName} setNote={setNote}
                  onSave={submit} onCancel={reset} label={t('setup.save')} />
              </td></tr>
            ) : (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="cv-help">{p.note ?? ''}</td>
                <td className="cv-help">{used ? t('setup.used', { count: used }) : t('setup.unused')}</td>
                <td className="cv-ipam-actions">
                  <button type="button" className="cv-btn cv-btn-small"
                    onClick={() => { setEditing(p.id); setName(p.name); setNote(p.note ?? ''); setProblem(null); }}>
                    {t('setup.edit')}
                  </button>
                  <button type="button" className="cv-btn cv-btn-small"
                    onClick={() => {
                      if (used && !window.confirm(t('setup.removeUsed', { count: used }))) return;
                      remove(kind, p.id);
                    }}>
                    {t('setup.remove')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editing === 'new' ? (
        <PlaceForm name={name} note={note} setName={setName} setNote={setNote}
          onSave={submit} onCancel={reset} label={t('setup.add')} />
      ) : (
        <button type="button" className="cv-btn cv-btn-small" onClick={() => { reset(); setEditing('new'); }}>
          {kind === 'site' ? t('setup.addSite') : t('setup.addTenant')}
        </button>
      )}
      {problem && <p className="cv-problem">{problem}</p>}
    </section>
  );
}

function PlaceForm({
  name, note, setName, setNote, onSave, onCancel, label,
}: {
  name: string;
  note: string;
  setName: (v: string) => void;
  setNote: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  label: string;
}) {
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') onSave(); };
  return (
    <div className="cv-discover-form cv-ipam-add">
      <label className="cv-field cv-field-narrow">
        <span>{t('setup.name')}</span>
        <input className="cv-input" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={enter} />
      </label>
      <label className="cv-field">
        <span>{t('setup.note')}</span>
        <input className="cv-input" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={enter} />
      </label>
      <button type="button" className="cv-btn cv-btn-start" onClick={onSave}>{label}</button>
      <button type="button" className="cv-btn cv-btn-small" onClick={onCancel}>{t('setup.cancel')}</button>
    </div>
  );
}

interface FieldForm {
  name: string;
  type: CustomFieldType;
  choices: string;
  onSubnets: boolean;
  onAddresses: boolean;
}

const blankField: FieldForm = { name: '', type: 'text', choices: '', onSubnets: false, onAddresses: true };

function Fields() {
  const fields = useStore((s) => s.doc.ipam?.customFields ?? NO_FIELDS);
  const save = useStore((s) => s.saveIpamField);
  const remove = useStore((s) => s.removeIpamField);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FieldForm>(blankField);
  const [problem, setProblem] = useState<string | null>(null);

  const reset = () => {
    setEditing(null);
    setForm(blankField);
    setProblem(null);
  };
  const submit = () => {
    const said = save(editing === 'new' ? null : editing, {
      name: form.name,
      type: form.type,
      choices: form.choices.split(','),
      on: [...(form.onSubnets ? ['subnet' as const] : []), ...(form.onAddresses ? ['address' as const] : [])],
    });
    setProblem(said);
    if (!said) reset();
  };
  const edit = (f: IpamCustomField) => {
    setEditing(f.id);
    setProblem(null);
    setForm({
      name: f.name,
      type: f.type,
      choices: (f.choices ?? []).join(', '),
      onSubnets: f.on.includes('subnet'),
      onAddresses: f.on.includes('address'),
    });
  };

  const formRow = (label: string) => (
    <div className="cv-discover-form cv-ipam-add">
      <label className="cv-field cv-field-narrow">
        <span>{t('setup.name')}</span>
        <input className="cv-input" value={form.name} autoFocus
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      </label>
      <label className="cv-field cv-field-narrow">
        <span>{t('setup.type')}</span>
        <select className="cv-input" value={form.type}
          onChange={(e) => setForm({ ...form, type: e.target.value as CustomFieldType })}>
          {CUSTOM_FIELD_TYPES.map((k) => <option key={k} value={k}>{t(`setup.type.${k}`)}</option>)}
        </select>
      </label>
      {form.type === 'choice' && (
        <label className="cv-field">
          <span>{t('setup.choices')}</span>
          <input className="cv-input" value={form.choices}
            onChange={(e) => setForm({ ...form, choices: e.target.value })} />
        </label>
      )}
      <fieldset className="cv-field cv-field-narrow cv-setup-on">
        <legend>{t('setup.on')}</legend>
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={form.onSubnets}
            onChange={(e) => setForm({ ...form, onSubnets: e.target.checked })} />
          {t('setup.onSubnets')}
        </label>
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={form.onAddresses}
            onChange={(e) => setForm({ ...form, onAddresses: e.target.checked })} />
          {t('setup.onAddresses')}
        </label>
      </fieldset>
      <button type="button" className="cv-btn cv-btn-start" onClick={submit}>{label}</button>
      <button type="button" className="cv-btn cv-btn-small" onClick={reset}>{t('setup.cancel')}</button>
      {fieldKey(form.name) && (
        <span className="cv-help">{t('setup.filterAs', { key: fieldKey(form.name) })}</span>
      )}
    </div>
  );

  return (
    <section className="cv-ipam-setup-section" aria-label={t('setup.fields')}>
      <h3>{t('setup.fields')}</h3>
      <p className="cv-help">{t('setup.fieldsHelp')}</p>
      <table className="cv-table">
        <tbody>
          {fields.length === 0 && <tr><td className="cv-help">{t('setup.noFields')}</td></tr>}
          {fields.map((f) =>
            editing === f.id ? (
              <tr key={f.id}><td colSpan={5}>{formRow(t('setup.save'))}</td></tr>
            ) : (
              <tr key={f.id}>
                <td>{f.name}</td>
                <td className="cv-help">
                  {t(`setup.type.${f.type}`)}
                  {f.type === 'choice' && f.choices?.length ? ` — ${f.choices.join(', ')}` : ''}
                </td>
                <td className="cv-help">
                  {[f.on.includes('subnet') && t('setup.onSubnets'), f.on.includes('address') && t('setup.onAddresses')]
                    .filter(Boolean)
                    .join(', ')}
                </td>
                <td className="cv-help"><code>{fieldKey(f.name)}:</code></td>
                <td className="cv-ipam-actions">
                  <button type="button" className="cv-btn cv-btn-small" onClick={() => edit(f)}>{t('setup.edit')}</button>
                  <button type="button" className="cv-btn cv-btn-small"
                    onClick={() => {
                      if (!window.confirm(t('setup.removeField', { name: f.name }))) return;
                      remove(f.id);
                    }}>
                    {t('setup.remove')}
                  </button>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {editing === 'new' ? (
        formRow(t('setup.add'))
      ) : (
        <button type="button" className="cv-btn cv-btn-small" onClick={() => { reset(); setEditing('new'); }}>
          {t('setup.addField')}
        </button>
      )}
      {problem && <p className="cv-problem">{problem}</p>}
    </section>
  );
}
