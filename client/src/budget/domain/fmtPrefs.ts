/**
 * Money and date format prefs (Settings > Plan Settings): currency, symbol
 * placement, number format, date format. Types and defaults only; the live
 * value lives in the budgetUi redux slice and reaches components through
 * `useMoneyFormat()`. Defaults reproduce the original BRL/pt-BR output.
 */

export type FmtCurrency = 'BRL' | 'USD';
export type FmtPlacement = 'before' | 'after' | 'hidden';
export type FmtNumberLocale = 'pt-BR' | 'en-US';
export type FmtDateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY';

export interface FmtPrefs {
  currency: FmtCurrency;
  currencyPlacement: FmtPlacement;
  numberLocale: FmtNumberLocale;
  dateFormat: FmtDateFormat;
}

export const DEFAULT_FMT_PREFS: FmtPrefs = {
  currency: 'BRL',
  currencyPlacement: 'before',
  numberLocale: 'pt-BR',
  dateFormat: 'DD/MM/YYYY',
};

/**
 * @deprecated No-op. Prefs live in the budgetUi redux slice (`setFmtPrefs`
 * action in state/ui). Kept only because data/settingsBlob.ts (owned by the
 * data-layer work, not edited here) still imports it for the unused
 * `applyBudgetSettings`. Follow-up: delete with that function.
 */
export function setFmtPrefs(_next: Partial<FmtPrefs>): void {}
