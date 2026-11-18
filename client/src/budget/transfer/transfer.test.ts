/**
 * Transfer archive round-trip + reference-format tests. All fixture data is
 * synthetic and anonymized (generic account/category/payee names only).
 */

import { describe, expect, test } from 'bun:test';
import { unzipSync, strFromU8 } from 'fflate';

import type { Account, Budget, Category, CategoryGroup, Transaction } from '../domain/types';
import { TRANSFER_PAYEE_PREFIX } from '@shared/domain/transfers';
import { budgetToPayload } from './payload';
import { dateIn, payId, scenario } from '../domain/__fixtures__/zeroSum.fixtures';
import { buildTransferZip, parseTransferFiles, PLAN_SUFFIX, REGISTER_SUFFIX } from './transfer';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const MONTH_A = 202609;
const MONTH_B = 202610;

const accounts: Account[] = [
  { id: 'acc-1', name: 'Main Checking', type: 'checking', group: 'CASH', onBudget: true, clearedBalance: 125000, unclearedBalance: 0, lastReconciledAt: null, userId: null },
  { id: 'acc-2', name: 'Card B', type: 'credit', group: 'CREDIT', onBudget: true, clearedBalance: -45000, unclearedBalance: 0, lastReconciledAt: null, userId: null },
  { id: 'acc-3', name: 'Backup Savings', type: 'savings', group: 'CASH', onBudget: true, clearedBalance: 800000, unclearedBalance: 0, lastReconciledAt: null, userId: null },
];

const groups: CategoryGroup[] = [
  { id: 'grp-1', name: 'Essentials', categoryIds: ['cat-1', 'cat-2', 'cat-3'] },
  { id: 'grp-2', name: 'Card Payments', isCreditCardPayments: true, categoryIds: ['cat-4', 'cat-5'] },
];

const categories: Category[] = [
  { id: 'cat-1', groupId: 'grp-1', name: 'Groceries', assigned: { [MONTH_A]: 40000, [MONTH_B]: 50000 }, activity: { [MONTH_B]: -12345 } },
  { id: 'cat-2', groupId: 'grp-1', name: 'Transport', assigned: { [MONTH_A]: 10000, [MONTH_B]: 0 }, activity: { [MONTH_B]: -5000 } },
  { id: 'cat-3', groupId: 'grp-1', name: 'Streaming Vault', hidden: true, assigned: { [MONTH_B]: 1499 }, activity: {} },
  { id: 'cat-4', groupId: 'grp-2', name: 'Backup Savings', assigned: { [MONTH_B]: 20000 }, activity: {} },
  { id: 'cat-5', groupId: 'grp-2', name: 'Emergency Card Buffer', assigned: {}, activity: {} },
];

function txn(t: Partial<Transaction> & Pick<Transaction, 'id' | 'accountId' | 'date' | 'payee'>): Transaction {
  return {
    categoryId: null,
    memo: '',
    outflow: 0,
    inflow: 0,
    cleared: 'uncleared',
    approved: true,
    repeat: 'never',
    repeatRuleId: null,
    upcoming: false,
    ...t,
  };
}

const transactions: Transaction[] = [
  // 2026-10 rows — newest first; first appearances fix the parsed account order.
  txn({ id: 't1', accountId: 'acc-1', date: '2026-10-05', payee: 'Deposit Source', inflow: 90000, categoryId: null, cleared: 'cleared' }),
  txn({ id: 't2', accountId: 'acc-2', date: '2026-10-02', payee: 'Corner Grocer', categoryId: 'cat-1', outflow: 12345, cleared: 'reconciled' }),
  txn({ id: 't3', accountId: 'acc-3', date: '2026-09-28', payee: 'Savings Top Up', inflow: 30000, categoryId: null, cleared: 'uncleared' }),
  // Transfer pair (Main Checking -> Card B).
  txn({ id: 't4', accountId: 'acc-1', date: '2026-09-20', payee: `${TRANSFER_PAYEE_PREFIX}Card B`, outflow: 20000, cleared: 'cleared' }),
  txn({ id: 't5', accountId: 'acc-2', date: '2026-09-20', payee: `${TRANSFER_PAYEE_PREFIX}Main Checking`, inflow: 20000, cleared: 'cleared' }),
  // Starting-balance-style row.
  txn({ id: 't6', accountId: 'acc-1', date: '2026-09-01', payee: 'Starting Balance', inflow: 125000, categoryId: null, flag: 'blue' }),
  // Split transaction (two legs; parent has no category).
  txn({
    id: 't7', accountId: 'acc-2', date: '2026-09-10', payee: 'Mega Mart', cleared: 'uncleared',
    splits: [
      { id: 's1', categoryId: 'cat-1', memo: 'produce', outflow: 4000, inflow: 0 },
      { id: 's2', categoryId: 'cat-2', memo: 'bus pass', outflow: 2500, inflow: 0 },
    ],
  }),
  // Flagged + tricky memo (double quote AND tab, verbatim).
  txn({ id: 't8', accountId: 'acc-1', date: '2026-09-15', payee: 'Odd Vendor', categoryId: 'cat-2', outflow: 2500, flag: 'red', memo: 'say "hi"\tnow' }),
  // Older rows (no new accounts).
  txn({ id: 't9', accountId: 'acc-2', date: '2026-09-05', payee: 'Stream Service', categoryId: 'cat-3', outflow: 1499 }),
  txn({ id: 't10', accountId: 'acc-1', date: '2026-09-06', payee: 'Utility Co', categoryId: 'cat-1', outflow: 8000 }),
  txn({ id: 't11', accountId: 'acc-1', date: '2026-08-30', payee: 'Old Utility', categoryId: 'cat-1', outflow: 7000 }),
  txn({ id: 't12', accountId: 'acc-1', date: '2026-08-31', payee: 'Refund Desk', categoryId: 'cat-1', inflow: 1500 }),
];

// Stored balances equal the ledger sum, so the main fixture needs no synthetic
// balance rows (the balance-override cases are covered in the loss tests below).
for (const account of accounts) {
  account.clearedBalance = transactions
    .filter((t) => t.accountId === account.id)
    .reduce((sum, t) => {
      const legs = t.splits && t.splits.length > 0 ? t.splits : [t];
      return sum + legs.reduce((s, l) => s + l.inflow - l.outflow, 0);
    }, 0);
  account.unclearedBalance = 0;
}

const budget: Budget = {
    bundles: [],
  id: 'b-1',
  name: 'Family Plan',
  currentMonth: MONTH_B,
  months: [MONTH_A, MONTH_B],
  groups,
  categories,
  accounts,
  transactions,
};

// ---------------------------------------------------------------------------
// Reference-format assertions
// ---------------------------------------------------------------------------

describe('buildTransferZip', () => {
  const now = new Date(2026, 9, 7, 14, 5);
  const { zipName, bytes } = buildTransferZip(budget, { now });
  const entries = unzipSync(bytes);

  test('zip and entry naming', () => {
    expect(zipName).toBe('Budget Export - Family Plan as of 2026-10-07 14-05.zip');
    expect(Object.keys(entries).sort()).toEqual([
      'Family Plan as of 2026-10-07 14-05 - Plan.tsv',
      'Family Plan as of 2026-10-07 14-05 - Register.tsv',
    ]);
  });

  test('Plan.tsv reference format', () => {
    const plan = strFromU8(entries[`Family Plan as of 2026-10-07 14-05${PLAN_SUFFIX}`]);
    const lines = plan.split('\n');
    expect(lines[0]).toBe(
      '"Month"\t"Category Group/Category"\t"Category Group"\t"Category"\t"Assigned"\t"Activity"\t"Available"',
    );
    // First ledger month (L3) is Aug 2026 (older transactions), not the first assignment month.
    expect(lines[1]).toContain('"Aug 2026"\t"Essentials: Groceries"');
    expect(lines.find((l) => l.startsWith('"Sep 2026"'))).toBe(
      // Aug Groceries nets -5500 (t11 - t12) and is swept at the Sep rollover,
      // so Sep available is just assigned 40000 - Sep activity 12000.
      '"Sep 2026"\t"Essentials: Groceries"\t"Essentials"\t"Groceries"\t"R$400,00"\t"-R$120,00"\t"R$280,00"',
    );
    // months ascending, Mon YYYY cells, comma-decimal money with R$ prefix
    expect(plan).toContain('"Oct 2026"');
    expect(plan).toContain('-R$');
    expect(plan.endsWith('\n')).toBe(true);
    // row order: month asc, then group order, then category order
    const groups = lines.slice(1, -1).map((l) => l.split('\t')[2]);
    const firstOctIndex = lines.findIndex((l) => l.startsWith('"Oct 2026"'));
    expect(groups[firstOctIndex]).toBe('"Essentials"');
  });

  test('Plan.tsv exports the engine\'s unified figures for card payment categories', () => {
    // Checking 10000; Mercado assigned 5000, 3000 spent on the card (funded 3000);
    // 4000 assigned to the card payment category, 1000 paid (transfer).
    const b = scenario({ cash: ['Checking'], cards: ['Card'], categories: ['Mercado'] })
      .startingBalance('Checking', 10000, dateIn(202610, 1))
      .assign('Mercado', 202610, 5000)
      .assign(payId('Card'), 202610, 4000)
      .spend('Card', 'Mercado', 3000, dateIn(202610, 5))
      .transfer('Checking', 'Card', 1000, dateIn(202610, 6))
      .build();
    const { bytes } = buildTransferZip(b, { now });
    const files = unzipSync(bytes);
    const planName = Object.keys(files).find((n) => n.endsWith(PLAN_SUFFIX))!;
    const rows = strFromU8(files[planName]).split('\n').filter((l) => l !== '').slice(1);
    const cell = (row: string) => row.split('\t').map((c) => c.replace(/^"|"$/g, ''));
    const byCat = Object.fromEntries(rows.map((r) => [cell(r)[3], cell(r)]));
    // Mercado: 5000 - 3000 = 2000. Card payment: assigned 4000, activity funded 3000 - paid 1000 = 2000, Available 4000 + 3000 - 1000 = 6000.
    expect(byCat.Mercado.slice(4)).toEqual(['R$50,00', '-R$30,00', 'R$20,00']);
    expect(byCat.Card.slice(4)).toEqual(['R$40,00', 'R$20,00', 'R$60,00']);
  });

  test('Register.tsv reference format', () => {
    const register = strFromU8(entries[`Family Plan as of 2026-10-07 14-05${REGISTER_SUFFIX}`]);
    const lines = register.split('\n').filter((l) => l !== '');
    expect(lines[0]).toBe(
      '"Account"\t"Flag"\t"Date"\t"Payee"\t"Category Group/Category"\t"Category Group"\t"Category"\t"Memo"\t"Outflow"\t"Inflow"\t"Cleared"',
    );
    // every field quoted (quote-aware split: memo may contain literal tabs)
    const splitQuoted = (line: string): string[] => {
      const cells: string[] = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++; continue; }
            inQuotes = false; cur += '"'; continue;
          }
          cur += ch; continue;
        }
        if (ch === '"') { inQuotes = true; cur += '"'; continue; }
        if (ch === '\t') { cells.push(cur); cur = ''; continue; }
        cur += ch;
      }
      cells.push(cur);
      return cells;
    };
    for (const line of lines) {
      for (const cell of splitQuoted(line)) expect(cell.startsWith('"') && cell.endsWith('"'), JSON.stringify(line) + ' CELL=' + JSON.stringify(cell)).toBe(true);
    }
    // date descending, DD/MM/YYYY
    expect(lines[1]).toContain('"05/10/2026"');
    expect(lines[2]).toContain('"02/10/2026"');
    // transfer payee text
    expect(register).toContain('"Transfer : Card B"');
    expect(register).toContain('"Transfer : Main Checking"');
    // split collapsed: summed 6500, empty category cells
    const splitRow = lines.find((l) => l.includes('"Mega Mart"'))!;
    expect(splitRow).toContain('"R$65,00"');
    expect(splitRow.split('\t')[4]).toBe('""');
    // memo verbatim (double quote + tab inside quoted cell)
    const tricky = lines.find((l) => l.includes('"Odd Vendor"'))!;
    expect(tricky).toContain('"say ""hi""\tnow"');
    // Ready-to-Assign inflow cells
    const rta = lines.find((l) => l.includes('"Deposit Source"'))!;
    expect(rta.split('\t')[4]).toBe('"Inflow: Ready to Assign"');
    expect(rta.split('\t')[5]).toBe('"Inflow"');
    expect(rta.split('\t')[6]).toBe('"Ready to Assign"');
    // unsigned money in Outflow/Inflow columns
    expect(lines.slice(1).every((l) => !l.includes('"-R$'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('round trip', () => {
  const { bytes } = buildTransferZip(budget, { now: new Date(2026, 9, 7, 14, 5) });
  const result = parseTransferFiles([{ name: 'export.zip', bytes }]);

  test('parses without errors or warnings', () => {
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.payload).toBeDefined();
  });

  test('groups, categories, accounts equal', () => {
    const payload = budgetToPayload(budget);
    const parsed = result.payload!;
    expect(parsed.groups).toEqual(payload.groups);
    expect(parsed.accounts).toEqual(payload.accounts);
    // hidden flag cannot survive the TSVs; compare the shared fields
    expect(parsed.categories.map((c) => ({ groupIndex: c.groupIndex, name: c.name })))
      .toEqual(payload.categories.map((c) => ({ groupIndex: c.groupIndex, name: c.name })));
    expect(payload.categories[2].hidden).toBe(true);
  });

  test('transactions equal as sets keyed by (accountIndex, date, payee, amounts)', () => {
    const payload = budgetToPayload(budget);
    const parsed = result.payload!;
    const key = (t: typeof payload.transactions[number]) =>
      `${t.accountIndex}|${t.date}|${t.payee}|${t.outflow}|${t.inflow}`;
    const original = payload.transactions.map(key).sort();
    const back = parsed.transactions.map(key).sort();
    expect(back).toEqual(original);
  });

  test('assignments equal as sets', () => {
    const payload = budgetToPayload(budget);
    const parsed = result.payload!;
    const sortKey = (a: typeof payload.assignments[number]) => `${a.categoryIndex}|${a.month}|${a.budgeted}`;
    expect(parsed.assignments.map(sortKey).sort()).toEqual(payload.assignments.map(sortKey).sort());
    expect(parsed.assignments.length).toBe(5); // zero rows skipped
  });

  test('transfer peer indexes paired both ways', () => {
    const parsed = result.payload!;
    const transfers = parsed.transactions.filter((t) => t.payee.startsWith('Transfer : '));
    expect(transfers).toHaveLength(2);
    const [a, b] = transfers;
    expect(a.transferPeerIndex).not.toBeNull();
    expect(parsed.transactions[a.transferPeerIndex!]).toBe(b);
    expect(b.transferPeerIndex).not.toBeNull();
    expect(parsed.transactions[b.transferPeerIndex!]).toBe(a);
  });

  test('loose TSV files round-trip identically', () => {
    const entries = unzipSync(bytes);
    const prefix = Object.keys(entries)[0].replace(PLAN_SUFFIX, '');
    const result2 = parseTransferFiles([
      { name: `${prefix}${PLAN_SUFFIX}`, bytes: entries[`${prefix}${PLAN_SUFFIX}`] },
      { name: `${prefix}${REGISTER_SUFFIX}`, bytes: entries[`${prefix}${REGISTER_SUFFIX}`] },
    ]);
    expect(result2.errors).toEqual([]);
    const key = (t: NonNullable<typeof result2.payload>['transactions'][number]) =>
      `${t.accountIndex}|${t.date}|${t.payee}|${t.outflow}|${t.inflow}`;
    expect(result2.payload!.transactions.map(key).sort())
      .toEqual(result.payload!.transactions.map(key).sort());
  });
});

// ---------------------------------------------------------------------------
// Parse error handling
// ---------------------------------------------------------------------------

describe('parse error handling', () => {
  const { bytes } = buildTransferZip(budget, { now: new Date(2026, 9, 7, 14, 5) });
  const entries = unzipSync(bytes);
  const prefix = Object.keys(entries)[0].replace(PLAN_SUFFIX, '');

  test('plan alone -> error; register alone -> error; garbage zip -> error', () => {
    expect(parseTransferFiles([{ name: 'x.zip', bytes: entries[`${prefix}${PLAN_SUFFIX}`] }]).errors.join(' '))
      .toContain('both Plan.tsv and Register.tsv are required');
    expect(parseTransferFiles([{ name: 'x.zip', bytes: new Uint8Array([1, 2, 3]) }]).errors.join(' '))
      .toContain('not a readable zip archive');
  });

  test('unknown category and unknown cleared are reported, never thrown', () => {
    const register = strFromU8(entries[`${prefix}${REGISTER_SUFFIX}`])
      .replaceAll('"Groceries"', '"Mystery Shop"')
      .replace('"Reconciled"', '"Meh"');
    const result = parseTransferFiles([
      { name: `${prefix}${PLAN_SUFFIX}`, bytes: entries[`${prefix}${PLAN_SUFFIX}`] },
      { name: `${prefix}${REGISTER_SUFFIX}`, bytes: new TextEncoder().encode(register) },
    ]);
    expect(result.errors.join(' ')).toContain('unknown categories: essentials/mystery shop');
    expect(result.warnings.join(' ')).toContain('unknown Cleared cell');
    expect(result.payload!.transactions.find((t) => t.payee === 'Corner Grocer')!.cleared).toBe('uncleared');
  });

  test('transfer payee naming an unknown account -> error', () => {
    const register = strFromU8(entries[`${prefix}${REGISTER_SUFFIX}`]).replace(
      '"Transfer : Card B"', '"Transfer : Ghost Account"',
    );
    const result = parseTransferFiles([
      { name: `${prefix}${PLAN_SUFFIX}`, bytes: entries[`${prefix}${PLAN_SUFFIX}`] },
      { name: `${prefix}${REGISTER_SUFFIX}`, bytes: new TextEncoder().encode(register) },
    ]);
    expect(result.errors.join(' ')).toContain('unknown account "Ghost Account"');
    expect(result.warnings.join(' ')).toContain('unpaired transfer transaction');
  });

  test('BOM + CRLF tolerated on parse', () => {
    const planBytes = entries[`${prefix}${PLAN_SUFFIX}`];
    const registerBytes = entries[`${prefix}${REGISTER_SUFFIX}`];
    const bomCrlf = (b: Uint8Array) =>
      new Uint8Array([0xef, 0xbb, 0xbf, ...strFromU8(b).replace(/\n/g, '\r\n').split('').map((c) => c.charCodeAt(0))]);
    const result = parseTransferFiles([
      { name: `plan${PLAN_SUFFIX}`, bytes: bomCrlf(planBytes) },
      { name: `reg${REGISTER_SUFFIX}`, bytes: bomCrlf(registerBytes) },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.payload).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Export gaps: engine-driven months, register category labels (syscd-app-sfkr)
// ---------------------------------------------------------------------------

describe('export months and register labels', () => {
  const now = new Date(2026, 9, 7, 14, 5);
  const cells = (line: string) => line.split('\t').map((c) => c.replace(/^"|"$/g, ''));
  const exportOf = (b: Budget) => {
    const files = unzipSync(buildTransferZip(b, { now }).bytes);
    const text = (suffix: string) => strFromU8(files[Object.keys(files).find((n) => n.endsWith(suffix))!]);
    const rows = (suffix: string) => text(suffix).split('\n').filter((l) => l !== '').slice(1).map(cells);
    return { plan: rows(PLAN_SUFFIX), register: rows(REGISTER_SUFFIX) };
  };

  test('a month whose only event is a card payment transfer is exported', () => {
    const b = scenario({ cash: ['Checking'], cards: ['Card'], categories: ['Mercado'] })
      .startingBalance('Checking', 10000, dateIn(202609, 1))
      .spend('Card', 'Mercado', 3000, dateIn(202609, 5))
      .assign('Mercado', 202609, 5000)
      .assign(payId('Card'), 202609, 3000)
      .transfer('Checking', 'Card', 1000, dateIn(202610, 6))
      .build();
    b.categories.forEach((c) => { c.activity = {}; }); // no derived-cache trace in Oct
    const { plan } = exportOf(b);
    expect([...new Set(plan.map((r) => r[0]))]).toEqual(['Sep 2026', 'Oct 2026']);
    const oct = Object.fromEntries(plan.filter((r) => r[0] === 'Oct 2026').map((r) => [r[3], r]));
    // Sep: assigned 3000 + funded 3000 = 6000; Oct: nothing assigned/funded, paid 1000 -> Available 5000
    expect(oct.Card.slice(4)).toEqual(['R$0,00', '-R$10,00', 'R$50,00']);
  });

  test('months run from the first ledger month through gaps to the last event', () => {
    const b = scenario({ cash: ['Checking'], categories: ['Mercado'] })
      .assign('Mercado', 202608, 1000) // assignment before any transaction: first ledger month (L3)
      .startingBalance('Checking', 5000, dateIn(202609, 1))
      .inflow('Checking', null, 100, dateIn(202611, 3)) // only account activity, no category trace
      .build();
    const { plan } = exportOf(b);
    expect([...new Set(plan.map((r) => r[0]))]).toEqual(['Aug 2026', 'Sep 2026', 'Oct 2026', 'Nov 2026']);
    // carried month (Oct): no events, Available carries forward
    expect(plan.find((r) => r[0] === 'Oct 2026' && r[3] === 'Mercado')!.slice(4)).toEqual(['R$0,00', 'R$0,00', 'R$10,00']);
  });

  test('transfer legs get an empty category, even an inflow leg on a card', () => {
    const b = scenario({ cash: ['Checking'], cards: ['Card'], categories: [] })
      .startingBalance('Checking', 10000, dateIn(202610, 1))
      .transfer('Checking', 'Card', 1000, dateIn(202610, 6))
      .build();
    const { register } = exportOf(b);
    const legs = register.filter((r) => r[3].startsWith('Transfer : '));
    expect(legs).toHaveLength(2);
    for (const leg of legs) expect(leg.slice(4, 7)).toEqual(['', '', '']);
  });

  test('legacy transfer payee without transferAccountId is still a transfer', () => {
    const b = scenario({ cash: ['Checking'], cards: ['Card'], categories: [] })
      .startingBalance('Checking', 10000, dateIn(202610, 1))
      .transfer('Checking', 'Card', 1000, dateIn(202610, 6))
      .build();
    for (const t of b.transactions) delete t.transferAccountId;
    const { register } = exportOf(b);
    for (const leg of register.filter((r) => r[3].startsWith('Transfer : '))) expect(leg.slice(4, 7)).toEqual(['', '', '']);
  });

  test('cash income and card statement credits keep the Ready to Assign label; outflows stay empty', () => {
    const b = scenario({ cash: ['Checking'], cards: ['Card'], categories: [] })
      .inflow('Checking', null, 9000, dateIn(202610, 2))
      .add({ accountId: 'Card', date: dateIn(202610, 3), payee: 'Statement Credit', inflow: 500 })
      .spend('Checking', null, 700, dateIn(202610, 4))
      .build();
    const { register } = exportOf(b);
    const byPayee = (p: string) => register.find((r) => r[3] === p)!;
    expect(byPayee('Statement Credit').slice(4, 7)).toEqual(['Inflow: Ready to Assign', 'Inflow', 'Ready to Assign']);
    const income = register.filter((r) => r[0] === 'Checking' && r[9] !== 'R$0,00' && r[3] === '');
    expect(income.map((r) => r.slice(4, 7))).toContainEqual(['Inflow: Ready to Assign', 'Inflow', 'Ready to Assign']);
    expect(register.find((r) => r[8] === 'R$7,00')!.slice(4, 7)).toEqual(['', '', '']);
  });

  test('round trip preserves transfers (paired) and income', () => {
    const b = scenario({ cash: ['Checking'], cards: ['Card'], categories: [] })
      .inflow('Checking', null, 9000, dateIn(202610, 2))
      .transfer('Checking', 'Card', 1000, dateIn(202610, 6))
      .build();
    const result = parseTransferFiles([{ name: 'x.zip', bytes: buildTransferZip(b, { now }).bytes }]);
    expect(result.errors).toEqual([]);
    const txs = result.payload!.transactions;
    const legs = txs.filter((t) => t.payee.startsWith('Transfer : '));
    expect(legs).toHaveLength(2);
    expect(legs.every((t) => t.categoryIndex === null && t.transferPeerIndex !== null)).toBe(true);
    expect(txs.find((t) => t.inflow === 9000)!.categoryIndex).toBeNull();
  });
});
