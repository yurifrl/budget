/**
 * Money-format prefs — module-scoped store behind `domain/format`.
 *
 * The Settings panel writes user choices here (Currency, Currency Placement,
 * Number Format); `formatMoney`/`formatAmount` read them so every money
 * render in the module follows without call-site changes — same mechanism as
 * the Hide Amounts mask. Defaults reproduce the original BRL/pt-BR output
 * exactly, so domain tests and screens are untouched until the panel applies
 * a different choice. Not shared React state: consumers bridge it into React
 * via `ui/stores` (useSyncExternalStore).
 */

export type FmtCurrency = 'BRL' | 'USD';
export type FmtPlacement = 'before' | 'after' | 'hidden';
export type FmtNumberLocale = 'pt-BR' | 'en-US';
export type FmtDateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY';

export interface FmtPrefs {
  currency: FmtCurrency;
  currencyPlacement: FmtPlacement;
  numberLocale: FmtNumberLocale;
  /** Parsed by `formatDate`; "MM/DD/YYYY" only affects new renders after the panel changes it. */
  dateFormat: FmtDateFormat;
}

export const DEFAULT_FMT_PREFS: FmtPrefs = {
  currency: 'BRL',
  currencyPlacement: 'before',
  numberLocale: 'pt-BR',
  dateFormat: 'DD/MM/YYYY',
};

let prefs: FmtPrefs = DEFAULT_FMT_PREFS;
const listeners = new Set<() => void>();

export function getFmtPrefs(): FmtPrefs {
  return prefs;
}

export function setFmtPrefs(next: Partial<FmtPrefs>): void {
  prefs = { ...prefs, ...next };
  for (const listener of listeners) listener();
}

/** useSyncExternalStore-compatible subscribe; returns the unsubscribe fn. */
export function subscribeFmtPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
