/**
 * Sites, tenants, the user's own fields, and which columns show.
 *
 * The register could say *what* an address is. These say *where* it is and
 * *whose* it is — independent questions, because one building holds several
 * tenants and one tenant spans several buildings — and let the user add
 * the fields an estate needs and the specification never listed: a circuit
 * id, a cost centre, a patch panel.
 *
 * Kept apart from the register's arithmetic in `ipam.ts`, because nothing
 * here changes what is free or used; it changes what can be said about it.
 */
import type {
  CustomFieldType,
  IpamCustomField,
  IpamEntry,
  IpamSite,
  IpamState,
  IpamSubnet,
  IpamTenant,
} from './ipam';

/**
 * What a custom field is called after the colon in the filter box:
 * `Circuit ID` is `circuit-id:`. Letters, digits and dashes, because the box
 * splits on spaces and a key has to survive being typed.
 */
export function fieldKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Filter fields the register already understands. A custom field whose key
 * matched one would make one of the two unreachable, and it would always be
 * the operator's that lost, so those names are refused up front.
 */
const BUILT_IN_KEYS = new Set([
  'tag', 'vlan', 'kind', 'source', 'owner', 'purpose', 'hostname', 'fqdn', 'mac',
  'note', 'label', 'address', 'assignment', 'site', 'tenant', 'device',
]);

/** Why a name cannot be used for a site, a tenant or a field, or null. */
export function nameProblem(
  existing: readonly { id: string; name: string }[],
  name: string,
  exceptId?: string,
): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return 'It needs a name.';
  if (existing.some((x) => x.id !== exceptId && x.name.trim().toLowerCase() === wanted)) {
    return `There is already one called ${name.trim()}.`;
  }
  return null;
}

export interface CustomFieldDraft {
  name: string;
  type: CustomFieldType;
  choices?: string[];
  on: IpamCustomField['on'];
}

/** Why a custom field cannot be made as drafted, or null. */
export function customFieldProblem(
  existing: readonly IpamCustomField[],
  draft: CustomFieldDraft,
  exceptId?: string,
): string | null {
  const named = nameProblem(existing, draft.name, exceptId);
  if (named) return named;
  const key = fieldKey(draft.name);
  if (!key) return 'The name needs at least one letter or digit, so it can be typed in the filter box.';
  if (BUILT_IN_KEYS.has(key)) {
    return `"${key}:" already means something in the filter box; choose another name.`;
  }
  if (existing.some((f) => f.id !== exceptId && fieldKey(f.name) === key)) {
    return `That would be typed as "${key}:", which another field already is.`;
  }
  if (draft.on.length === 0) return 'Choose whether it goes on subnets or addresses, or both.';
  if (draft.type === 'choice' && !(draft.choices ?? []).some((c) => c.trim())) {
    return 'A choice field needs at least one choice.';
  }
  return null;
}

/**
 * Why a value cannot go in a field, or null. An empty value is always fine —
 * it clears the field — because refusing to let someone empty a box is the
 * sort of rule that makes a form unusable.
 */
export function customValueProblem(field: IpamCustomField, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  switch (field.type) {
    case 'number':
      return Number.isFinite(Number(value)) ? null : `${field.name} is a number.`;
    case 'choice': {
      const choices = (field.choices ?? []).map((c) => c.trim()).filter(Boolean);
      return choices.includes(value) ? null : `${field.name} is one of: ${choices.join(', ')}.`;
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!m) return `${field.name} is a date, written YYYY-MM-DD.`;
      // Round-tripping catches 2026-02-30, which the pattern alone lets by.
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      return d.toISOString().slice(0, 10) === value ? null : `${value} is not a real date.`;
    }
    default:
      return null;
  }
}

/**
 * The values worth storing on a record: only fields that apply to it, trimmed,
 * none empty — and no object at all when nothing is left, so an emptied record
 * reads the same as one never given any.
 */
export function cleanCustom(
  fields: readonly IpamCustomField[],
  on: 'subnet' | 'address',
  values: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (!f.on.includes(on)) continue;
    const v = values?.[f.id]?.trim();
    if (v) out[f.id] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

type Referenced = 'site' | 'tenant';
const idKey = (kind: Referenced) => (kind === 'site' ? 'siteId' : 'tenantId') as 'siteId' | 'tenantId';

/** How many subnets and addresses name this site or tenant. */
export function usageOf(state: IpamState | undefined, kind: Referenced, id: string): number {
  const key = idKey(kind);
  const on = (xs: readonly (IpamSubnet | IpamEntry)[] | undefined) => (xs ?? []).filter((x) => x[key] === id).length;
  return on(state?.subnets) + on(state?.entries);
}

const dropKey = <T extends object>(x: T, key: keyof T): T => {
  const copy = { ...x };
  delete copy[key];
  return copy;
};

/**
 * The register with a site or tenant removed, and nothing left pointing at
 * it. A dangling id would read as "no site" on some screens and as an unknown
 * id on others; clearing it is the one answer that is the same everywhere.
 */
export function withoutReference(state: IpamState, kind: Referenced, id: string): IpamState {
  const key = idKey(kind);
  const clear = <T extends IpamSubnet | IpamEntry>(x: T): T => (x[key] === id ? dropKey(x, key) : x);
  const list = kind === 'site' ? 'sites' : 'tenants';
  return {
    ...state,
    [list]: ((state[list] ?? []) as (IpamSite | IpamTenant)[]).filter((x) => x.id !== id),
    subnets: state.subnets?.map(clear),
    entries: state.entries?.map(clear),
  };
}

/** The register with a custom field and every value in it removed. */
export function withoutField(state: IpamState, fieldId: string): IpamState {
  const strip = <T extends IpamSubnet | IpamEntry>(x: T): T => {
    if (!x.custom || !(fieldId in x.custom)) return x;
    const rest = { ...x.custom };
    delete rest[fieldId];
    return Object.keys(rest).length ? { ...x, custom: rest } : dropKey(x, 'custom');
  };
  return {
    ...state,
    customFields: (state.customFields ?? []).filter((f) => f.id !== fieldId),
    subnets: state.subnets?.map(strip),
    entries: state.entries?.map(strip),
  };
}

/**
 * A record as the history should describe it: a site by its name rather than
 * an id nobody can read, the device by what it is called on the diagram, and
 * each custom field under its own name rather than as one blob of values.
 */
export function auditView(
  record: Readonly<Record<string, unknown>>,
  state: IpamState | undefined,
  deviceLabel: (nodeId: string) => string | undefined = () => undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === 'siteId') out.site = state?.sites?.find((s) => s.id === v)?.name ?? v;
    else if (k === 'tenantId') out.tenant = state?.tenants?.find((s) => s.id === v)?.name ?? v;
    else if (k === 'deviceId') out.device = (typeof v === 'string' && deviceLabel(v)) || v;
    else if (k === 'custom' && v && typeof v === 'object') {
      for (const [fid, value] of Object.entries(v as Record<string, string>)) {
        out[state?.customFields?.find((f) => f.id === fid)?.name ?? fid] = value;
      }
    } else out[k] = v;
  }
  return out;
}

/** Columns of the address table that may be hidden. The address itself may
 *  not: a row without it is a row about nothing. */
export const ADDRESS_COLUMNS = [
  'name', 'heldAs', 'usedAs', 'hostname', 'interface', 'device', 'mac', 'owner',
  'purpose', 'site', 'tenant', 'tags', 'inRange', 'knownFrom',
] as const;

export type BuiltInColumn = (typeof ADDRESS_COLUMNS)[number];
export type AddressColumn = BuiltInColumn | `custom:${string}`;

/**
 * The address table's columns, in order, minus the hidden ones.
 *
 * What is stored is what someone *hid*, not what they chose to show, so a
 * custom field added next week appears without anybody having to find it —
 * a new column that stays invisible until you go looking is one you never
 * learn exists.
 */
export function visibleColumns(
  hidden: readonly string[],
  fields: readonly IpamCustomField[],
): AddressColumn[] {
  const all: AddressColumn[] = [
    ...ADDRESS_COLUMNS,
    ...fields.filter((f) => f.on.includes('address')).map((f) => `custom:${f.id}` as const),
  ];
  const off = new Set(hidden);
  return all.filter((c) => !off.has(c));
}

type Carried = Pick<IpamSubnet, 'siteId' | 'tenantId' | 'custom'>;

/**
 * What a subnet hands to the children it is split into. Splitting a subnet
 * does not move it to another building or another owner, so a split that
 * dropped these would be quietly losing a decision somebody made.
 */
export function carriedBy(parent: IpamSubnet | undefined): Carried {
  return {
    ...(parent?.siteId ? { siteId: parent.siteId } : {}),
    ...(parent?.tenantId ? { tenantId: parent.tenantId } : {}),
    ...(parent?.custom && Object.keys(parent.custom).length ? { custom: { ...parent.custom } } : {}),
  };
}

/**
 * What subnets being merged all agree on — and nothing they do not.
 * Two halves in different tenants is a disagreement for a person to settle;
 * picking one would record, in the register's own voice, something nobody
 * decided.
 */
export function agreedBy(parts: readonly IpamSubnet[]): Carried {
  if (parts.length === 0) return {};
  const [first, ...rest] = parts;
  const same = <K extends 'siteId' | 'tenantId'>(k: K) =>
    first![k] && rest.every((p) => p[k] === first![k]) ? { [k]: first![k] } : {};
  const custom: Record<string, string> = {};
  for (const [id, value] of Object.entries(first!.custom ?? {})) {
    if (rest.every((p) => p.custom?.[id] === value)) custom[id] = value;
  }
  return {
    ...same('siteId'),
    ...same('tenantId'),
    ...(Object.keys(custom).length ? { custom } : {}),
  };
}
