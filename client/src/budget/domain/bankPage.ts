/**
 * Pure helpers for the bank page (ConnectionSettingsScreen): display names,
 * transaction-state presentation, milliunit conversion. No React, no I/O.
 */

import type { ConnectionTxnState } from '../data/connections';
import type { Cents } from './types';

/**
 * Human bank name. Providers sometimes hand back a raw lowercase id
 * ("nubank", "banco-inter"): those are title-cased; names that already carry
 * capitals ("Itaú Unibanco", "XP") are left alone.
 */
/** Known provider ids whose real name carries diacritics. */
const KNOWN_BANKS: Record<string, string> = { itau: 'Itaú', 'banco-do-brasil': 'Banco do Brasil', caixa: 'Caixa' };

export function bankDisplayName(institution: string | null | undefined, provider: string): string {
  const raw = (institution ?? '').trim() || provider;
  if (raw !== raw.toLowerCase()) return raw;
  if (KNOWN_BANKS[raw]) return KNOWN_BANKS[raw];
  return raw
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Server amounts are signed MILLIUNITS (cents x 10); the app formats cents. */
export function milliToCents(milli: number): Cents {
  return Math.round(milli / 10);
}

export type TxnStateTone = 'neutral' | 'warn' | 'bad';

/** Label + tone for a bank-imported transaction's state. */
export function txnStateView(state: ConnectionTxnState): { label: string; tone: TxnStateTone } {
  switch (state) {
    case 'edited':
      return { label: 'Edited by you', tone: 'warn' };
    case 'removed':
      return { label: 'Removed at bank', tone: 'bad' };
    default:
      return { label: 'Imported', tone: 'neutral' };
  }
}
