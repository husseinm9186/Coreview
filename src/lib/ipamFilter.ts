/**
 * Finding things in a register that has grown.
 *
 * A register with two hundred addresses is a list nobody reads. Filtering is
 * what turns it back into an answer — and it is also the thing saved views and
 * bulk actions are built on, so it is worth getting the grammar right once.
 *
 * **The grammar is what people already type.** Bare words match the obvious
 * fields; `field:value` narrows to one; a leading `-` excludes. Every term must
 * match, because that is what a person means by typing two of them.
 *
 *     core                 anything mentioning "core"
 *     tag:pci              tagged pci
 *     vlan:14 kind:reserved   both, not either
 *     -tag:decommissioned  everything except those
 *     source:crawled       what a crawl found rather than what was typed
 *
 * **An unknown field is a word, not an error.** Someone typing `printer:2f`
 * means to search for that text, and refusing the whole query because
 * `printer` is not a field would be the least useful possible response.
 */
import type { IpamAddress, IpamCustomField } from './ipam';
import { fieldKey } from './ipamMeta';

export interface FilterTerm {
  /** The field named before the colon, lower-cased; null for a bare word. */
  field: string | null;
  value: string;
  negated: boolean;
}

/** Fields a `name:value` term may narrow to. Anything else is treated as text. */
const FIELDS = new Set([
  'tag', 'vlan', 'kind', 'source', 'owner', 'purpose', 'hostname', 'fqdn',
  'mac', 'note', 'label', 'address', 'assignment',
  'site', 'tenant', 'device',
]);

/** Fields matched whole rather than by substring. `site:hq` must not also
 *  match "HQ Annex", or `-site:hq` would quietly hide it. */
const EXACT = new Set(['tag', 'vlan', 'kind', 'source', 'assignment', 'site', 'tenant']);

/**
 * Splits a query into terms, honouring quotes so a value may contain a space.
 *
 * Given the register's custom fields, each is a field too, under the
 * name it would be typed as — `Circuit ID` is `circuit-id:`. The term records
 * the field's id rather than its name, so renaming a field does not change
 * what a saved view means halfway through.
 */
export function parseFilter(query: string, customFields: readonly IpamCustomField[] = []): FilterTerm[] {
  const custom = new Map(customFields.map((f) => [fieldKey(f.name), f]));
  const terms: FilterTerm[] = [];
  const words = query.match(/-?(?:[a-zA-Z][\w-]*:)?"[^"]*"|\S+/g) ?? [];
  for (const raw of words) {
    let word = raw;
    const negated = word.startsWith('-') && word.length > 1;
    if (negated) word = word.slice(1);
    const colon = word.indexOf(':');
    let field: string | null = null;
    let value = word;
    if (colon > 0) {
      const name = word.slice(0, colon).toLowerCase();
      const own = custom.get(name);
      if (FIELDS.has(name)) {
        field = name;
        value = word.slice(colon + 1);
      } else if (own) {
        // A choice, number or date is matched whole; free text by substring.
        field = `${own.type === 'text' ? 'custom~' : 'custom='}${own.id}`;
        value = word.slice(colon + 1);
      }
    }
    value = value.replace(/^"|"$/g, '').trim().toLowerCase();
    if (value === '') continue;
    terms.push({ field, value, negated });
  }
  return terms;
}

/** The text a bare word searches: everything a person might remember. */
function haystack(a: IpamAddress): string {
  return [
    a.address, a.label, a.hostname, a.fqdn, a.owner, a.purpose, a.note, a.mac,
    a.vlan, a.kind, a.assignment, a.source, ...(a.tags ?? []),
    a.site?.name, a.tenant?.name, a.deviceLabel, a.deviceInterface, ...Object.values(a.custom ?? {}),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function fieldValue(a: IpamAddress, field: string): string[] {
  switch (field) {
    case 'tag':
      return a.tags ?? [];
    case 'vlan':
      return a.vlan ? [a.vlan] : [];
    case 'kind':
      return a.kind ? [a.kind] : [];
    case 'source':
      return [a.source];
    case 'assignment':
      return a.assignment ? [a.assignment] : [];
    case 'owner':
      return a.owner ? [a.owner] : [];
    case 'purpose':
      return a.purpose ? [a.purpose] : [];
    case 'hostname':
      return a.hostname ? [a.hostname] : [];
    case 'fqdn':
      return a.fqdn ? [a.fqdn] : [];
    case 'mac':
      return a.mac ? [a.mac] : [];
    case 'note':
      return a.note ? [a.note] : [];
    case 'label':
      return [a.label];
    case 'address':
      return [a.address];
    case 'site':
      return a.site ? [a.site.name] : [];
    case 'tenant':
      return a.tenant ? [a.tenant.name] : [];
    case 'device':
      return a.deviceLabel ? [a.deviceLabel] : [];
    default: {
      const id = field.replace(/^custom[~=]/, '');
      if (id === field) return [];
      const v = a.custom?.[id];
      return v ? [v] : [];
    }
  }
}

/** Whether one term matches, before negation is applied. */
function hit(a: IpamAddress, term: FilterTerm): boolean {
  if (term.field === null) return haystack(a).includes(term.value);
  // `tag:` and `vlan:` are exact — a register where `tag:core` also matched
  // `core-switches` would make an exclusion untrustworthy. The free-text
  // fields stay substring, because that is how people remember a note.
  const exact = EXACT.has(term.field) || term.field.startsWith('custom=');
  const values = fieldValue(a, term.field).map((v) => v.toLowerCase());
  return exact
    ? values.includes(term.value)
    : values.some((v) => v.includes(term.value));
}

/** Whether an address satisfies every term. An empty filter matches all. */
export function matchesFilter(a: IpamAddress, terms: readonly FilterTerm[]): boolean {
  return terms.every((t) => (t.negated ? !hit(a, t) : hit(a, t)));
}

/** Every tag in use, sorted, for offering them rather than making people recall. */
export function tagsInUse(addresses: readonly IpamAddress[]): string[] {
  const all = new Set<string>();
  for (const a of addresses) for (const tag of a.tags ?? []) all.add(tag);
  return [...all].sort();
}
