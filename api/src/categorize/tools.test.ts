/**
 * Budget scoping of every model tool: a tool built for one budget never
 * returns a transaction, payee, category or similar transaction of another
 * budget, whatever id arrives from the model.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { pool, type Queryable } from '../core/db';
import { dbReady } from '../core/test-gate';
import { createTools, searchTokens } from './tools';
import { cleanupFixtures, newBudget, newPayee, newTransaction, type BudgetFixture } from './testing';

let a: BudgetFixture;
let b: BudgetFixture;

beforeEach(async () => {
  if (!dbReady) return;
  await cleanupFixtures();
  a = await newBudget('tools-a');
  b = await newBudget('tools-b');
});

afterAll(async () => {
  if (!dbReady) return;
  await cleanupFixtures();
});

const call = async (tools: ReturnType<typeof createTools>, name: string, args: Record<string, unknown> = {}): Promise<any> =>
  JSON.parse(await tools.execute({ id: 'call-1', name, arguments: args }));

describe.skipIf(!dbReady)('categorize tools are budget-scoped', () => {
  test('list_categories returns only the budget\'s live visible categories', async () => {
    const listed = await call(createTools(pool, a.budgetId), 'list_categories');
    const ids = listed.groups.flatMap((group: { categories: { category_id: string }[] }) => group.categories.map((c) => c.category_id));
    expect([...ids].sort()).toEqual([a.food, a.dining].sort());
    expect(ids).not.toContain(a.hidden);
    expect(ids).not.toContain(a.deleted);
    expect(ids).not.toContain(b.food);
  });

  test('get_transaction returns this budget\'s transaction and never another budget\'s', async () => {
    const own = await newTransaction({ budgetId: a.budgetId, accountId: a.accountId, date: '2026-11-01', amount: -12340, memo: 'lunch' });
    const foreign = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-02', amount: -999, memo: 'secret' });

    const mine = await call(createTools(pool, a.budgetId), 'get_transaction', { transaction_id: own });
    expect(mine.id).toBe(own);
    expect(mine.amount_milliunits).toBe(-12340);
    expect(mine.account.name).toBe('Checking');

    const other = await call(createTools(pool, a.budgetId), 'get_transaction', { transaction_id: foreign });
    expect(other).toEqual({ found: false });
    expect(JSON.stringify(other)).not.toContain('secret');
  });

  test('get_transaction exposes whitelisted bank facts and no bank identifiers', async () => {
    const txn = await newTransaction({
      budgetId: a.budgetId,
      accountId: a.accountId,
      date: '2026-11-03',
      amount: -5000,
      rawPayload: {
        descriptionRaw: 'UBER *TRIP SAO PAULO',
        merchant: { name: 'Uber', businessName: 'Uber do Brasil', category: 'Transport', cnpj: '00.000.000/0001-00' },
        paymentData: {
          paymentMethod: 'PIX',
          reason: 'ride',
          payer: { name: 'Me', accountNumber: '1234-5', documentNumber: { type: 'CPF', value: '123.456.789-00' } },
          receiver: { name: 'Uber', branchNumber: '0001' },
          referenceNumber: 'E123456789',
        },
        creditCardMetadata: { installmentNumber: 2, totalInstallments: 6, payeeMCC: 4121, cardNumber: '1234' },
        status: 'POSTED',
        category: 'Transport',
        operationType: 'PIX',
      },
    });
    const detail = await call(createTools(pool, a.budgetId), 'get_transaction', { transaction_id: txn });
    expect(detail.bank).toEqual({
      description_raw: 'UBER *TRIP SAO PAULO',
      category: 'Transport',
      operation_type: 'PIX',
      status: 'POSTED',
      merchant: { name: 'Uber', business_name: 'Uber do Brasil', category: 'Transport' },
      payment: { method: 'PIX', reason: 'ride', payer_name: 'Me', receiver_name: 'Uber' },
      card: { installment_number: 2, total_installments: 6, payee_mcc: 4121 },
    });
    const serialized = JSON.stringify(detail);
    for (const secret of ['1234-5', '123.456.789-00', 'E123456789', '00.000.000/0001-00', '0001']) {
      expect(serialized).not.toContain(secret);
    }
  });

  test('payee_history is empty for another budget\'s payee and non-empty for this budget\'s', async () => {
    const mine = await newPayee(a.budgetId, 'Cafe');
    const foreign = await newPayee(b.budgetId, 'Cafe');
    await newTransaction({ budgetId: a.budgetId, accountId: a.accountId, date: '2026-10-01', amount: -1000, payeeId: mine, categoryId: a.dining });
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-10-02', amount: -2000, payeeId: foreign, categoryId: b.dining });

    const ownHistory = await call(createTools(pool, a.budgetId), 'payee_history', { payee_id: mine });
    expect(ownHistory.total).toBe(1);
    expect(ownHistory.history[0].category_id).toBe(a.dining);

    const foreignHistory = await call(createTools(pool, a.budgetId), 'payee_history', { payee_id: foreign });
    expect(foreignHistory).toEqual({ history: [], total: 0 });
  });

  test('search_similar_transactions matches this budget only', async () => {
    await newTransaction({ budgetId: a.budgetId, accountId: a.accountId, date: '2026-09-01', amount: -1500, payeeId: await newPayee(a.budgetId, 'Uber Trip'), categoryId: a.dining });
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-09-02', amount: -2500, payeeId: await newPayee(b.budgetId, 'Uber Trip'), categoryId: b.food });

    const found = await call(createTools(pool, a.budgetId), 'search_similar_transactions', { description: 'uber' });
    expect(found.transactions).toHaveLength(1);
    expect(found.transactions[0].category_id).toBe(a.dining);
    expect(found.transactions[0].description).toBe('Uber Trip');
  });

  test('an uncategorized transaction is not a similar-transaction hit', async () => {
    await newTransaction({ budgetId: a.budgetId, accountId: a.accountId, date: '2026-09-03', amount: -1500, payeeId: await newPayee(a.budgetId, 'Uber Eats') });
    const found = await call(createTools(pool, a.budgetId), 'search_similar_transactions', { description: 'uber eats' });
    expect(found.transactions).toEqual([]);
  });

  test('invalid tool arguments answer an error instead of throwing', async () => {
    const tools = createTools(pool, a.budgetId);
    expect(await call(tools, 'get_transaction', { transaction_id: 42 })).toMatchObject({ error: 'invalid arguments' });
    expect(await call(tools, 'nope')).toEqual({ error: 'unknown tool nope' });
  });

  test('a non-uuid id chosen by the model answers an error, never a database error', async () => {
    const tools = createTools(pool, a.budgetId);
    // Both columns are uuid: the old schemas forwarded this to Postgres and
    // threw 22P02, which failed and re-billed the whole chunk.
    expect(await call(tools, 'get_transaction', { transaction_id: 'txn_1' })).toMatchObject({ error: 'invalid arguments' });
    expect(await call(tools, 'payee_history', { payee_id: 'payee_1' })).toMatchObject({ error: 'invalid arguments' });
  });

  test('a database error inside a tool becomes an { error } result, not a throw', async () => {
    // A driver that fails every query: test double for the Queryable port.
    const broken = {
      query: async () => {
        throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      },
    } as unknown as Queryable;
    const result = await call(createTools(broken, a.budgetId), 'list_categories');
    expect(result).toEqual({ error: 'tool lookup failed' });
  });

  test('searchTokens folds accents, drops short words and wildcards, dedupes', () => {
    expect(searchTokens('PÃO  de Açúcar %%% uber UBER x')).toEqual(['pao', 'acucar', 'uber']);
    expect(searchTokens('%%%')).toEqual([]);
  });
});
