/**
 * Backup round trip from DB-shaped rows: rows -> assembleBudget -> real export
 * (buildTransferZip) -> real import parse (parseTransferFiles).
 *
 * Starts at the API row shapes on purpose: the two historical losses lived
 * upstream of the transfer codec.
 *   1. GET /payees omits transfer payees, so a transfer leg's payee_id could not
 *      be resolved to a name and exported as an empty payee.
 *   2. Accounts only exist in the register through their transactions, and a
 *      working-balance override lives on the account row (not the ledger), so a
 *      row-less account (or an override) vanished from the backup.
 * Synthetic data only.
 */

import { describe, expect, test } from 'bun:test';

import { assembleBudget, type BudgetSource } from '@/budget/data/mapping';
import type { AccountRow, TransactionRow } from '@/budget/data/rows';
import { buildTransferZip, parseTransferFiles } from './transfer';

const NOW = new Date(2026, 10, 16, 10, 0);

const acct = (over: Partial<AccountRow>): AccountRow => ({
  id: 'a', name: 'A', type: 'checking', account_group: 'CASH', on_budget: true, closed: false,
  note: null, cleared_balance: 0, uncleared_balance: 0, transfer_payee_id: null,
  direct_import_linked: false, direct_import_in_error: false, connection_id: null,
  external_account_id: null, institution: null, user_id: null, last_reconciled_at: null,
  debt_interest_rates: null, debt_minimum_payments: null, debt_escrow_amounts: null,
  sort_order: 0, deleted: false, ...over,
});

const row = (over: Partial<TransactionRow>): TransactionRow => ({
  id: 't', account_id: 'a-main', date: '2026-11-10', amount: 0, payee_id: null, category_id: null,
  memo: null, cleared: 'uncleared', approved: true, flag_color: null, flag_name: null,
  transfer_account_id: null, transfer_transaction_id: null, matched_transaction_id: null,
  import_id: null, import_payee_name: null, import_payee_name_original: null,
  debt_transaction_type: null, repeat: 'never', repeat_rule_id: null, occurrence_date: null,
  subtransactions: [], upcoming: false, deleted: false, ...over,
});

/** Milliunits for a cents amount. */
const m = (cents: number) => cents * 10;

function source(): BudgetSource {
  return {
    budget: { id: 'b1', name: 'Home' },
    currentMonth: 202611,
    groups: [{ id: 'g1', name: 'Everyday', sort_order: 0, is_credit_card_payments: false, hidden: false, internal: false, deleted: false }],
    categories: [
      { id: 'c-food', group_id: 'g1', name: 'Food', sort_order: 0, note: null, hidden: false, internal: false, deleted: false, goal_type: null, goal_needs_whole_amount: null, goal_day: null, goal_cadence: null, goal_cadence_frequency: null, goal_creation_month: null, goal_target: null, goal_target_date: null, goal_snoozed_at: null, user_id: null },
      { id: 'c-bus', group_id: 'g1', name: 'Transit', sort_order: 1, note: null, hidden: false, internal: false, deleted: false, goal_type: null, goal_needs_whole_amount: null, goal_day: null, goal_cadence: null, goal_cadence_frequency: null, goal_creation_month: null, goal_target: null, goal_target_date: null, goal_snoozed_at: null, user_id: null },
    ],
    accounts: [
      // Ledger: +1000.00 -300.00 (transfer out) -50.00 -> 650.00
      acct({ id: 'a-main', name: 'Main Checking', cleared_balance: m(65000), sort_order: 0 }),
      // Ledger: +300.00 transfer in, balance matches.
      acct({ id: 'a-save', name: 'Savings', cleared_balance: m(30000), sort_order: 1 }),
      // No ledger rows at all; balance set by a working-balance override.
      acct({ id: 'a-empty', name: 'Old Wallet', uncleared_balance: m(12345), sort_order: 2 }),
      // Override on top of a ledger: ledger +100.00, stored balance 140.00.
      acct({ id: 'a-over', name: 'Overridden', cleared_balance: m(10000), uncleared_balance: m(4000), sort_order: 3 }),
      // Genuinely empty, zero balance: must still exist after a restore.
      acct({ id: 'a-zero', name: 'Zero Account', sort_order: 4 }),
    ],
    // GET /payees never lists transfer payees (transfer_account_id IS NOT NULL).
    payees: [{ id: 'p-shop', name: 'Corner Shop', transfer_account_id: null, deleted: false }],
    transactions: [
      row({ id: 't-open', date: '2026-11-01', amount: m(100000), payee_name: 'Starting Balance', payee_id: 'p-start', cleared: 'reconciled' }),
      row({ id: 't-out', date: '2026-11-05', amount: m(-30000), payee_id: 'p-tr-save', payee_name: 'Transfer : Savings', cleared: 'cleared', transfer_account_id: 'a-save', transfer_transaction_id: 't-in' }),
      row({ id: 't-in', account_id: 'a-save', date: '2026-11-05', amount: m(30000), payee_id: 'p-tr-main', payee_name: 'Transfer : Main Checking', cleared: 'cleared', transfer_account_id: 'a-main', transfer_transaction_id: 't-out' }),
      row({ id: 't-shop', date: '2026-11-08', amount: m(-5000), payee_id: 'p-shop', payee_name: 'Corner Shop', category_id: 'c-food', memo: 'groceries', cleared: 'uncleared', flag_color: 'red' }),
      row({ id: 't-over', account_id: 'a-over', date: '2026-11-02', amount: m(10000), payee_id: 'p-shop', payee_name: 'Corner Shop', cleared: 'cleared' }),
    ],
    assignments: [{ id: 'as1', category_id: 'c-food', month: '2026-11-01', budgeted: m(40000) } as BudgetSource['assignments'][number]],
    monthNotes: [],
  };
}

describe('backup round trip from API rows', () => {
  const budget = assembleBudget(source());
  const { bytes } = buildTransferZip(budget, { now: NOW });
  const parsed = parseTransferFiles([{ name: 'backup.zip', bytes }]);
  const payload = parsed.payload!;
  const byName = (name: string) => payload.accounts.findIndex((a) => a.name === name);
  const txnsOf = (name: string) => payload.transactions.filter((t) => t.accountIndex === byName(name));
  const balanceOf = (name: string) => txnsOf(name).reduce((s, t) => s + t.inflow - t.outflow, 0);

  test('parses without errors', () => {
    expect(parsed.errors).toEqual([]);
  });

  test('transfer legs keep their payee and re-pair', () => {
    const out = txnsOf('Main Checking').find((t) => t.outflow === 30000)!;
    const inn = txnsOf('Savings')[0];
    expect(out.payee).toBe('Transfer : Savings');
    expect(inn.payee).toBe('Transfer : Main Checking');
    expect(payload.transactions[out.transferPeerIndex!]).toBe(inn);
    expect(payload.transactions[inn.transferPeerIndex!]).toBe(out);
  });

  test('every account survives, including ones without transactions', () => {
    expect(payload.accounts.map((a) => a.name).sort()).toEqual(
      ['Main Checking', 'Old Wallet', 'Overridden', 'Savings', 'Zero Account'],
    );
  });

  test('restored account balances (sum of ledger rows) equal the stored balances', () => {
    expect(balanceOf('Main Checking')).toBe(65000);
    expect(balanceOf('Savings')).toBe(30000);
    expect(balanceOf('Old Wallet')).toBe(12345);
    expect(balanceOf('Overridden')).toBe(14000);
    expect(balanceOf('Zero Account')).toBe(0);
  });

  test('accounts whose balance already equals their ledger get no synthetic row', () => {
    expect(txnsOf('Main Checking').some((t) => t.payee === 'Starting Balance' && t.date === '2026-11-16')).toBe(false);
    expect(txnsOf('Savings')).toHaveLength(1);
  });

  test('cleared / uncleared / reconciled, flag, memo, category and assignments carry', () => {
    const cleared = txnsOf('Main Checking').map((t) => t.cleared).sort();
    expect(cleared).toEqual(['cleared', 'reconciled', 'uncleared']);
    const shop = txnsOf('Main Checking').find((t) => t.payee === 'Corner Shop')!;
    expect(shop).toMatchObject({ memo: 'groceries', flag: 'red', outflow: 5000 });
    expect(payload.categories[shop.categoryIndex!].name).toBe('Food');
    expect(payload.assignments).toEqual([{ categoryIndex: 0, month: '2026-11-01', budgeted: 40000 }]);
  });
});

describe('persons travel by email (accounts and categories)', () => {
  const src = source();
  src.accounts = src.accounts.map((a) => (a.id === 'a-main' ? { ...a, user_id: 'u-ana' } : a));
  src.categories = src.categories.map((c) => (c.id === 'c-food' ? { ...c, user_id: 'u-bob' } : c));
  const exporter = [
    { user_id: 'u-ana', email: 'Ana@Home.test' },
    { user_id: 'u-bob', email: 'bob@home.test' },
  ];
  const { bytes } = buildTransferZip(assembleBudget(src), { now: NOW, people: exporter });
  const files = [{ name: 'backup.zip', bytes }];

  test('the TSVs carry emails, not ids', async () => {
    const { unzipSync, strFromU8 } = await import('fflate');
    const entries = unzipSync(bytes);
    const text = Object.entries(entries).map(([n, b]) => `${n}\n${strFromU8(b)}`).join('\n');
    expect(text).toContain('"Person"');
    expect(text).toContain('"Account Person"');
    expect(text).toContain('"bob@home.test"');
    expect(text).not.toContain('u-ana');
  });

  test('import resolves emails (case-insensitive) against the TARGET budget members', () => {
    // Same people, different ids in the target budget.
    const target = [
      { user_id: 'T-ana', email: 'ana@home.test' },
      { user_id: 'T-bob', email: 'BOB@home.test' },
    ];
    const parsed = parseTransferFiles(files, { people: target });
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    const p = parsed.payload!;
    expect(p.accounts.find((a) => a.name === 'Main Checking')?.userId).toBe('T-ana');
    expect(p.accounts.find((a) => a.name === 'Savings')?.userId ?? null).toBeNull();
    expect(p.categories.find((c) => c.name === 'Food')?.userId).toBe('T-bob');
    expect(p.categories.find((c) => c.name === 'Transit')?.userId ?? null).toBeNull();
  });

  test('an email that is not a member of the target becomes Shared, with a warning', () => {
    const parsed = parseTransferFiles(files, { people: [{ user_id: 'T-ana', email: 'ana@home.test' }] });
    const p = parsed.payload!;
    expect(p.categories.find((c) => c.name === 'Food')?.userId ?? null).toBeNull();
    expect(p.accounts.find((a) => a.name === 'Main Checking')?.userId).toBe('T-ana');
    expect(parsed.warnings.some((w) => w.includes('bob@home.test') && w.includes('Shared'))).toBe(true);
  });

  test('no people supplied: everything imports as Shared', () => {
    const p = parseTransferFiles(files).payload!;
    expect(p.accounts.every((a) => !a.userId)).toBe(true);
    expect(p.categories.every((c) => !c.userId)).toBe(true);
  });

  test('a budget with nobody assigned keeps the reference (column-free) format', async () => {
    const { unzipSync, strFromU8 } = await import('fflate');
    const plain = buildTransferZip(assembleBudget(source()), { now: NOW, people: exporter });
    const text = Object.values(unzipSync(plain.bytes)).map((b) => strFromU8(b)).join('\n');
    expect(text).not.toContain('Person');
  });
});
