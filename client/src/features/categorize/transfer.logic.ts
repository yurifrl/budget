/**
 * Pure view logic of the page's Transfers section and of a transfer row in the
 * One by one stream: the sentence a Jev answer becomes ("Transfer to Savings"),
 * how its answers are grouped by the account pair they name, and the decision
 * items the accept path sends. Wire-typed, so it lives beside the screen.
 */

import type {
  CategorizeDecisionItem,
  CategorizeTransferGroup,
  CategorizeTransferRow,
} from '@/budget/data/api';
import { milliToCents } from '@/budget/data/mapping';
import { apiErrorCode } from '@/platform/api/baseQuery';

import { t } from './i18n';

/** Which way the money moved, from the row's point of view. */
export type TransferSide = 'to' | 'from';

/**
 * One Jev transfer answer, flat: the row, the account it names and the
 * direction. A group in the wire shape holds several of these.
 */
export type TransferItem = CategorizeTransferRow & {
  transferAccountId: string;
  transferAccountName: string;
  side: TransferSide;
  onBudget: boolean;
};

/**
 * The three answers a Jev transfer row takes, as the page wires them. Each
 * resolves whether it landed, so a line that failed takes its optimistic
 * removal back.
 */
export type TransferActions = {
  accept: (item: TransferItem) => Promise<boolean>;
  refuse: (item: TransferItem) => Promise<boolean>;
  skip: (item: TransferItem) => Promise<boolean>;
};

/** "Transfer to Savings" / "Transfer from Savings". The transfer account is the one named. */
export function transferHeading(item: Pick<TransferItem, 'side' | 'transferAccountName'>): string {
  return item.side === 'to'
    ? t('transfer.to', { account: item.transferAccountName })
    : t('transfer.from', { account: item.transferAccountName });
}

/** The confidence as the chip prints it, 0..100. */
export function transferPercent(confidence: number): number {
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100);
}

/** Every answer as one flat item, in the order the groups and rows arrive. */
export function jevItems(groups: readonly CategorizeTransferGroup[]): TransferItem[] {
  return groups.flatMap((group) =>
    group.rows.map((row) => ({
      ...row,
      transferAccountId: group.transfer_account_id,
      transferAccountName: group.transfer_account_name,
      side: group.direction,
      onBudget: group.on_budget,
    })),
  );
}

/** One account pair as the section shows it: heading, the two sides, its rows and sum. */
export interface TransferGroupView {
  key: string;
  heading: string;
  /** "Checking → Savings": the account the money left, then the one it arrived in. */
  pair: string;
  transferAccountId: string;
  side: TransferSide;
  items: TransferItem[];
  /** Integer milliunits, the rows' sum signed as they are. */
  total: number;
}

/**
 * The pairs as the section shows them: one group per real pair — the row's own
 * account, the account the answer names, and the direction. The server groups
 * by (named account, direction) only, so one of its groups can hold rows from
 * several own accounts; regrouping here gives every group one true heading.
 */
export function jevGroups(groups: readonly CategorizeTransferGroup[]): TransferGroupView[] {
  const byPair = new Map<string, TransferItem[]>();
  for (const item of jevItems(groups)) {
    const key = `${item.account_id}:${item.transferAccountId}:${item.side}`;
    const list = byPair.get(key);
    if (list) list.push(item);
    else byPair.set(key, [item]);
  }
  return [...byPair].map(([key, items]) => {
    const first = items[0]!;
    return {
      key,
      heading: transferHeading(first),
      pair: transferSides(first),
      transferAccountId: first.transferAccountId,
      side: first.side,
      items,
      total: items.reduce((sum, item) => sum + item.amount, 0),
    };
  });
}

/**
 * The groups with the rows already answered (accepted, refused, skipped) left
 * out: a row leaves the section the moment it is answered, and a pair with no
 * row left disappears with the last one. The total follows the rows that stay.
 */
export function visibleGroups(
  groups: readonly TransferGroupView[],
  hidden: ReadonlySet<string>,
): TransferGroupView[] {
  const kept: TransferGroupView[] = [];
  for (const group of groups) {
    const items = group.items.filter((item) => !hidden.has(item.transaction_id));
    if (items.length === 0) continue;
    kept.push({
      ...group,
      items,
      total: items.reduce((sum, item) => sum + item.amount, 0),
    });
  }
  return kept;
}

/**
 * The pair sentence of one answer, read outflow first: a `to` answer left the
 * row's own account, a `from` answer arrived in it.
 */
export function transferSides(
  item: Pick<TransferItem, 'side' | 'account_name' | 'transferAccountName'>,
): string {
  const own = item.account_name;
  const other = item.transferAccountName;
  return item.side === 'to'
    ? t('transfer.pair', { out: own, in: other })
    : t('transfer.pair', { out: other, in: own });
}

/** The accept payload: each row linked to the account its answer names. */
export function transferDecisions(items: readonly TransferItem[]): CategorizeDecisionItem[] {
  return items.map((item) => ({
    transaction_id: item.transaction_id,
    transfer_account_id: item.transferAccountId,
  }));
}

/**
 * The toast's subject: the payee and the amount, as the queue rows write it.
 * The wire amount is integer milliunits and `formatMoney` takes cents, so the
 * conversion happens here, once, for every transfer line that says an amount.
 */
export function transferSubject(
  item: Pick<TransferItem, 'payee' | 'amount'>,
  formatMoney: (cents: number) => string,
): string {
  return t('transfer.subject', {
    payee: item.payee.trim() === '' ? t('row.unnamed') : item.payee,
    amount: formatMoney(milliToCents(item.amount)),
  });
}

/**
 * The sentence an answer Jev's transfer accept was refused with, when the
 * server named a reason of its own; undefined keeps the caller's sentence.
 * A row that was already answered, categorized or linked is not an error the
 * person can retry, so it says what happened instead of that the request failed.
 */
export function transferAcceptError(error: unknown): string | undefined {
  switch (apiErrorCode(error)) {
    case 'categorize_transfer_refused':
      return t('transfer.errorRefused');
    case 'categorize_already_categorized':
      return t('transfer.errorCategorized');
    case 'categorize_not_needing_category':
      return t('transfer.errorNoCategory');
    default:
      return undefined;
  }
}

/**
 * The pair a matcher suggestion names, written the way a Jev card writes it:
 * both accounts once the other side is settled, else the one side that is
 * known (a pair still to pick from, or a row with no match at all).
 */
export function matcherHeading(pair: { fromAccount: string | null; toAccount: string | null }): string {
  if (pair.fromAccount && pair.toAccount) return t('transfer.pair', { out: pair.fromAccount, in: pair.toAccount });
  if (pair.fromAccount) return t('transfer.from', { account: pair.fromAccount });
  if (pair.toAccount) return t('transfer.to', { account: pair.toAccount });
  return '';
}
