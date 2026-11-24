/**
 * Test fixtures for the categorize feature: users, budgets, groups,
 * categories, accounts, payees, transactions (optionally with a bank payload
 * or transfer mark) and their cleanup. Every row is created through the pool
 * with random ids, so tests never depend on the seed data.
 */
import { pool } from '../../core/db';

const budgets: string[] = [];
const users: string[] = [];

export type BudgetFixture = {
  userId: string;
  budgetId: string;
  accountId: string;
  groupId: string;
  /** Visible category "Food". */
  food: string;
  /** Visible category "Dining". */
  dining: string;
  /** Hidden category "Hidden" (never offered/suggested). */
  hidden: string;
  /** Tombstoned category "Deleted". */
  deleted: string;
};

export async function newUser(label: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`insert into public.users (id, email, role) values ($1, $2, 'user')`, [id, `${label}-${id}@categorize.test`]);
  users.push(id);
  return id;
}

export async function newBudget(label: string, ownerUserId?: string): Promise<BudgetFixture> {
  const userId = ownerUserId ?? (await newUser(`${label}-owner`));
  const budgetId = crypto.randomUUID();
  await pool.query(`insert into public.budgets (id, name, owner_user_id) values ($1, $2, $3)`, [budgetId, label, userId]);
  budgets.push(budgetId);
  const groupId = await newGroup(budgetId, 'Everyday');
  const food = await newCategory(budgetId, groupId, 'Food');
  const dining = await newCategory(budgetId, groupId, 'Dining');
  const hidden = await newCategory(budgetId, groupId, 'Hidden', { hidden: true });
  const deleted = await newCategory(budgetId, groupId, 'Deleted', { deleted: true });
  const accountId = await newAccount(budgetId, 'Checking');
  return { userId, budgetId, accountId, groupId, food, dining, hidden, deleted };
}

export async function newGroup(budgetId: string, name: string, opts: { hidden?: boolean; deleted?: boolean } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into public.category_groups (id, budget_id, name, hidden, deleted) values ($1, $2, $3, $4, $5)`,
    [id, budgetId, name, opts.hidden ?? false, opts.deleted ?? false],
  );
  return id;
}

export async function newCategory(
  budgetId: string,
  groupId: string,
  name: string,
  opts: { hidden?: boolean; deleted?: boolean; note?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into public.categories (id, budget_id, group_id, name, hidden, deleted, note) values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, budgetId, groupId, name, opts.hidden ?? false, opts.deleted ?? false, opts.note ?? null],
  );
  return id;
}

export async function newAccount(
  budgetId: string,
  name: string,
  opts: { currency?: string | null; onBudget?: boolean; closed?: boolean; type?: string; group?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into public.accounts (id, budget_id, name, type, account_group, on_budget, closed, currency)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      budgetId,
      name,
      opts.type ?? 'checking',
      opts.group ?? 'CASH',
      opts.onBudget ?? true,
      opts.closed ?? false,
      opts.currency ?? null,
    ],
  );
  return id;
}

export async function newPayee(
  budgetId: string,
  name: string,
  opts: {
    mode?: 'auto' | 'fixed' | 'never';
    defaultCategoryId?: string;
    transferAccountId?: string;
    transferRule?: 'auto' | 'account' | 'never';
    transferRuleWaitDays?: number;
    transferRuleNoMatch?: 'outside' | 'review';
    transferRuleSince?: Date;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into public.payees
       (id, budget_id, name, categorization_mode, default_category_id, transfer_account_id,
        transfer_rule, transfer_rule_account_id, transfer_rule_wait_days, transfer_rule_no_match, transfer_rule_since)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      budgetId,
      name,
      opts.mode ?? 'auto',
      opts.defaultCategoryId ?? null,
      opts.transferAccountId ?? null,
      opts.transferRule ?? null,
      opts.transferRule === 'account' ? (opts.transferAccountId ?? null) : null,
      opts.transferRuleWaitDays ?? 5,
      opts.transferRuleNoMatch ?? 'outside',
      opts.transferRuleSince ?? null,
    ],
  );
  return id;
}

export type TransactionFixture = {
  budgetId: string;
  accountId: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Signed milliunits. */
  amount: number;
  payeeId?: string | null;
  categoryId?: string | null;
  memo?: string | null;
  importPayeeName?: string | null;
  rawPayload?: Record<string, unknown> | null;
  upcoming?: boolean;
  transferAccountId?: string | null;
  transferTransactionId?: string | null;
  /** A transfer_matcher mark on the row. */
  mark?: 'dismissed' | 'outside' | 'manual';
};

export async function newTransaction(t: TransactionFixture): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into public.transactions
       (id, budget_id, account_id, date, amount, payee_id, category_id, memo, import_payee_name, import_payee_name_original,
        upcoming, transfer_account_id, transfer_transaction_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12)`,
    [
      id,
      t.budgetId,
      t.accountId,
      t.date,
      t.amount,
      t.payeeId ?? null,
      t.categoryId ?? null,
      t.memo ?? null,
      t.importPayeeName ?? null,
      t.upcoming ?? false,
      t.transferAccountId ?? null,
      t.transferTransactionId ?? null,
    ],
  );
  if (t.rawPayload) {
    await pool.query(
      `insert into public.connection_transactions
         (transaction_id, budget_id, provider, external_transaction_id, last_synced_payload, raw_payload, raw_received_at)
       values ($1, $2, 'pluggy', $3, '{}'::jsonb, $4::jsonb, now())`,
      [id, t.budgetId, `ext-${id}`, JSON.stringify(t.rawPayload)],
    );
  }
  if (t.mark) {
    await pool.query(
      `insert into public.transfer_marks (transaction_id, budget_id, state) values ($1, $2, $3)`,
      [id, t.budgetId, t.mark],
    );
  }
  return id;
}

/** Suggestions of a transaction, ordered by rank. */
export async function suggestionsOf(transactionId: string): Promise<
  { rank: number; category_id: string; confidence: number; reason: string | null; source: string; provider: string | null; model: string | null; status: string }[]
> {
  const { rows } = await pool.query(
    `select rank, category_id, confidence, reason, source, provider, model, status
       from public.category_suggestions where transaction_id = $1 order by rank`,
    [transactionId],
  );
  return rows;
}

/** Delete everything a test created (budgets first: owner FK is RESTRICT). */
export async function cleanupFixtures(): Promise<void> {
  if (budgets.length > 0) await pool.query('delete from public.budgets where id = any($1::uuid[])', [budgets.splice(0)]);
  if (users.length > 0) await pool.query('delete from public.users where id = any($1::uuid[])', [users.splice(0)]);
}
