/**
 * View rules for transfers between own accounts (budget-mit6): register chips
 * and their counts, the suggestion behind a register row, the popover's two
 * sides and "why" line, the transfer rules list. Pure (wire types allowed);
 * tested in transfers.logic.test.ts.
 */
import type { TransferLinkInput, TransferSuggestion } from '@/budget/data/api';
import type { PayeeAdminRow } from '@/budget/data/rows';
import type { Account, Transaction } from '@/domain/types';
import { t } from './i18n';

export type RegisterChip = 'all' | 'needsCategory' | 'suggested' | 'transfers';
export type TransferLeg = TransferSuggestion['leg'];
export type CandidateLeg = TransferSuggestion['candidates'][number];

/** A linked transfer leg, or a rule row counted as a transfer (waiting / outside the budget). */
export const isTransferRow = (tx: Pick<Transaction, 'transferAccountId' | 'transferPending'>): boolean =>
  !!tx.transferAccountId || tx.transferPending != null;

/** Rows a register chip keeps; the chip counts are over the same rows. `suggested` keeps the rows that carry the ⇄ suggestion icon. */
export function filterByChip(rows: Transaction[], chip: RegisterChip, needsCategory: (tx: Transaction) => boolean): Transaction[] {
  if (chip === 'needsCategory') return rows.filter(needsCategory);
  if (chip === 'transfers') return rows.filter(isTransferRow);
  if (chip === 'suggested') return rows.filter((tx) => !!tx.transferSuggestion);
  return rows;
}

export function chipCounts(
  rows: readonly Transaction[],
  needsCategory: (tx: Transaction) => boolean,
): Record<Exclude<RegisterChip, 'all'>, number> {
  let needs = 0;
  let transfers = 0;
  let suggested = 0;
  for (const tx of rows) {
    if (tx.upcoming || tx.installment) continue;
    if (needsCategory(tx)) needs += 1;
    if (isTransferRow(tx)) transfers += 1;
    if (tx.transferSuggestion) suggested += 1;
  }
  return { needsCategory: needs, suggested, transfers };
}

/** The suggestion a register row belongs to: as its subject first, else as a proposed other side. */
export function findSuggestion(list: readonly TransferSuggestion[], txnId: string): TransferSuggestion | undefined {
  return (
    list.find((s) => s.id === txnId) ??
    list.find((s) => s.confidence === 'sure' && s.candidates.some((c) => c.transaction_id === txnId)) ??
    list.find((s) => s.candidates.some((c) => c.transaction_id === txnId))
  );
}

/** What the popover shows for `txnId`: the row, the proposed other side (or choices), and the link to send. */
export interface PopoverSides {
  row: TransferLeg;
  /** The single proposed other side (after a pick, for several). */
  other: CandidateLeg | TransferLeg | null;
  /** Several possible other sides, when the row itself has them. */
  choices: CandidateLeg[];
  /** Outflow first: [from, to]; null = no row on that side. */
  from: TransferLeg | null;
  to: TransferLeg | null;
  link: TransferLinkInput | null;
}

export function popoverSides(s: TransferSuggestion, txnId: string, pick?: string | null): PopoverSides {
  const isSubject = s.leg.transaction_id === txnId;
  const row: TransferLeg = isSubject ? s.leg : (s.candidates.find((c) => c.transaction_id === txnId) ?? s.leg);
  let other: CandidateLeg | TransferLeg | null = null;
  let choices: CandidateLeg[] = [];
  if (!isSubject) other = s.leg;
  else if (s.candidates.length === 1) other = s.candidates[0];
  else if (s.candidates.length > 1) {
    choices = s.candidates;
    other = s.candidates.find((c) => c.transaction_id === pick) ?? null;
  }
  const [from, to] = row.amount < 0 ? [row, other] : [other, row];
  return {
    row,
    other,
    choices,
    from,
    to,
    link: other ? { transaction_id: row.transaction_id, counterpart_id: other.transaction_id } : null,
  };
}

const daysBetween = (a: string, b: string): number =>
  Math.round(Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 86_400_000);

/** "Why: same amount, same day · Pluggy says "…" on both sides · only candidate". */
export function whyLine(s: TransferSuggestion, sides: Pick<PopoverSides, 'row' | 'other'>): string {
  const parts: string[] = [];
  const { row, other } = sides;
  if (other) {
    const days = daysBetween(row.date, other.date);
    parts.push(days === 0 ? t('why.sameDay') : t('why.daysApart', { count: days }));
    if (row.bank_label && row.bank_label === other.bank_label) parts.push(t('why.bankBoth', { label: row.bank_label }));
    else {
      for (const label of [row.bank_label, other.bank_label]) if (label) parts.push(t('why.bankOne', { label }));
    }
  } else if (row.bank_label) {
    parts.push(t('why.bankOne', { label: row.bank_label }));
  }
  if (s.basis === 'unique') parts.push(t('why.unique'));
  else if (s.basis === 'ordinal') parts.push(t('why.ordinal'));
  else if (s.basis === 'evidence') parts.push(t('why.evidence'));
  else if (s.basis === 'rule') parts.push(t('why.rule'));
  else if (s.basis === 'ambiguous') parts.push(t('why.ambiguous', { count: s.candidates.length }));
  else parts.push(t('why.unmatched'));
  if (s.confidence === 'sure' && (!row.untouched || (other && !other.untouched))) parts.push(t('why.edited'));
  return `${t('why.label')} ${parts.join(' · ')}`;
}

/** Toast after linking: "3 linked as transfers · 1 payee rule created". */
export function linkedToast(result: { linked: string[]; rules_created: number }): string {
  const pairs = Math.round(result.linked.length / 2);
  const linked = t('toast.linked', { count: pairs });
  return result.rules_created > 0 ? `${linked} · ${t('toast.rules', { count: result.rules_created })}` : linked;
}

/** On-budget open accounts a transfer may go to (rule targets, "Other account…"). */
export function transferTargets(accounts: readonly Account[], exceptId?: string): Account[] {
  return accounts.filter((a) => a.onBudget && a.group !== 'CLOSED' && a.id !== exceptId);
}

/** "Nubank Conta, Nubank Cartão…" for the rule's automatic option. */
export function accountsHint(accounts: readonly Account[], max = 2): string {
  const names = accounts.map((a) => a.name);
  return names.length > max ? `${names.slice(0, max).join(', ')}…` : names.join(', ');
}

/** The "Transfer rules" list: linking rules first, then "never", by name. */
export function transferRules(
  payees: readonly PayeeAdminRow[],
  accounts: readonly Pick<Account, 'id' | 'name'>[],
): { payeeId: string; name: string; never: boolean; target: string }[] {
  return payees
    .filter((p) => p.transfer_rule)
    .map((p) => {
      const never = p.transfer_rule === 'never';
      const account = accounts.find((a) => a.id === p.transfer_rule_account_id);
      const target = never
        ? t('rules.never')
        : p.transfer_rule === 'account' && account
          ? t('rules.account', { account: account.name })
          : t('rules.auto');
      return { payeeId: p.id, name: p.name, never, target };
    })
    .sort((a, b) => Number(a.never) - Number(b.never) || a.name.localeCompare(b.name));
}
