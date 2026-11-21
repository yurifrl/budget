/**
 * Pure view-model helpers of the Edit Account modal that read wire rows
 * (account + connection aggregates), so they live beside the modal rather
 * than in domain/.
 */

import type { ConnectionUpstreamJson, UpstreamAccountJson } from '@/budget/data/connections';
import { milliToCents } from '@/budget/data/mapping';
import type { AccountRow } from '@/budget/data/rows';

import { t } from './i18n';

/** The account's working balance (cleared + uncleared) in cents. */
export function workingCents(account: Pick<AccountRow, 'cleared_balance' | 'uncleared_balance'>): number {
  return milliToCents(account.cleared_balance + account.uncleared_balance);
}

/**
 * The upstream account currently backing this budget account (1:1) and the
 * connection entry that lists it; null when no upstream row links here.
 */
export function findLinkedUpstream(
  upstream: ConnectionUpstreamJson[],
  accountId: string,
): { entry: ConnectionUpstreamJson; account: UpstreamAccountJson } | null {
  const account = upstream.flatMap((entry) => entry.accounts ?? []).find((a) => a.linkedAccountId === accountId) ?? null;
  if (!account) return null;
  const entry = upstream.find((e) => e.accounts?.includes(account)) ?? null;
  return entry ? { entry, account } : null;
}

/**
 * Why a linked account shows no upstream row: some connection's account list
 * could not be read (accounts == null), or the link went stale.
 */
export function unmatchedLinkHint(upstream: ConnectionUpstreamJson[] | undefined): string {
  return upstream?.some((entry) => entry.accounts == null)
    ? t('link.unavailable')
    : t('link.stale');
}

/** "Connected to <institution>": the account's own label wins over the connection's. */
export function connectedToLabel(accountInstitution: string | null | undefined, connectionInstitution: string | null | undefined): string {
  return t('link.connectedTo', { institution: accountInstitution ?? connectionInstitution ?? t('link.bankFallback') });
}
