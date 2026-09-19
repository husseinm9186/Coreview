/**
 * Translatable text (LT-272). English first: `en.ts` holds every string that
 * has moved here, and a language added later supplies what it can.
 *
 *     t('tour.progress', { done: 2, total: 6 })   // "2 of 6"
 *     t('report.drawings', { count: 1 })          // "1 page of drawings, …"
 *
 * Deliberately small and dependency-free: a catalogue per language, `{name}`
 * placeholders, and plural forms chosen by the platform's own
 * `Intl.PluralRules`, which already knows every language's rules.
 */
import { en } from './en';

type Plural = { readonly other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
export type MessageKey = keyof typeof en;
export type Catalogue = { readonly [K in MessageKey]?: string | Plural };

const catalogues: Record<string, Catalogue> = { en };
let current = 'en';

/** The languages there is a catalogue for. */
export const availableLocales = (): string[] => Object.keys(catalogues);

/** Adds or replaces a language. */
export function addCatalogue(locale: string, messages: Catalogue) {
  catalogues[locale] = messages;
}

/** Chooses the language, falling back from `pt-BR` to `pt` to English. */
export function setLocale(locale: string) {
  const base = locale.split('-')[0]!;
  current = catalogues[locale] ? locale : catalogues[base] ? base : 'en';
}

export const locale = () => current;

function fill(text: string, params: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const message = catalogues[current]?.[key] ?? en[key];
  if (typeof message === 'string') return fill(message, params);
  const count = Number(params.count ?? 0);
  const form = new Intl.PluralRules(current).select(count);
  return fill((message as Plural)[form] ?? message.other, params);
}
