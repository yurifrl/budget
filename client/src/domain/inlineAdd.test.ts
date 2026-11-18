import { describe, expect, test } from 'bun:test';

import { moneyFormat } from './format';
import {
  REPEAT_FREQS,
  REPEAT_LABELS,
  draftMonthKey,
  emptySplit,
  initialRepeatFreq,
  inlineRowDraft,
  planInlineSave,
  removeSplitLeg,
  repeatRuleFields,
  resolveDraftDate,
  splitTotalLabel,
  splitTotals,
  updateSplitLeg,
  usdDraftFromCommit,
  usdToLedger,
  type InlineDraft,
} from './inlineAdd';
import type { Transaction, TransactionSplit } from './types';

const fmt = moneyFormat();
const TODAY = '2026-03-10';
const leg = (over: Partial<TransactionSplit> = {}): TransactionSplit => ({ id: 'l', categoryId: 'c1', memo: '', outflow: 0, inflow: 0, ...over });

describe('repeat frequencies', () => {
  test('the offered list and its labels', () => {
    expect(REPEAT_FREQS).toEqual(['weekly', 'every-other-week', 'monthly', 'every-other-month', 'quarterly', 'annually']);
    expect(REPEAT_FREQS.map((f) => REPEAT_LABELS[f])).toEqual([
      'Every week', 'Every other week', 'Monthly', 'Every other month', 'Quarterly', 'Yearly',
    ]);
  });
  test('initialRepeatFreq: only a row that belongs to a rule with a usable cadence', () => {
    const t = (over: Partial<Transaction>) => ({ repeat: 'never', repeatRuleId: null, ...over }) as Transaction;
    expect(initialRepeatFreq(undefined)).toBeNull();
    expect(initialRepeatFreq(t({ repeat: 'monthly' }))).toBeNull();
    expect(initialRepeatFreq(t({ repeat: 'monthly', repeatRuleId: 'r1' }))).toBe('monthly');
    expect(initialRepeatFreq(t({ repeat: 'daily', repeatRuleId: 'r1' }))).toBeNull();
    expect(initialRepeatFreq(t({ repeat: 'yearly', repeatRuleId: 'r1' }))).toBeNull();
  });
});

describe('split legs', () => {
  test('emptySplit: a fresh uncategorized zero leg with a draft id', () => {
    const a = emptySplit();
    expect(a).toEqual({ id: a.id, categoryId: null, memo: '', outflow: 0, inflow: 0 });
    expect(a.id.startsWith('draft-')).toBe(true);
    expect(emptySplit().id).not.toBe(a.id);
  });
  test('splitTotals: signed sum collapsed to one direction (zero is an inflow of 0)', () => {
    expect(splitTotals([leg({ outflow: 300 }), leg({ outflow: 200 })])).toEqual({ outflow: 500, inflow: 0 });
    expect(splitTotals([leg({ outflow: 300 }), leg({ inflow: 500 })])).toEqual({ outflow: 0, inflow: 200 });
    expect(splitTotals([leg({ outflow: 300 }), leg({ inflow: 300 })])).toEqual({ outflow: 0, inflow: 0 });
    expect(splitTotals([])).toEqual({ outflow: 0, inflow: 0 });
  });
  test('splitTotalLabel', () => {
    expect(splitTotalLabel([leg({ outflow: 500 })], fmt.formatMoney)).toEqual({ text: `${fmt.formatMoney(500)} out`, zero: false });
    expect(splitTotalLabel([leg({ inflow: 500 })], fmt.formatMoney)).toEqual({ text: `${fmt.formatMoney(500)} in`, zero: false });
    expect(splitTotalLabel([leg()], fmt.formatMoney)).toEqual({ text: 'no amount', zero: true });
  });
  test('updateSplitLeg patches only the indexed leg', () => {
    const legs = [leg({ id: 'a' }), leg({ id: 'b' })];
    expect(updateSplitLeg(legs, 1, { memo: 'x' })).toEqual([leg({ id: 'a' }), leg({ id: 'b', memo: 'x' })]);
    expect(legs[1].memo).toBe('');
  });
  test('removeSplitLeg drops the leg; the last leg is replaced by a fresh empty one', () => {
    const legs = [leg({ id: 'a' }), leg({ id: 'b' })];
    expect(removeSplitLeg(legs, 0)).toEqual([leg({ id: 'b' })]);
    const only = removeSplitLeg([leg({ id: 'a', outflow: 5 })], 0);
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ categoryId: null, memo: '', outflow: 0, inflow: 0 });
    expect(only[0].id).not.toBe('a');
  });
});

describe('dates', () => {
  test('resolveDraftDate: parsed date, today when blank, null when unparseable', () => {
    expect(resolveDraftDate('05/03/2026', fmt.parseDateInput, TODAY)).toBe('2026-03-05');
    expect(resolveDraftDate('', fmt.parseDateInput, TODAY)).toBe(TODAY);
    expect(resolveDraftDate('   ', fmt.parseDateInput, TODAY)).toBe(TODAY);
    expect(resolveDraftDate('nonsense', fmt.parseDateInput, TODAY)).toBeNull();
  });
  test('draftMonthKey: the month the date lands in, today when there is none', () => {
    expect(draftMonthKey('2026-01-31', TODAY)).toBe(202601);
    expect(draftMonthKey(null, TODAY)).toBe(202603);
  });
  test('inlineRowDraft: an unparseable date is "" (always dirty), blank is today', () => {
    const base = { accountId: 'a1', payee: 'P', categoryId: null, memo: 'm', outflow: 5, inflow: 0 };
    expect(inlineRowDraft({ ...base, dateText: 'nonsense' }, fmt.parseDateInput, TODAY)).toEqual({
      accountId: 'a1', date: '', payee: 'P', categoryId: null, memo: 'm', outflowCents: 5, inflowCents: 0,
    });
    expect(inlineRowDraft({ ...base, dateText: '' }, fmt.parseDateInput, TODAY).date).toBe(TODAY);
    expect(inlineRowDraft({ ...base, dateText: '05/03/2026' }, fmt.parseDateInput, TODAY).date).toBe('2026-03-05');
  });
});

describe('USD drafts', () => {
  test('a "$" prefixed amount marks a USD draft on the non-zero side', () => {
    expect(usdDraftFromCommit(10000, 0, '$100')).toEqual({ cents: 10000, field: 'outflow' });
    expect(usdDraftFromCommit(0, 10000, '$100')).toEqual({ cents: 10000, field: 'inflow' });
  });
  test('zero on both sides counts as inflow', () => {
    expect(usdDraftFromCommit(0, 0, '$0')).toEqual({ cents: 0, field: 'inflow' });
  });
  test('plain or empty text clears the draft', () => {
    expect(usdDraftFromCommit(10000, 0, '100')).toBeNull();
    expect(usdDraftFromCommit(10000, 0, '')).toBeNull();
  });
  test('usdToLedger rounds to cents', () => {
    expect(usdToLedger({ cents: 10000, field: 'outflow' }, 5.4321)).toBe(54321);
    expect(usdToLedger({ cents: 333, field: 'inflow' }, 5.555)).toBe(1850);
  });
});

describe('planInlineSave', () => {
  const draft = (over: Partial<InlineDraft> = {}): InlineDraft => ({
    accountId: 'a1', dateText: '05/03/2026', payee: ' Shop ', categoryId: 'c1', memo: ' note ',
    outflow: 1250, inflow: 0, splitsOpen: false, splits: [leg({ categoryId: null })],
    repeatFreq: null, usd: null, convEdited: false, ...over,
  });
  const ctx = { parseDateInput: fmt.parseDateInput, today: TODAY, dateFormat: 'DD/MM/YYYY', rate: undefined as number | undefined, rateFetching: false };
  const plan = (over: Partial<InlineDraft> = {}, c: Partial<typeof ctx> = {}) => planInlineSave(draft(over), { ...ctx, ...c });

  test('a plain row: trimmed payee/memo, one-way amounts, no legs', () => {
    expect(plan()).toEqual({
      ok: true,
      fields: { accountId: 'a1', date: '2026-03-05', payee: 'Shop', categoryId: 'c1', memo: 'note', outflowCents: 1250, inflowCents: 0 },
      subtransactions: [],
    });
  });
  test('inflow wins when both sides are set', () => {
    expect(plan({ outflow: 5, inflow: 9 })).toMatchObject({ fields: { outflowCents: 0, inflowCents: 9 } });
  });
  test('a blank date saves as today', () => {
    expect(plan({ dateText: ' ' })).toMatchObject({ fields: { date: TODAY } });
  });
  test('errors, in order: amount, date, split category, split amounts', () => {
    expect(plan({ outflow: 0, dateText: 'nonsense' })).toEqual({ ok: false, error: 'enter an amount' });
    expect(plan({ dateText: 'nonsense' })).toEqual({ ok: false, error: 'invalid date — try DD/MM/YYYY or 5, 5/9' });
    expect(plan({ splitsOpen: true, splits: [leg({ outflow: 5 }), leg({ categoryId: null })] })).toEqual({ ok: false, error: 'every split needs a category' });
    expect(plan({ splitsOpen: true, splits: [leg(), leg()] })).toEqual({ ok: false, error: 'enter an amount on each split' });
  });
  test('legs of a closed panel are ignored, even for the amount check', () => {
    expect(plan({ outflow: 0, splits: [leg({ outflow: 5 })] })).toEqual({ ok: false, error: 'enter an amount' });
    expect(plan({ splits: [leg({ outflow: 5, categoryId: null })] })).toMatchObject({ ok: true, subtransactions: [] });
  });
  test('an open panel: the parent is the leg total with no category; zero legs are dropped', () => {
    const res = plan({
      outflow: 0,
      splitsOpen: true,
      splits: [leg({ id: 'a', outflow: 300, memo: 'x' }), leg({ id: 'b', categoryId: 'c2', inflow: 100 }), leg({ id: 'c' })],
    });
    expect(res).toEqual({
      ok: true,
      fields: { accountId: 'a1', date: '2026-03-05', payee: 'Shop', categoryId: null, memo: 'note', outflowCents: 200, inflowCents: 0 },
      subtransactions: [
        { categoryId: 'c1', memo: 'x', outflowCents: 300, inflowCents: 0 },
        { categoryId: 'c2', memo: '', outflowCents: 0, inflowCents: 100 },
      ],
    });
  });
  describe('scheduled USD draft', () => {
    const usd = { repeatFreq: 'monthly' as const, usd: { cents: 10000, field: 'outflow' as const }, outflow: 10000 };
    test('converts with the rate on the typed side', () => {
      expect(plan(usd, { rate: 5.5 })).toMatchObject({ fields: { outflowCents: 55000, inflowCents: 0 } });
      expect(plan({ ...usd, usd: { cents: 10000, field: 'inflow' }, outflow: 0, inflow: 10000 }, { rate: 5.5 })).toMatchObject({
        fields: { outflowCents: 0, inflowCents: 55000 },
      });
    });
    test('no rate yet: an error that depends on whether it is still loading', () => {
      expect(plan(usd, { rateFetching: true })).toEqual({ ok: false, error: 'fetching the USD→BRL rate — try again in a moment' });
      expect(plan(usd)).toEqual({ ok: false, error: 'no exchange rate available — enter the amount in R$ (without $)' });
    });
    test('an edited conversion, a non-repeating row, or split legs save as typed', () => {
      expect(plan({ ...usd, convEdited: true, outflow: 51234 })).toMatchObject({ fields: { outflowCents: 51234 } });
      expect(plan({ ...usd, repeatFreq: null })).toMatchObject({ fields: { outflowCents: 10000 } });
      expect(plan({ ...usd, splitsOpen: true, splits: [leg({ outflow: 700 })] })).toMatchObject({ fields: { outflowCents: 700 } });
    });
  });
});

describe('repeatRuleFields', () => {
  test('the rule mirrors the saved row and attaches to it', () => {
    const fields = { accountId: 'a1', date: '2026-03-05', payee: 'Shop', categoryId: 'c1', memo: 'n', outflowCents: 5, inflowCents: 0 };
    expect(repeatRuleFields(fields, 'monthly', 't9')).toEqual({
      accountId: 'a1', payee: 'Shop', categoryId: 'c1', memo: 'n', outflowCents: 5, inflowCents: 0,
      frequency: 'monthly', monthLastDay: false, attachTransactionId: 't9',
    });
  });
});
