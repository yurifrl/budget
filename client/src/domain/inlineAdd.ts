/**
 * Pure rules behind the register's inline add / edit row (InlineAddRow): the
 * repeat frequencies, split-leg maths, date resolution, the scheduled USD
 * draft and the validation that turns a draft into the fields to save.
 */

import { isUsdDraft, makeMonth } from './format';
import type { RowDraft } from './rowEdit';
import type { Cents, MonthKey, RepeatFrequency, Transaction, TransactionSplit } from './types';

/** Frequencies the calendar-footer Repeat dropdown offers (server FREQUENCIES). Shared with the row menu's Make Repeating (syscd-app-42f). */
export const REPEAT_FREQS: RepeatFrequency[] = [
  'weekly',
  'every-other-week',
  'monthly',
  'every-other-month',
  'quarterly',
  'annually',
];
export const REPEAT_LABELS: Record<RepeatFrequency, string> = {
  weekly: 'Every week',
  'every-other-week': 'Every other week',
  monthly: 'Monthly',
  'every-other-month': 'Every other month',
  quarterly: 'Quarterly',
  annually: 'Yearly',
};

/** RepeatCadence values a rule can actually use (a stored txn may carry any cadence). */
const isRepeatFreq = (cadence: string): cadence is RepeatFrequency =>
  (REPEAT_FREQS as string[]).includes(cadence);

/**
 * Calendar-footer Repeat control (syscd-app-pya): null = never. An
 * already-repeating transaction keeps its rule's frequency.
 */
export function initialRepeatFreq(
  transaction: Pick<Transaction, 'repeat' | 'repeatRuleId'> | undefined,
): RepeatFrequency | null {
  return transaction?.repeatRuleId && isRepeatFreq(transaction.repeat) ? transaction.repeat : null;
}

/** Fresh split leg for the editor: one-way amounts start empty (syscd-app-rlt). */
export const emptySplit = (): TransactionSplit => ({
  id: `draft-${Math.random().toString(36).slice(2)}`,
  categoryId: null,
  memo: '',
  outflow: 0,
  inflow: 0,
});

/**
 * Parent-amount for a split: the signed sum of its legs (YNAB requires the
 * legs to total the parent). One-way on the wire — mixed legs collapse to the
 * net direction.
 */
export const splitTotals = (splits: readonly TransactionSplit[]): { outflow: Cents; inflow: Cents } => {
  const net = splits.reduce((acc, s) => acc + s.inflow - s.outflow, 0);
  return net >= 0 ? { outflow: 0, inflow: net } : { outflow: -net, inflow: 0 };
};

/** Split panel header total: "R$ 5,00 out" / "… in" / "no amount" (`zero` dims it). */
export function splitTotalLabel(
  splits: readonly TransactionSplit[],
  formatMoney: (cents: Cents) => string,
): { text: string; zero: boolean } {
  const { outflow, inflow } = splitTotals(splits);
  return {
    text: outflow > 0 ? `${formatMoney(outflow)} out` : inflow > 0 ? `${formatMoney(inflow)} in` : 'no amount',
    zero: outflow + inflow === 0,
  };
}

/** Patch one leg by index. */
export function updateSplitLeg(
  splits: readonly TransactionSplit[],
  index: number,
  patch: Partial<TransactionSplit>,
): TransactionSplit[] {
  return splits.map((s, j) => (j === index ? { ...s, ...patch } : s));
}

/** Remove one leg; the editor always keeps at least one (a fresh empty leg). */
export function removeSplitLeg(splits: readonly TransactionSplit[], index: number): TransactionSplit[] {
  return splits.length > 1 ? splits.filter((_, j) => j !== index) : [emptySplit()];
}

type ParseDateInput = (raw: string) => string | null;

/** The draft's ISO date: the parsed text, today when blank, null when unparseable. */
export function resolveDraftDate(dateText: string, parseDateInput: ParseDateInput, today: string): string | null {
  return parseDateInput(dateText) ?? (dateText.trim() ? null : today);
}

/**
 * Menu amounts are month-scoped: AVAILABLE for the month the typed date
 * lands in (today when the date is blank or invalid).
 */
export function draftMonthKey(dateIso: string | null, today: string): MonthKey {
  const [year, month] = (dateIso ?? today).split('-');
  return makeMonth(Number(year), Number(month));
}

/** The parent-level draft the dirty checks (domain/rowEdit) compare; an unparseable date is '' (always dirty). */
export function inlineRowDraft(
  d: Pick<InlineDraft, 'accountId' | 'dateText' | 'payee' | 'categoryId' | 'memo' | 'outflow' | 'inflow'>,
  parseDateInput: ParseDateInput,
  today: string,
): RowDraft {
  return {
    accountId: d.accountId,
    date: parseDateInput(d.dateText) ?? (d.dateText.trim() ? '' : today),
    payee: d.payee,
    categoryId: d.categoryId,
    memo: d.memo,
    outflowCents: d.outflow,
    inflowCents: d.inflow,
  };
}

/**
 * USD draft on a scheduled row: the amount was typed with a "$" prefix (e.g.
 * "$100"), so it is USD and the ledger (BRL) amount is its conversion.
 */
export interface UsdDraft {
  cents: Cents;
  field: 'outflow' | 'inflow';
}

/**
 * Amount commits with the raw text: a "$" prefix marks the draft as USD.
 * Direction comes from the cell's non-zero side.
 */
export function usdDraftFromCommit(outflowCents: Cents, inflowCents: Cents, raw: string): UsdDraft | null {
  const field: 'outflow' | 'inflow' = outflowCents !== 0 ? 'outflow' : 'inflow';
  return raw && isUsdDraft(raw) ? { cents: outflowCents !== 0 ? outflowCents : inflowCents, field } : null;
}

/** Ledger (BRL) cents for a USD draft at the indicative rate. */
export function usdToLedger(usd: UsdDraft, rate: number): Cents {
  return Math.round(usd.cents * rate);
}

/** Everything the inline row holds when Save runs. */
export interface InlineDraft {
  /** The resolved account's id. */
  accountId: string;
  dateText: string;
  payee: string;
  categoryId: string | null;
  memo: string;
  outflow: Cents;
  inflow: Cents;
  splitsOpen: boolean;
  splits: TransactionSplit[];
  repeatFreq: RepeatFrequency | null;
  usd: UsdDraft | null;
  /** The captain typed the conversion: it is saved as-is. */
  convEdited: boolean;
}

/** Parent-level fields written by a save (create and edit share them). */
export interface InlineSaveFields {
  accountId: string;
  date: string;
  payee: string;
  categoryId: string | null;
  memo: string;
  outflowCents: Cents;
  inflowCents: Cents;
}

export type InlineSavePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      fields: InlineSaveFields;
      /** Splits save the full leg list (server replaces, never diffs). */
      subtransactions: { categoryId: string | null; memo: string; outflowCents: Cents; inflowCents: Cents }[];
    };

/**
 * Validate the draft and resolve what a save writes, or the message to show.
 */
export function planInlineSave(
  d: InlineDraft,
  ctx: {
    parseDateInput: ParseDateInput;
    today: string;
    /** The user's date format, quoted in the invalid-date message. */
    dateFormat: string;
    /** Indicative USD→BRL rate, when loaded. */
    rate: number | null | undefined;
    rateFetching: boolean;
  },
): InlineSavePlan {
  const draftSplits = d.splitsOpen ? d.splits : [];
  if (d.outflow === 0 && d.inflow === 0 && !draftSplits.some((s) => s.outflow !== 0 || s.inflow !== 0)) {
    return { ok: false, error: 'enter an amount' };
  }
  const date = resolveDraftDate(d.dateText, ctx.parseDateInput, ctx.today);
  if (!date) {
    return { ok: false, error: `invalid date — try ${ctx.dateFormat} or 5, 5/9` };
  }
  if (draftSplits.length > 0 && draftSplits.some((s) => !s.categoryId)) {
    return { ok: false, error: 'every split needs a category' };
  }
  if (draftSplits.length > 0 && draftSplits.every((s) => s.outflow === 0 && s.inflow === 0)) {
    return { ok: false, error: 'enter an amount on each split' };
  }
  // Legs count only while the split panel is open — a closed panel means a
  // plain categorized row (explicit un-split gesture in edit mode).
  const liveSplits = d.splitsOpen ? d.splits.filter((s) => s.outflow !== 0 || s.inflow !== 0) : [];
  const totals = liveSplits.length > 0 ? splitTotals(liveSplits) : null;
  // Scheduled USD draft: the ledger amount is the BRL conversion — the
  // rate-fetched value, or whatever the captain typed in the conversion
  // field (convEdited). Split legs and non-scheduled rows save as typed.
  let outflowCents = totals ? totals.outflow : d.inflow > 0 ? 0 : d.outflow;
  let inflowCents = totals ? totals.inflow : d.inflow > 0 ? d.inflow : 0;
  if (d.repeatFreq && d.usd && !d.convEdited && totals == null) {
    const rate = ctx.rate;
    if (rate == null) {
      return {
        ok: false,
        error: ctx.rateFetching
          ? 'fetching the USD→BRL rate — try again in a moment'
          : 'no exchange rate available — enter the amount in R$ (without $)',
      };
    }
    const brl = usdToLedger(d.usd, rate);
    if (d.usd.field === 'outflow') outflowCents = brl;
    else inflowCents = brl;
  }
  return {
    ok: true,
    fields: {
      accountId: d.accountId,
      date,
      payee: d.payee.trim(),
      // Splits force the parent category to NULL ("Split"); the server
      // rejects a split carrying a category_id. The parent amount is the
      // leg total so account balances move by the split's real sum.
      categoryId: totals ? null : d.categoryId,
      memo: d.memo.trim(),
      outflowCents,
      inflowCents,
    },
    subtransactions: liveSplits.map((s) => ({
      categoryId: s.categoryId,
      memo: s.memo,
      outflowCents: s.outflow,
      inflowCents: s.inflow,
    })),
  };
}

/**
 * The repeat rule created on save: the saved transaction becomes the series
 * anchor and the server schedules the next occurrences.
 */
export function repeatRuleFields(fields: InlineSaveFields, frequency: RepeatFrequency, attachTransactionId: string) {
  return {
    accountId: fields.accountId,
    payee: fields.payee,
    categoryId: fields.categoryId,
    memo: fields.memo,
    outflowCents: fields.outflowCents,
    inflowCents: fields.inflowCents,
    frequency,
    monthLastDay: false,
    attachTransactionId,
  };
}
