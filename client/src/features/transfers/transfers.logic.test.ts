import { describe, expect, test } from 'bun:test';

import type { TransferSuggestion } from '@/budget/data/api';
import type { Transaction } from '@/domain/types';
import {
  allSelected,
  bulkSummary,
  chipCounts,
  filterByChip,
  findSuggestion,
  linkedToast,
  matchKind,
  popoverSides,
  reviewRow,
  ruleReason,
  selectAllRows,
  scopeSuggestions,
  whyLine,
} from './transfers.logic';

const leg = (id: string, account: string, amount: number, over: Partial<TransferSuggestion['leg']> = {}) => ({
  transaction_id: id,
  account_id: account,
  account_name: account === 'itau' ? 'Itau Conta' : account === 'nu' ? 'Nubank Conta' : 'Nubank Cartão',
  date: '2026-11-03',
  amount,
  payee_name: `payee ${id}`,
  bank_label: null,
  untouched: true,
  ...over,
});
const cand = (id: string, account: string, amount: number, over: Partial<TransferSuggestion['candidates'][number]> = {}) => ({
  ...leg(id, account, amount),
  days_apart: 0,
  ...over,
});

const sure: TransferSuggestion = {
  id: 'o1',
  confidence: 'sure',
  basis: 'unique',
  leg: leg('o1', 'itau', -3_000_000, { bank_label: 'Same person transfer' }),
  candidates: [cand('i1', 'nu', 3_000_000, { bank_label: 'Same person transfer' })],
};
const choose: TransferSuggestion = {
  id: 'o2',
  confidence: 'choose',
  basis: 'ambiguous',
  leg: leg('o2', 'itau', -100_000, { date: '2026-10-21' }),
  candidates: [cand('i2', 'nu', 100_000), cand('i3', 'card', 100_000, { days_apart: 1, date: '2026-10-22' })],
};
const oneSide: TransferSuggestion = {
  id: 'o3',
  confidence: 'one_side',
  basis: 'unmatched',
  leg: leg('o3', 'itau', -800_000, { bank_label: 'Same person transfer', date: '2026-10-18' }),
  candidates: [],
};

const tx = (over: Partial<Transaction>): Transaction =>
  ({
    id: 'x',
    accountId: 'itau',
    date: '2026-11-03',
    payee: 'p',
    categoryId: null,
    memo: '',
    outflow: 100,
    inflow: 0,
    cleared: 'cleared',
    approved: true,
    repeat: 'never',
    upcoming: false,
    ...over,
  }) as Transaction;

describe('register chips', () => {
  const rows = [
    tx({ id: 'a' }),
    tx({ id: 'b', categoryId: 'c' }),
    tx({ id: 'c', transferAccountId: 'nu' }),
    tx({ id: 'd', transferPending: 'waiting' }),
    tx({ id: 'e', upcoming: true }),
  ];
  const needs = (t: Transaction) => !t.categoryId && !t.transferAccountId && !t.transferPending;
  test('counts needs-category and transfers (upcoming rows excluded) and takes suggestions from the list', () => {
    expect(chipCounts(rows, needs, [sure, choose])).toEqual({ needsCategory: 1, suggested: 2, transfers: 2 });
  });
  test('filters rows per chip', () => {
    expect(filterByChip(rows, 'needsCategory', needs).map((r) => r.id)).toEqual(['a', 'e']);
    expect(filterByChip(rows, 'transfers', needs).map((r) => r.id)).toEqual(['c', 'd']);
    expect(filterByChip(rows, 'all', needs)).toHaveLength(5);
  });
  test('account scope keeps suggestions touching the account', () => {
    expect(scopeSuggestions([sure, choose, oneSide], 'card').map((s) => s.id)).toEqual(['o2']);
    expect(scopeSuggestions([sure, choose, oneSide], null)).toHaveLength(3);
  });
});

describe('popover', () => {
  test('a row finds its suggestion as subject or as the proposed other side', () => {
    expect(findSuggestion([sure, choose], 'o1')?.id).toBe('o1');
    expect(findSuggestion([sure, choose], 'i1')?.id).toBe('o1');
    expect(findSuggestion([sure, choose], 'i3')?.id).toBe('o2');
    expect(findSuggestion([sure], 'zzz')).toBeUndefined();
  });
  test('sure pair: outflow first, link from the tapped row', () => {
    const fromIn = popoverSides(sure, 'i1');
    expect(fromIn.from?.transaction_id).toBe('o1');
    expect(fromIn.to?.transaction_id).toBe('i1');
    expect(fromIn.link).toEqual({ transaction_id: 'i1', counterpart_id: 'o1' });
  });
  test('several candidates: nothing to link until one is picked', () => {
    expect(popoverSides(choose, 'o2').link).toBeNull();
    expect(popoverSides(choose, 'o2').choices).toHaveLength(2);
    expect(popoverSides(choose, 'o2', 'i3').link).toEqual({ transaction_id: 'o2', counterpart_id: 'i3' });
  });
  test('one side: no other row', () => {
    const s = popoverSides(oneSide, 'o3');
    expect(s.to).toBeNull();
    expect(s.link).toBeNull();
  });
  test('why line names the distance, the bank labels and the basis', () => {
    expect(whyLine(sure, popoverSides(sure, 'o1'))).toBe('Why: same amount, same day · Pluggy says "Same person transfer" on both sides · only candidate');
    const edited = { ...sure, leg: { ...sure.leg, untouched: false, bank_label: null } };
    expect(whyLine(edited, popoverSides(edited, 'o1'))).toBe(
      'Why: same amount, same day · Pluggy says "Same person transfer" · only candidate · edited after import, so not linked on its own',
    );
    expect(whyLine(choose, popoverSides(choose, 'o2', 'i3'))).toBe('Why: same amount, 1 day apart · 2 possible matches');
    expect(whyLine(oneSide, popoverSides(oneSide, 'o3'))).toBe('Why: Pluggy says "Same person transfer" · no matching row in your accounts');
  });
});

describe('refused suggestions (account rules)', () => {
  const refusedSure: TransferSuggestion = {
    id: 'r1',
    confidence: 'sure',
    basis: 'refused',
    leg: leg('r1', 'itau', -250_000),
    candidates: [cand('r2', 'card', 250_000, { rule: 'card_payment_other_bank' })],
  };
  const refusedChoose: TransferSuggestion = {
    id: 'r3',
    confidence: 'choose',
    basis: 'refused',
    leg: leg('r3', 'card', -90_000),
    candidates: [cand('r4', 'nu', 90_000, { rule: 'card_outflow' }), cand('r5', 'itau', 90_000, { rule: 'cash_same_bank' })],
  };
  test('a lone refused pair is "confirm", never "sure"; a sure pair stays sure', () => {
    expect(matchKind(refusedSure)).toBe('confirm');
    expect(matchKind(sure)).toBe('sure');
    expect(matchKind(refusedChoose)).toBe('choose');
    expect(reviewRow(refusedSure)).toMatchObject({ match: 'confirm', link: { transaction_id: 'r1', counterpart_id: 'r2' }, reason: 'card paid from another bank' });
    expect(reviewRow(refusedChoose).reason).toBe('a card cannot pay a transfer / same bank, checking to checking');
    expect(reviewRow(sure).reason).toBeNull();
  });
  test('the why line names the broken rule instead of "no matching row"', () => {
    expect(whyLine(refusedSure, popoverSides(refusedSure, 'r1'))).toBe('Why: same amount, same day · card paid from another bank');
    expect(whyLine(refusedChoose, popoverSides(refusedChoose, 'r3'))).toBe('Why: a card cannot pay a transfer / same bank, checking to checking');
    expect(whyLine(refusedChoose, popoverSides(refusedChoose, 'r3', 'r5'))).toBe('Why: same amount, same day · same bank, checking to checking');
  });
  test('a refused pair never says it was edited after import', () => {
    const edited: TransferSuggestion = { ...refusedSure, leg: leg('r1', 'itau', -250_000, { untouched: false }) };
    expect(whyLine(edited, popoverSides(edited, 'r1'))).toBe('Why: same amount, same day · card paid from another bank');
  });
  test('an unknown rule falls back to the generic reason, never an empty part', () => {
    const unknown = { ...refusedSure, candidates: [cand('r2', 'card', 250_000, { rule: 'brand_new' as never })] };
    expect(ruleReason('brand_new' as never)).toBe('the account rules do not link it on their own');
    expect(whyLine(unknown, popoverSides(unknown, 'r1'))).toBe('Why: same amount, same day · the account rules do not link it on their own');
    expect(reviewRow(unknown).reason).toBe('the account rules do not link it on their own');
  });
  test('the list shows the reason of refused candidates on a suggestion that is not refused itself', () => {
    const mixed: TransferSuggestion = { ...choose, candidates: [choose.candidates[0], { ...choose.candidates[1], rule: 'card_outflow' }] };
    expect(reviewRow(mixed).reason).toBe('a card cannot pay a transfer');
    expect(reviewRow(choose).reason).toBeNull();
  });
  test('Select all skips refused pairs but keeps one ticked by hand; the bulk bar counts it', () => {
    const rows = [reviewRow(sure), reviewRow(refusedSure), reviewRow(choose)];
    expect(rows.map((r) => r.needsConfirm)).toEqual([false, true, false]);
    expect([...selectAllRows(rows, new Set())]).toEqual(['o1', 'o2']);
    expect([...selectAllRows(rows, new Set(['r1']))].sort()).toEqual(['o1', 'o2', 'r1']);
    expect(allSelected(rows, new Set(['o1']))).toBe(false);
    expect(allSelected(rows, new Set(['o1', 'o2']))).toBe(true);
    expect(allSelected([reviewRow(refusedSure)], new Set())).toBe(false);
    const all = bulkSummary(rows.filter((r) => selectAllRows(rows, new Set()).has(r.id)));
    expect(all.needConfirm).toBe(0);
    expect(all.links).toEqual([{ transaction_id: 'o1', counterpart_id: 'i1' }]);
    const hand = bulkSummary(rows.filter((r) => r.id === 'r1' || r.id === 'o1'));
    expect(hand.needConfirm).toBe(1);
    expect(hand.links).toContainEqual({ transaction_id: 'r1', counterpart_id: 'r2' });
  });
  test('a pick that breaks a rule adds its reason after the usual basis', () => {
    const mixed: TransferSuggestion = { ...choose, candidates: [choose.candidates[0], { ...choose.candidates[1], rule: 'card_outflow' }] };
    expect(whyLine(mixed, popoverSides(mixed, 'o2', 'i3'))).toBe('Why: same amount, 1 day apart · 2 possible matches · a card cannot pay a transfer');
  });
});

describe('review list and bulk bar', () => {
  test('rows: sure has a link and dismisses both legs; choose waits for a pick; one side has no target', () => {
    expect(reviewRow(sure)).toMatchObject({ match: 'sure', amount: 300_000, link: { transaction_id: 'o1', counterpart_id: 'i1' }, dismissIds: ['o1', 'i1'] });
    expect(reviewRow(choose)).toMatchObject({ match: 'choose', link: null, dismissIds: ['o2'] });
    expect(reviewRow(choose).choices).toHaveLength(2);
    expect(reviewRow(choose, 'i2').choices).toHaveLength(0);
    expect(reviewRow(oneSide)).toMatchObject({ match: 'oneSide', to: null, link: null });
  });
  test('summary: totals out / in and only the links that can be sent', () => {
    const s = bulkSummary([reviewRow(sure), reviewRow(choose), reviewRow(oneSide)]);
    expect(s.count).toBe(3);
    expect(s.out).toBe(300_000 + 10_000 + 80_000);
    expect(s.in).toBe(300_000);
    expect(s.links).toEqual([{ transaction_id: 'o1', counterpart_id: 'i1' }]);
    expect(s.dismissIds).toEqual(['o1', 'i1', 'o2', 'o3']);
  });
  test('toast text', () => {
    expect(linkedToast({ linked: ['a', 'b', 'c', 'd', 'e', 'f'] }, { saved: true })).toBe('3 linked as transfers · rule saved');
    expect(linkedToast({ linked: ['a', 'b'] })).toBe('1 linked as transfer');
    expect(linkedToast({ linked: ['a', 'b'] }, { saved: false })).toBe('1 linked as transfer');
    expect(linkedToast({ linked: ['a', 'b'] }, { saved: false, message: 'Too short' })).toBe('1 linked as transfer · Too short');
  });
});
