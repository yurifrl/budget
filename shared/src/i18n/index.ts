/**
 * Dependency-free typed i18n. See docs/i18n.md for the recipe.
 *
 *   // features/payees/i18n/index.ts
 *   export const t = defineMessages('payees', en, { 'pt-BR': ptBR });
 *   t('merge.title'); t('activity.count', { count: 3 });
 *
 * The active locale is one module-level singleton (default `en`): pure code
 * calls `t` directly and tests run in `en`. The API server, where a singleton
 * is wrong across concurrent requests, uses `t.for(locale)(...)`.
 */

import { pluralCategory } from './plural';
import type {
  Catalog,
  Locale,
  MessageOptions,
  ParamlessKey,
  RegisteredNamespace,
  Translation,
  Translator,
} from './types';

export type {
  ArgsOf,
  Catalog,
  Locale,
  Message,
  MessageOptions,
  ParamlessKey,
  ParamNames,
  ParamsOf,
  ParamValue,
  PluralMessage,
  RegisteredNamespace,
  Translation,
  TranslateFn,
  Translator,
} from './types';
export { pluralCategory, type PluralCategory } from './plural';
export { parseRich, type RichNode } from './rich';

export const LOCALES = ['en', 'pt-BR'] as const satisfies readonly Locale[];

/** Label of each locale in its own language (language pickers). */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { en: 'English', 'pt-BR': 'Português (Brasil)' };

// ---------------------------------------------------------------------------
// Active locale (the one device-wide singleton)
// ---------------------------------------------------------------------------

let active: Locale = 'en';
let pseudo = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function getLocale(): Locale {
  return active;
}

export function setLocale(locale: Locale): void {
  if (locale === active) return;
  active = locale;
  emit();
}

/**
 * Dev-only pseudo-locale `en-XA`: English text with every translated string
 * wrapped in `⟦ ⟧`, so an untranslated literal stands out. Not a `Locale`, not
 * in `LOCALES`, never offered in settings. `getLocale()` stays `en`.
 */
export function setPseudoLocale(on: boolean): void {
  if (on === pseudo) return;
  pseudo = on;
  emit();
}

export function isPseudoLocale(): boolean {
  return pseudo;
}

/** `en`, `pt-BR` or `en-XA`: changes whenever what `t()` returns would change. Key for a remount boundary. */
export function getLocaleKey(): string {
  return pseudo ? 'en-XA' : active;
}

/** Call `listener` after the locale (or the pseudo switch) changes. Returns the unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Pick a supported locale from BCP 47 tags in preference order (device
 * languages). The first tag that is Portuguese (`pt`, `pt-BR`, `pt-PT`, `pt_BR`)
 * gives `pt-BR`, the first that is English gives `en`; other tags are skipped;
 * nothing matching gives `en`.
 */
export function resolveLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (lower === 'pt' || lower.startsWith('pt-') || lower.startsWith('pt_')) return 'pt-BR';
    if (lower === 'en' || lower.startsWith('en-') || lower.startsWith('en_')) return 'en';
  }
  return 'en';
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

const namespaces = new Map<string, RegisteredNamespace>();

/** Every namespace registered so far (the catalog test walks these). */
export function registry(): readonly RegisteredNamespace[] {
  return [...namespaces.values()];
}

const PLACEHOLDER = /\{([A-Za-z_]\w*)\}/g;

function interpolate(text: string, params: Readonly<Record<string, string | number>> | undefined): string {
  if (params === undefined) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Register a namespace and get its `t`. `en` is the source of truth for keys
 * and params; `others['pt-BR']` must have exactly the same keys (tsc error
 * otherwise). Call once per namespace, in `i18n/index.ts`.
 */
export function defineMessages<const E extends Catalog>(
  namespace: string,
  en: E,
  others: { readonly 'pt-BR': NoInfer<Translation<E>> },
  options: MessageOptions<E> = {},
): Translator<E> {
  const catalogs: Readonly<Record<Locale, Catalog>> = { en, 'pt-BR': others['pt-BR'] };
  namespaces.set(namespace, {
    name: namespace,
    en,
    catalogs,
    sameAsEnglish: new Set(options.sameAsEnglish ?? []),
    dynamicPrefixes: options.dynamicPrefixes ?? [],
    skipUnusedCheck: options.skipUnusedCheck ?? false,
  });

  function translate(locale: Locale | null, key: string, params: Readonly<Record<string, string | number>> | undefined): string {
    const loc = locale ?? active;
    const message = catalogs[loc][key] ?? en[key];
    if (message === undefined) return key;
    const text =
      typeof message === 'string' ? message : message[pluralCategory(loc, Number(params?.count))];
    const out = interpolate(text, params);
    return locale === null && pseudo ? `⟦${out}⟧` : out;
  }

  const t = ((key: string, params?: Readonly<Record<string, string | number>>) => translate(null, key, params)) as unknown as Translator<E>;
  (t as { for: Translator<E>['for'] }).for = (locale) =>
    ((key: string, params?: Readonly<Record<string, string | number>>) => translate(locale, key, params)) as ReturnType<Translator<E>['for']>;
  Object.defineProperty(t, 'namespace', { value: namespace, enumerable: true });
  Object.defineProperty(t, 'messages', { value: en, enumerable: true });
  return t;
}

/**
 * A table of labels that resolves at read time: each property is a getter, so
 * `export const REPEAT_LABEL: Record<Repeat, string> = labels(t, { weekly: 'repeat.weekly', … })`
 * keeps every call site (and test) reading a plain string, in the active locale.
 * Only keys that take no params.
 */
export function labels<E extends Catalog, const M extends Record<string, ParamlessKey<E>>>(
  t: Translator<E>,
  table: M,
): { readonly [P in keyof M]: string } {
  const out = {} as { [P in keyof M]: string };
  for (const name of Object.keys(table) as (keyof M & string)[]) {
    const key = table[name] as ParamlessKey<E>;
    Object.defineProperty(out, name, {
      enumerable: true,
      get: () => (t as unknown as (k: string) => string)(key),
    });
  }
  return out;
}
