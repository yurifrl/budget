/** Pure rules of the transfer payee lifecycle: names, the canonical pick, and the repair plan. */
import { describe, expect, test } from 'bun:test';

import type { AccountPayeeRow, PayeeFullRow } from '../store/transfer-payees';
import { planTransferPayeeRepair } from './transfer-payee-repair';
import { isTransferPayeeNameFor, pickCanonical, transferPayeeCandidate } from './transfer-payees';

const account = (id: string, name: string, pointer: string | null = null): AccountPayeeRow => ({
  id,
  budget_id: 'b',
  name,
  deleted: false,
  closed: false,
  transfer_payee_id: pointer,
  created_at: '2026-01-01',
});
const payee = (id: string, name: string, accountId: string | null = null, over: Partial<PayeeFullRow> = {}): PayeeFullRow => ({
  id,
  budget_id: 'b',
  name,
  deleted: false,
  hidden: false,
  transfer_account_id: accountId,
  created_at: '2026-01-01',
  rename_match_type: null,
  rename_condition: null,
  transfer_rule: null,
  ...over,
});

describe('transfer payee names', () => {
  test('the first claimant gets the plain name, later ones a number', () => {
    expect(transferPayeeCandidate('Nubank', 1)).toBe('Transfer : Nubank');
    expect(transferPayeeCandidate('Nubank', 2)).toBe('Transfer : Nubank (2)');
  });

  test('a payee name fits its account when it is the plain or a numbered name', () => {
    expect(isTransferPayeeNameFor('Transfer : Nubank', 'Nubank')).toBe(true);
    expect(isTransferPayeeNameFor('Transfer : Nubank (3)', 'Nubank')).toBe(true);
    expect(isTransferPayeeNameFor('Transfer : Old Name', 'Nubank')).toBe(false);
    expect(isTransferPayeeNameFor('Transfer : Nubank Roxinho', 'Nubank')).toBe(false);
  });
});

describe('pickCanonical', () => {
  const rows = [
    { id: 'a', deleted: true },
    { id: 'b', deleted: false },
    { id: 'c', deleted: false },
  ];
  test('the account pointer wins when it is live, else the oldest live, else a retired one', () => {
    expect(pickCanonical('c', rows)?.id).toBe('c');
    expect(pickCanonical('a', rows)?.id).toBe('b');
    expect(pickCanonical(null, rows)?.id).toBe('b');
    expect(pickCanonical('a', [rows[0]!])?.id).toBe('a');
    expect(pickCanonical(null, [])).toBeUndefined();
  });
});

describe('planTransferPayeeRepair', () => {
  const plan = (accounts: AccountPayeeRow[], payees: PayeeFullRow[], counts: [string, number][] = []) =>
    planTransferPayeeRepair({ budgetId: 'b', accounts, payees, transactionCounts: new Map(counts) });

  test('a healthy budget has nothing to do', () => {
    const report = plan([account('a1', 'One', 'p1'), account('a2', 'Two', 'p2')], [payee('p1', 'Transfer : One', 'a1'), payee('p2', 'Transfer : Two', 'a2')]);
    expect(report.actions).toEqual([]);
    expect(report.payees_removed).toBe(0);
  });

  test('duplicates keep the pointed payee, count the rows and rules that move, and rename it', () => {
    const report = plan(
      [account('a1', 'New', 'old')],
      [
        payee('old', 'Transfer : Old', 'a1'),
        payee('new', 'Transfer : New', 'a1', { rename_match_type: 'contains', rename_condition: 'X' }),
      ],
      [['new', 4]],
    );
    expect(report).toMatchObject({
      accounts_with_duplicates: 1,
      payees_removed: 1,
      transactions_repointed: 4,
      rename_rules_moved: 1,
      rename_rules_dropped: 0,
      payees_renamed: 1,
    });
    expect(report.actions[0]).toMatchObject({ canonical_payee_id: 'old', extra_payee_ids: ['new'], rename: true });
  });

  test('a name-only payee is adopted by its one account and left alone when two accounts share the name', () => {
    const adopt = plan([account('a1', 'Solo')], [payee('p', 'Transfer : Solo')]);
    expect(adopt.actions[0]).toMatchObject({ canonical_payee_id: 'p', adopt: true, fix_pointer: true });
    expect(adopt.name_only_payees).toBe(1);

    const shared = plan([account('a1', 'Twin'), account('a2', 'Twin')], [payee('p', 'Transfer : Twin')]);
    expect(shared.ambiguous_name_only_payees).toBe(1);
    expect(shared.actions.map((a) => a.canonical_payee_id)).toEqual([null, null]);
  });

  test('a payee linked to an account of another budget is treated as name-only', () => {
    const report = plan([account('a1', 'Mine')], [payee('p', 'Transfer : Mine', 'foreign')]);
    expect(report.actions[0]).toMatchObject({ canonical_payee_id: 'p', adopt: true });
  });

  test('a retired payee is revived, and an account with none gets a created one', () => {
    const report = plan([account('a1', 'One', 'p1'), account('a2', 'Two')], [payee('p1', 'Transfer : One', 'a1', { deleted: true })]);
    expect(report.actions.find((a) => a.account_id === 'a1')).toMatchObject({ revive: true });
    expect(report.actions.find((a) => a.account_id === 'a2')).toMatchObject({ canonical_payee_id: null });
    expect(report.accounts_without_payee).toBe(1);
  });

  test('a numbered name is normalised once the plain name is free, and kept while another payee holds it', () => {
    const free = plan([account('a1', 'Solo', 'p2')], [payee('p2', 'Transfer : Solo (2)', 'a1')]);
    expect(free.actions[0]).toMatchObject({ rename: true });

    const held = plan(
      [account('a1', 'Twin', 'p1'), account('a2', 'Twin', 'p2')],
      [payee('p1', 'Transfer : Twin', 'a1'), payee('p2', 'Transfer : Twin (2)', 'a2')],
    );
    expect(held.actions).toEqual([]);
  });

  test('every dropped rule is listed with its payee and the payee that kept its own', () => {
    const report = plan(
      [account('a1', 'One', 'keep')],
      [
        payee('keep', 'Transfer : One', 'a1', { rename_match_type: 'is', rename_condition: 'A', transfer_rule: 'auto' }),
        payee('lost', 'Transfer : One Old', 'a1', { rename_match_type: 'contains', rename_condition: 'B', transfer_rule: 'never' }),
      ],
    );
    expect(report.dropped_rules.map((r) => [r.kind, r.payee_id, r.detail, r.kept_payee_id])).toEqual([
      ['rename_rule', 'lost', 'contains "B"', 'keep'],
      ['transfer_rule', 'lost', 'never', 'keep'],
    ]);
  });
});
