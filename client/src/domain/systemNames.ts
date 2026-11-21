/**
 * Names the app itself writes into the budget and later recognises by their
 * exact English text (payees "Starting Balance" and "Reconciliation
 * Adjustment", the category group "Credit Card Payments", and the per-account
 * transfer payees "Transfer : <account>"). The database keeps the English
 * text; only what the person SEES is translated, by exact match, at the
 * display site. Never use these in comparisons, sort keys, edits, saves or
 * exports: the stored value flows through unchanged.
 */

import { TRANSFER_PAYEE_PREFIX } from '@shared/domain/transfers';

import { t } from './i18n';

/* eslint-disable budget-i18n/no-untranslated-string -- stored system names: identity, matched exactly */
const STARTING_BALANCE = 'Starting Balance';
const RECONCILIATION_ADJUSTMENT = 'Reconciliation Adjustment';
const CREDIT_CARD_PAYMENTS = 'Credit Card Payments';
/* eslint-enable budget-i18n/no-untranslated-string */

/** The stored payee / category group name as shown to the person in the active language. */
export function displaySystemName(name: string): string {
  switch (name) {
    case STARTING_BALANCE:
      return t('system.startingBalance');
    case RECONCILIATION_ADJUSTMENT:
      return t('system.reconciliationAdjustment');
    case CREDIT_CARD_PAYMENTS:
      return t('system.creditCardPayments');
    default:
      return name.startsWith(TRANSFER_PAYEE_PREFIX)
        ? t('system.transfer', { account: name.slice(TRANSFER_PAYEE_PREFIX.length) })
        : name;
  }
}

/**
 * Search match for a payee list: the typed text (already trimmed and
 * lower-cased) is found in the stored name or in the displayed name, so
 * "saldo" finds "Starting Balance" in Portuguese and "balance" still does.
 */
export function matchesSystemName(name: string, query: string): boolean {
  return name.toLowerCase().includes(query) || displaySystemName(name).toLowerCase().includes(query);
}
