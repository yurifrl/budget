import { describe, expect, test } from 'bun:test';

import { recomputeActivity, targetFundingState } from '../domain/engine';
import type { Category } from '../domain/types';
import { computeBudgetMonth } from '../domain/zeroSum';
import {
  assembleBudget,
  centsToMilli,
  mapCategoryTarget,
  milliToCents,
  monthKeyFromDate,
  monthKeyToDate,
  snakeSubTxn,
  snakeTxn,
  snakeTxnPatch,
  type BudgetSource,
  type TransactionInput,
} from './mapping';
import type { AccountRow, CategoryRow } from './rows';

const catRow = (over: Partial<CategoryRow>): CategoryRow => ({
  id: 'c1',
  group_id: 'g1',
  name: 'Cat',
  sort_order: 0,
  note: null,
  hidden: false,
  internal: false,
  deleted: false,
  goal_type: null,
  goal_needs_whole_amount: null,
  goal_day: null,
  goal_cadence: null,
  goal_cadence_frequency: null,
  goal_creation_month: null,
  goal_target: null,
  goal_target_date: null,
  goal_snoozed_at: null,
  user_id: null,
  ...over,
});

const acctRow = (over: Partial<AccountRow>): AccountRow => ({
  id: 'a1',
  name: 'Acct',
  type: 'checking',
  account_group: 'CASH',
  on_budget: true,
  closed: false,
  note: null,
  cleared_balance: 0,
  uncleared_balance: 0,
  transfer_payee_id: null,
  direct_import_linked: false,
  direct_import_in_error: false,
  connection_id: null,
  external_account_id: null,
  institution: null,
  user_id: null,
  last_reconciled_at: null,
  debt_interest_rates: null,
  debt_minimum_payments: null,
  debt_escrow_amounts: null,
  sort_order: 0,
  deleted: false,
  ...over,
});

describe('money / month conversions', () => {
  test('cents <-> milliunits round-trips at cent precision', () => {
    expect(centsToMilli(13145)).toBe(131450);
    expect(milliToCents(131450)).toBe(13145);
    expect(milliToCents(-4453690)).toBe(-445369);
  });

  test('month key <-> first-of-month date', () => {
    expect(monthKeyToDate(202606)).toBe('2026-06-01');
    expect(monthKeyFromDate('2026-06-01')).toBe(202606);
    expect(monthKeyFromDate('2026-06-13')).toBe(202606);
  });
});

describe('mapCategoryTarget', () => {
  test('no target when goal_type or goal_target is null', () => {
    expect(mapCategoryTarget(catRow({}))).toBeUndefined();
    expect(mapCategoryTarget(catRow({ goal_type: 'NEED' }))).toBeUndefined();
  });

  test('NEED monthly (cadence 1) -> monthly; weekly (cadence 2) -> weekly', () => {
    expect(
      mapCategoryTarget(catRow({ goal_type: 'NEED', goal_target: 10000, goal_cadence: 1 })),
    ).toEqual({ categoryId: 'c1', kind: 'monthly', amountCents: 1000, config: {} });
    expect(
      mapCategoryTarget(catRow({ goal_type: 'NEED', goal_target: 10000, goal_cadence: 2 })),
    ).toEqual({ categoryId: 'c1', kind: 'weekly', amountCents: 1000, config: {} });
  });

  test('yearly NEED (cadence 13) -> yearly; TBD -> custom by-date', () => {
    expect(
      mapCategoryTarget(
        catRow({ goal_type: 'NEED', goal_target: 800000, goal_cadence: 13, goal_target_date: '2026-12-01' }),
      ),
    ).toEqual({ categoryId: 'c1', kind: 'yearly', amountCents: 80000, config: {} });
    expect(
      mapCategoryTarget(
        catRow({ goal_type: 'TBD', goal_target: 800000, goal_target_date: '2026-06-30' }),
      ),
    ).toEqual({ categoryId: 'c1', kind: 'custom', amountCents: 80000, config: { byDate: '2026-06-30' } });
  });
});

/** The Casa seed: DB rows mirroring the seed rows. */
function casaSource(): BudgetSource {
  return {
    budget: { id: 'b-casa', name: 'Casa' },
    currentMonth: 202606,
    groups: [
      { id: 'g-mes', name: 'Mes', sort_order: 0, is_credit_card_payments: false, hidden: false, internal: false, deleted: false },
      { id: 'g-cc', name: 'Credit Card Payments', sort_order: 1, is_credit_card_payments: true, hidden: false, internal: true, deleted: false },
    ],
    categories: [
      catRow({ id: 'c-academia', group_id: 'g-mes', name: 'Academia', goal_type: 'NEED', goal_target: 120000, goal_cadence: 1 }),
      catRow({ id: 'c-comer-fora', group_id: 'g-mes', name: 'Comer Fora', sort_order: 1 }),
      catRow({ id: 'c-nubank', group_id: 'g-cc', name: 'Nubank Cartão' }),
    ],
    accounts: [
      acctRow({ id: 'a-itau', name: 'Itau', cleared_balance: 14996890, uncleared_balance: 55000 }),
      acctRow({ id: 'a-nubank', name: 'Nubank', type: 'creditCard', account_group: 'CREDIT', cleared_balance: -4453690 }),
    ],
    payees: [
      { id: 'p-smartfit', name: 'Smart Fit', transfer_account_id: null, deleted: false },
      { id: 'p-madero', name: 'Madero', transfer_account_id: null, deleted: false },
    ],
    transactions: [
      {
        id: 't1', account_id: 'a-itau', date: '2026-06-03', amount: -120000, payee_id: 'p-smartfit', category_id: 'c-academia',
        memo: null, cleared: 'cleared', approved: true, flag_color: null, flag_name: null, transfer_account_id: null,
        transfer_transaction_id: null, matched_transaction_id: null, import_id: null, import_payee_name: null,
        import_payee_name_original: null, debt_transaction_type: null, repeat: 'monthly', upcoming: false, deleted: false,
        repeat_rule_id: null, occurrence_date: null,
      },
      {
        id: 't2', account_id: 'a-nubank', date: '2026-06-11', amount: -90000, payee_id: 'p-madero', category_id: 'c-comer-fora',
        memo: null, cleared: 'cleared', approved: true, flag_color: null, flag_name: null, transfer_account_id: null,
        transfer_transaction_id: null, matched_transaction_id: null, import_id: null, import_payee_name: null,
        import_payee_name_original: null, debt_transaction_type: null, repeat: 'never', upcoming: false, deleted: false,
        repeat_rule_id: null, occurrence_date: null,
      },
    ],
    assignments: [
      { month: '2026-06-01', category_id: 'c-academia', budgeted: 120000 },
      { month: '2026-06-01', category_id: 'c-comer-fora', budgeted: 50000 },
    ],
    monthNotes: [{ month: '2026-06-01', note: 'nota' }],
  };
}

describe('assembleBudget', () => {
  const budget = assembleBudget(casaSource());
  const byId = new Map(budget.categories.map((c) => [c.id, c]));

  test('groups own their categories; flags map through', () => {
    expect(budget.groups[0].categoryIds).toEqual(['c-academia', 'c-comer-fora']);
    expect(budget.groups[1].isCreditCardPayments).toBe(true);
  });

  test('bundles and bundle_id map through (default [])', () => {
    expect(budget.bundles).toEqual([]);
    expect(byId.get('c-academia')?.bundleId).toBeUndefined();
    const src = casaSource();
    src.bundles = [{ id: 'b-1', group_id: src.groups[0].id, name: 'Fitness' }];
    src.categories = src.categories.map((c) => (c.id === 'c-academia' ? { ...c, bundle_id: 'b-1' } : c));
    const mapped = assembleBudget(src);
    expect(mapped.bundles).toEqual([{ id: 'b-1', groupId: src.groups[0].id, name: 'Fitness' }]);
    expect(mapped.categories.find((c) => c.id === 'c-academia')?.bundleId).toBe('b-1');
  });

  test('account user_id maps to userId (null = Shared)', () => {
    const src = casaSource();
    src.accounts = [
      acctRow({ id: 'a-itau', user_id: 'u-ana' }),
      acctRow({ id: 'a-nubank', type: 'creditCard', account_group: 'CREDIT' }),
    ];
    const accts = assembleBudget(src).accounts;
    expect(accts.find((a) => a.id === 'a-itau')!.userId).toBe('u-ana');
    expect(accts.find((a) => a.id === 'a-nubank')!.userId).toBeNull();
  });

  test('a plain transaction has no splits (an empty array would hide it from the engine)', () => {
    expect(budget.transactions.every((t) => t.splits === undefined)).toBe(true);
    expect(computeBudgetMonth(budget, 202606).categories['c-academia'].activity).toBe(-12000);
  });

  test('payee_id resolves to name; signed amount splits into outflow/inflow (cents)', () => {
    const t1 = budget.transactions.find((t) => t.id === 't1')!;
    expect(t1.payee).toBe('Smart Fit');
    expect(t1.outflow).toBe(12000);
    expect(t1.inflow).toBe(0);
  });

  test('API timestamps normalize to the YYYY-MM-DD domain date contract', () => {
    const src = casaSource();
    // The API serializes the DATE column through a JS Date (server TZ -03:00).
    src.transactions = src.transactions.map((t) => ({ ...t, date: `${t.date}T03:00:00.000Z` }));
    const dates = assembleBudget(src).transactions.map((t) => t.date);
    expect(dates).toEqual(['2026-06-03', '2026-06-11']);
  });

  test('activity is derived from transactions, not stored rows', () => {
    // The display cache on Category (never read by the engine) and the engine's own figure agree.
    expect(byId.get('c-academia')!.activity[202606]).toBe(-12000);
    expect(byId.get('c-comer-fora')!.activity[202606]).toBe(-9000);
    const bm = computeBudgetMonth(budget, 202606);
    expect(bm.categories['c-academia'].activity).toBe(-12000);
    expect(bm.categories['c-comer-fora'].activity).toBe(-9000);
  });

  test('months cover assignments + transactions + the focused month', () => {
    expect(budget.months).toEqual([202606]);
    expect(budget.monthNotes![202606]).toBe('nota');
  });

  test('engine derivations work over the assembled aggregate', () => {
    // The ledger holds no opening money (no Starting Balance row, L1), so RTA is
    // just the assignments: -(12000 academia + 5000 comer fora) = -17000. Comer
    // Fora (assigned 5000) spent 9000 on the CARD: available -4000, all of it
    // credit overspending, so the pill is the credit state, not red (S5).
    const bm = computeBudgetMonth(budget, 202606);
    expect(bm.readyToAssign).toBe(-17000);
    expect(bm.categories['c-comer-fora']).toMatchObject({ available: -4000, cashOverspend: 0, creditOverspend: 4000 });
    expect(targetFundingState(byId.get('c-comer-fora') as Category, bm).state).toBe('credit');
    // "Nubank Cartão" is the only card's payment category (resolved although the names differ):
    // funded 5000 (9000 - 4000 credit), no payments, debt 9000 (the ledger), underfunded 4000.
    expect(bm.payments['c-nubank']).toMatchObject({
      accountId: 'a-nubank',
      funded: 5000,
      payments: 0,
      available: 5000,
      debt: 9000,
      underfunded: 4000,
    });
  });
});

describe('transfer links (spec T1)', () => {
  const transferTxn = (over: Record<string, unknown>) => ({
    ...casaSource().transactions[0],
    category_id: null,
    ...over,
  });
  const map = (rows: Record<string, unknown>[], payees = casaSource().payees) => {
    const src = casaSource();
    src.payees = payees;
    src.transactions = rows as unknown as BudgetSource['transactions'];
    return assembleBudget(src).transactions;
  };

  test('transfer_account_id from the wire row becomes transferAccountId', () => {
    const [t] = map([transferTxn({ id: 'x1', payee_id: null, payee_name: 'Whatever', transfer_account_id: 'a-nubank' })]);
    expect(t.transferAccountId).toBe('a-nubank');
  });

  test('legacy "Transfer : <account name>" payee resolves to the account id when the column is null', () => {
    const [t] = map([transferTxn({ id: 'x2', payee_id: 'p-tr', transfer_account_id: null })], [
      { id: 'p-tr', name: 'Transfer : Nubank', transfer_account_id: null, deleted: false },
    ]);
    expect(t.transferAccountId).toBe('a-nubank');
    const [byName] = map([transferTxn({ id: 'x3', account_id: 'a-nubank', payee_id: null, payee_name: 'Transfer :   itau', transfer_account_id: null })]);
    expect(byName.transferAccountId).toBe('a-itau'); // case-insensitive, whitespace-tolerant
  });

  test('the wire column wins over the payee convention', () => {
    const [t] = map([transferTxn({ id: 'x4', payee_name: 'Transfer : Itau', account_id: 'a-itau', transfer_account_id: 'a-nubank' })]);
    expect(t.transferAccountId).toBe('a-nubank');
  });

  test('ordinary payees, unknown names and the own account are not transfers (null)', () => {
    const rows = map([
      transferTxn({ id: 'y1', payee_id: 'p-smartfit', transfer_account_id: null }),
      transferTxn({ id: 'y2', payee_id: null, payee_name: 'Transfer : Nowhere', transfer_account_id: null }),
      transferTxn({ id: 'y3', payee_id: null, payee_name: 'Transfer : Itau', account_id: 'a-itau', transfer_account_id: null }),
    ]);
    expect(rows.map((t) => t.transferAccountId)).toEqual([null, null, null]);
  });

  test('a pair of legacy "Transfer : ..." rows is a card payment for the engine', () => {
    const src = casaSource();
    src.transactions = [
      transferTxn({ id: 'p1', account_id: 'a-itau', amount: -50000, payee_name: 'Transfer : Nubank', date: '2026-06-10' }),
      transferTxn({ id: 'p2', account_id: 'a-nubank', amount: 50000, payee_name: 'Transfer : Itau', date: '2026-06-10' }),
    ] as unknown as BudgetSource['transactions'];
    const bm = computeBudgetMonth(assembleBudget(src), 202606);
    // Paid 5000 to the card; no budget effect on Ready to Assign (T3), payment Available -5000 (P2).
    expect(bm.payments['c-nubank']).toMatchObject({ payments: 5000, available: -5000, debt: 0 });
    expect(bm.readyToAssign).toBe(-17000);
  });
});

describe('snakeTxn / snakeTxnPatch (POST/PATCH wire mapping)', () => {
  const fullInput: TransactionInput = {
    accountId: 'acc-1',
    date: '2026-06-11',
    payee: 'Casa',
    categoryId: 'c1',
    memo: 'coffee',
    outflowCents: 1200,
    inflowCents: 0,
    cleared: 'uncleared',
    approved: false,
    flag: null,
    repeat: 'never',
  };

  test('snakeTxn maps the full POST body with server-side defaults', () => {
    expect(snakeTxn(fullInput)).toEqual({
      account_id: 'acc-1',
      date: '2026-06-11',
      payee: 'Casa',
      category_id: 'c1',
      memo: 'coffee',
      outflow: 12000,
      inflow: 0,
      cleared: 'uncleared',
      approved: false,
      flag: null,
      repeat: 'never',
    });
  });

  test('snakeTxnPatch sends ONLY the edited keys — partial patch must not wipe untouched fields', () => {
    // The regression: editing just the memo used to route through snakeTxn,
    // which defaults payee to '' (clearing payee_id), amounts to 0 and flag to
    // null. The server PATCH treats every present key as explicit intent.
    expect(snakeTxnPatch({ memo: 'new memo' })).toEqual({ memo: 'new memo' });
  });

  test('snakeTxnPatch with an empty patch sends an empty body', () => {
    expect(snakeTxnPatch({})).toEqual({});
  });

  test('snakeTxnPatch keeps explicit clearing intent (empty payee, null flag)', () => {
    expect(snakeTxnPatch({ payee: '', flag: null })).toEqual({ payee: '', flag: null });
  });

  test('snakeTxnPatch renames camelCase keys to the snake_case server columns', () => {
    expect(
      snakeTxnPatch({
        accountId: 'acc-2',
        categoryId: null,
        outflowCents: 500,
        inflowCents: 700,
      }),
    ).toEqual({
      account_id: 'acc-2',
      category_id: null,
      outflow: 5000,
      inflow: 7000,
    });
  });

  test('snakeSubTxn maps one-way cents legs to the milliunit wire (syscd-app-rlt)', () => {
    expect(snakeSubTxn({ categoryId: 'c1', memo: 'leg', outflowCents: 2000, inflowCents: 0 })).toEqual({
      category_id: 'c1',
      memo: 'leg',
      outflow: 20000,
      inflow: 0,
    });
    expect(snakeSubTxn({ categoryId: null, memo: '', outflowCents: 0, inflowCents: 700 })).toEqual({
      category_id: null,
      memo: null,
      outflow: 0,
      inflow: 7000,
    });
  });
});

describe('split transactions (syscd-app-rlt)', () => {
  test('subtransaction rows map to per-leg splits; activity attributes per leg', () => {
    const src = casaSource();
    src.transactions = [
      {
        ...src.transactions[0],
        id: 't-split',
        category_id: null,
        amount: -30000,
        subtransactions: [
          {
            id: 's1', transaction_id: 't-split', amount: -20000, memo: 'produce', payee_id: null,
            category_id: 'c-academia', transfer_account_id: null, transfer_transaction_id: null, deleted: false,
          },
          {
            id: 's2', transaction_id: 't-split', amount: -10000, memo: null, payee_id: null,
            category_id: 'c-comer-fora', transfer_account_id: null, transfer_transaction_id: null, deleted: false,
          },
        ],
      },
    ];
    const budget = assembleBudget(src);
    const split = budget.transactions.find((t) => t.id === 't-split')!;
    expect(split.splits).toEqual([
      { id: 's1', categoryId: 'c-academia', memo: 'produce', outflow: 2000, inflow: 0 },
      { id: 's2', categoryId: 'c-comer-fora', memo: '', outflow: 1000, inflow: 0 },
    ]);
    // Each leg lands on its own category; the parent (null category) contributes nothing.
    expect(recomputeActivity(budget)['c-academia'][202606]).toBe(-2000);
    expect(recomputeActivity(budget)['c-comer-fora'][202606]).toBe(-1000);
  });
});
