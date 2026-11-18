import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { accountsCreate, accountsDelete, accountsList, accountsReconcile, accountsUpdate } from '@shared/contracts/budget';
import type { AccountType } from '@shared/contracts/budget/schemas';
import { ensureTransferPayee } from '../domain/transfers';
import { personRefSql, toPersonRef, type PersonRefRow } from '../../user';
import { isBudgetMember } from '../ownership';
import { budgetRouter } from '../router';

const CREDIT_TYPES: Partial<Record<AccountType, true>> = { creditCard: true, lineOfCredit: true };

/** Debt types mirror a negative balance at creation (YNAB starts loans at the amount owed). */
const DEBT_TYPES: Partial<Record<AccountType, true>> = {
  otherLiability: true,
  mortgage: true,
  autoLoan: true,
  studentLoan: true,
  personalLoan: true,
  medicalDebt: true,
  otherDebt: true,
};

/** 400 unless `userId` (non-null) is a member of the account's budget. */
async function assertMemberOrShared(
  client: Parameters<typeof isBudgetMember>[2],
  budgetId: string,
  userId: string | null | undefined,
): Promise<void> {
  if (userId == null) return;
  if (!(await isBudgetMember(budgetId, userId, client))) {
    throw new HttpError(400, 'user_id is not a member of this budget');
  }
}

const accountGroupFor = (type: AccountType): 'CASH' | 'CREDIT' => (CREDIT_TYPES[type] ? 'CREDIT' : 'CASH');

type Queryable = NonNullable<Parameters<typeof isBudgetMember>[2]>;

/**
 * YNAB parity: a card account owns a payment category (same name) in the
 * budget's Credit Card Payments group. Creates the group when missing and the
 * category unless a live one with that name already exists there. No money is
 * assigned. The engine links card to category by exact name (spec P8).
 */
async function ensureCardPaymentCategory(client: Queryable, budgetId: string, name: string): Promise<void> {
  let groupId = (
    await client.query<{ id: string }>(
      `SELECT id FROM category_groups
        WHERE budget_id = $1 AND is_credit_card_payments AND NOT deleted
        ORDER BY sort_order, created_at LIMIT 1`,
      [budgetId],
    )
  ).rows[0]?.id;
  if (!groupId) {
    groupId = (
      await client.query<{ id: string }>(
        `INSERT INTO category_groups (budget_id, name, sort_order, is_credit_card_payments, internal)
         VALUES ($1, 'Credit Card Payments', 0, true, true) RETURNING id`,
        [budgetId],
      )
    ).rows[0]!.id;
  }
  await client.query(
    `INSERT INTO categories (budget_id, group_id, name, sort_order)
     SELECT $1, $2, $3, COALESCE((SELECT MAX(sort_order) + 1 FROM categories WHERE group_id = $2), 0)
      WHERE NOT EXISTS (SELECT 1 FROM categories WHERE group_id = $2 AND name = $3 AND NOT deleted)`,
    [budgetId, groupId, name],
  );
}

const createAccount = implement(
  accountsCreate,
  async (_c, { budget_id, name, type, on_budget, balance_cents, user_id }) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const budgetCheck = await client.query('SELECT 1 FROM budgets WHERE id = $1', [budget_id]);
      if (budgetCheck.rowCount === 0) throw new HttpError(404, 'budget not found');

      await assertMemberOrShared(client, budget_id, user_id);

      // Open accounts start with an explicit positive/negative opening transaction,
      // so keep the stored balances at 0 and let that transaction carry the amount.
      const created = await client.query<{ id: string }>(
        `INSERT INTO accounts (budget_id, name, type, account_group, on_budget, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
        [budget_id, name, type, accountGroupFor(type), on_budget, user_id ?? null],
      );
      const accountId = created.rows[0].id;
      // Every account gets its "Transfer : <name>" payee so it shows up in the
      // register's Payments and Transfers list and can be a transfer target.
      await ensureTransferPayee(client, budget_id, accountId, name);
      if (type === 'creditCard' && on_budget) await ensureCardPaymentCategory(client, budget_id, name);

      if (balance_cents !== 0) {
        // Positive opening balance = inflow; debt types flip the sign so the
        // account starts at the amount owed (balance_cents is stated |balance|).
        const deltaMilli = (DEBT_TYPES[type] ? -balance_cents : balance_cents) * 10;
        const payeeResult = await client.query<{ id: string }>(
          `INSERT INTO payees (budget_id, name)
         VALUES ($1, $2)
         ON CONFLICT (budget_id, name) DO UPDATE SET name = $2
         RETURNING id`,
          [budget_id, 'Starting Balance'],
        );
        await client.query(
          `INSERT INTO transactions
          (budget_id, account_id, date, payee_id, category_id, memo, amount, cleared, approved, repeat, deleted)
         VALUES ($1, $2, CURRENT_DATE, $3, NULL, '', $4, 'uncleared', true, 'never', false)`,
          [budget_id, accountId, payeeResult.rows[0].id, deltaMilli],
        );
        await client.query('UPDATE accounts SET uncleared_balance = $1 WHERE id = $2', [deltaMilli, accountId]);
      }

      await client.query('COMMIT');
      const row = await client.query('SELECT * FROM accounts WHERE id = $1', [accountId]);
      return row.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
);

const updateAccount = implement(
  accountsUpdate,
  async (c, { id: accountId, budget_id, name, note, closed, working_balance_cents, link, user_id }) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const accResult = await client.query<{ budget_id: string; closed: boolean; name: string; type: AccountType; on_budget: boolean }>(
        'SELECT budget_id, closed, name, type, on_budget FROM accounts WHERE id = $1',
        [accountId],
      );
      // Scope every write by the budget in the body — same cross-budget guard
      // the reconcile route uses.
      if (accResult.rows.length === 0 || accResult.rows[0].budget_id !== budget_id) {
        throw new HttpError(404, 'account not found');
      }

      // Closed accounts are immutable (YNAB parity): field edits are rejected
      // until the request reopens the account (closed === false). Reopen may
      // carry the same fields — that is the documented one-save reopen.
      const isClosed = accResult.rows[0].closed;
      const mutatesFields =
        name !== undefined ||
        note !== undefined ||
        working_balance_cents !== undefined ||
        user_id !== undefined ||
        link !== undefined;
      if (isClosed && closed !== false && mutatesFields) {
        throw new HttpError(409, 'account is closed — reopen it to make changes');
      }

      // Working-balance edit is an OVERRIDE, not a ledger operation (product
      // decision): the balance is set directly, no adjustment entry is booked.
      // The delta lands in the uncleared bucket — the balance stays unverified
      // until reconciled, and future ledger deltas keep applying on top.
      if (working_balance_cents !== undefined) {
        const current = await client.query<{ cleared_balance: string; uncleared_balance: string }>(
          'SELECT cleared_balance, uncleared_balance FROM accounts WHERE id = $1',
          [accountId],
        );
        const workingMilli = Number(current.rows[0].cleared_balance) + Number(current.rows[0].uncleared_balance);
        const diff = working_balance_cents * 10 - workingMilli;
        if (diff !== 0) {
          await client.query('UPDATE accounts SET uncleared_balance = uncleared_balance + $1 WHERE id = $2', [
            diff,
            accountId,
          ]);
        }
      }

      if (closed !== undefined) {
        // 0004 sync invariant: account_group tracks closed state.
        await client.query(
          "UPDATE accounts SET closed = $2, account_group = CASE WHEN $2 THEN 'CLOSED'::account_group ELSE CASE WHEN type IN ('creditCard','lineOfCredit') THEN 'CREDIT'::account_group ELSE 'CASH'::account_group END END WHERE id = $1",
          [accountId, closed],
        );
      }

      if (name !== undefined && name !== accResult.rows[0].name && accResult.rows[0].type === 'creditCard' && accResult.rows[0].on_budget) {
        // Keep the name-linked payment category in step (live, in the CCP group, no clash).
        await client.query(
          `UPDATE categories c SET name = $3
             FROM category_groups g
            WHERE g.id = c.group_id AND g.is_credit_card_payments AND c.budget_id = $1
              AND c.name = $2 AND NOT c.deleted
              AND NOT EXISTS (SELECT 1 FROM categories x WHERE x.group_id = c.group_id AND x.name = $3 AND NOT x.deleted)`,
          [budget_id, accResult.rows[0].name, name],
        );
      }

      if (name !== undefined || note !== undefined) {
        await client.query('UPDATE accounts SET name = COALESCE($2, name), note = $3 WHERE id = $1', [
          accountId,
          name ?? null,
          note ?? null,
        ]);
      }

      if (user_id !== undefined) {
        await assertMemberOrShared(client, budget_id, user_id);
        await client.query('UPDATE accounts SET user_id = $2 WHERE id = $1', [accountId, user_id]);
      }

      if (link !== undefined) {
        if (link.connectionId == null) {
          // Unlink: the account stays, it just loses its bank link.
          await client.query(
            'UPDATE accounts SET connection_id = NULL, external_account_id = NULL, institution = NULL WHERE id = $1',
            [accountId],
          );
        } else {
          if (!link.externalAccountId) {
            throw new HttpError(400, 'link.externalAccountId is required when linking');
          }
          // Owner-or-admin on the connection: another user's connection id is
          // indistinguishable from a bogus one — 404 either way.
          const conn = await client.query<{ institution: string | null; status: string }>(
            'SELECT institution, status FROM connections WHERE id = $1 AND user_id = $2',
            [link.connectionId, user.id],
          );
          if (conn.rows.length === 0) throw new HttpError(404, 'connection not found');
          // Strict 1:1: an upstream account may back only one budget account
          // (0021 unique index is the backstop — this check gives the 409).
          const taken = await client.query<{ id: string }>(
            `SELECT id FROM accounts
            WHERE connection_id = $2 AND external_account_id = $3 AND id <> $1 AND NOT deleted`,
            [accountId, link.connectionId, link.externalAccountId],
          );
          if (taken.rows.length > 0) {
            throw new HttpError(409, `that bank account is already linked to another budget account`);
          }
          await client.query(
            'UPDATE accounts SET connection_id = $2, external_account_id = $3, institution = $4 WHERE id = $1',
            [accountId, link.connectionId, link.externalAccountId, link.institution ?? conn.rows[0].institution],
          );
        }
      }

      await client.query('COMMIT');
      const row = await client.query('SELECT * FROM accounts WHERE id = $1', [accountId]);
      return row.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
);

const reconcileAccount = implement(
  accountsReconcile,
  async (_c, { id: accountId, budget_id, stated_balance_cents, reconcile_all }) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const accResult = await client.query<{
        budget_id: string;
        closed: boolean;
      }>('SELECT budget_id, closed FROM accounts WHERE id = $1', [accountId]);
      // The account must exist AND belong to the budget in the request body;
      // otherwise the payee/adjustment rows below would be written cross-budget.
      if (accResult.rows.length === 0 || accResult.rows[0].budget_id !== budget_id) {
        throw new HttpError(404, 'account not found');
      }
      // Closed accounts are immutable — balances can no longer change.
      if (accResult.rows[0].closed) {
        throw new HttpError(409, 'account is closed — reopen it to reconcile');
      }

      // YNAB's "Yes": the on-screen balance already matches the bank, so every
      // row — pending ones included — is known-good. Lock everything as
      // reconciled with no adjustment; the balance columns just fold the
      // uncleared remainder into cleared (totals unchanged).
      if (reconcile_all) {
        await client.query(
          "UPDATE transactions SET cleared = 'reconciled' WHERE account_id = $1 AND deleted = false AND cleared <> 'reconciled'",
          [accountId],
        );
        await client.query(
          'UPDATE accounts SET cleared_balance = cleared_balance + uncleared_balance, uncleared_balance = 0, last_reconciled_at = NOW() WHERE id = $1',
          [accountId],
        );
        await client.query('COMMIT');
        return;
      }

      // The stated balance is what the user has in the account: the target
      // WORKING balance (cleared + uncleared). Diff against the real ledger sum
      // (same live-row filter as recomputeAccountBalances; split legs are
      // separate rows that carry no amount into the sum) so a stale cache or a
      // working-balance override (no ledger row) is absorbed by the adjustment.
      const sumResult = await client.query<{ total: string }>(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE account_id = $1 AND NOT deleted AND NOT upcoming',
        [accountId],
      );
      const statedMilli = stated_balance_cents * 10;
      const diff = statedMilli - Number(sumResult.rows[0].total);

      if (diff !== 0) {
        const payeeResult = await client.query<{ id: string }>(
          `INSERT INTO payees (budget_id, name)
         VALUES ($1, $2)
         ON CONFLICT (budget_id, name) DO UPDATE SET name = $2
         RETURNING id`,
          [budget_id, 'Reconciliation Adjustment'],
        );
        const payeeId = payeeResult.rows[0].id;
        await client.query(
          `INSERT INTO transactions
          (budget_id, account_id, date, payee_id, category_id, memo, amount, cleared, approved, repeat, deleted)
         VALUES ($1, $2, CURRENT_DATE, $3, NULL, 'auto', $4, 'reconciled', true, 'never', false)`,
          [budget_id, accountId, payeeId, diff],
        );
      }

      await client.query(
        "UPDATE transactions SET cleared = 'reconciled' WHERE account_id = $1 AND deleted = false AND cleared <> 'reconciled'",
        [accountId],
      );
      await client.query('UPDATE accounts SET cleared_balance = $1, uncleared_balance = 0, last_reconciled_at = NOW() WHERE id = $2', [
        statedMilli,
        accountId,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
);

/**
 * DELETE /accounts/:id — delete a closed account and every transaction it
 * ever held. Soft-delete (0004 `deleted` flags) so restores stay possible;
 * the account vanishes from GET / (deleted = false) and its transfer payee
 * is retired with it.
 *
 * Peer transfer legs in other accounts stay (the money really left them) and
 * are re-pointed from the dead "Transfer : <name>" payee to a plain payee
 * named after the deleted account, so Ready-to-Assign math keeps treating
 * them as internal moves once the name no longer resolves as a transfer.
 * Balances are zeroed server-side — they already absorb every live row, so
 * zeroing is the exact reverse; no client delta contract like
 * DELETE /transactions/:id.
 */
const deleteAccount = implement(accountsDelete, async (_c, { id: accountId, budget_id: budgetId }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const acc = (
      await client.query<{ budget_id: string; closed: boolean; name: string; transfer_payee_id: string | null }>(
        'SELECT budget_id, closed, name, transfer_payee_id FROM accounts WHERE id = $1 AND deleted = false FOR UPDATE',
        [accountId],
      )
    ).rows[0];
    if (!acc || acc.budget_id !== budgetId) throw new HttpError(404, 'account not found');
    if (!acc.closed) throw new HttpError(409, 'account must be closed before it can be deleted');

    // Splits ride on the parent's deleted flag on read; soft-deleting the
    // parents suffices. Upcoming rows are ordinary transactions (repeat-rule
    // materializations) — they ride along and are never balance-moving, so
    // zeroing the account covers every bucket.
    await client.query('UPDATE transactions SET deleted = true WHERE account_id = $1 AND deleted = false', [accountId]);

    // Repeat rules pointed at the account — as their home account or as the
    // target of a recurring transfer — would re-materialize rows into/for a
    // deleted account on their next tick. Retire them with it; their (already
    // soft-deleted) occurrences keep the rule reference via the FK, so rules
    // are flagged, never hard-deleted.
    await client.query(
      `UPDATE txn_repeat_rules SET deleted = true
       WHERE deleted = false AND (account_id = $1 OR payee_id = $2)`,
      [accountId, acc.transfer_payee_id],
    );

    await client.query('UPDATE accounts SET cleared_balance = 0, uncleared_balance = 0, deleted = true WHERE id = $1', [
      accountId,
    ]);

    // Re-point surviving transfer legs to a plain payee named after the
    // deleted account (find-or-create, same mechanic as reconciliation's),
    // then retire the transfer payee — nothing live references it anymore and
    // a dangling "Transfer : <name>" would linger in Manage Payees.
    const plain = (
      await client.query<{ id: string }>(
        `INSERT INTO payees (budget_id, name)
         VALUES ($1, $2)
         ON CONFLICT (budget_id, name) DO UPDATE SET name = $2
         RETURNING id`,
        [budgetId, acc.name],
      )
    ).rows[0]!.id;
    await client.query('UPDATE transactions SET payee_id = $2 WHERE payee_id = $1 AND deleted = false', [
      acc.transfer_payee_id,
      plain,
    ]);
    await client.query(
      'UPDATE payees SET transfer_account_id = NULL, deleted = true WHERE id = $1 AND deleted = false',
      [acc.transfer_payee_id],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export const operations = [
  implement(accountsList, async (_c, { budget_id }) => {
    // linked_by: whoever owns the bank connection behind a linked account — a
    // budget member's name/email/avatar only, never the connection itself
    // (connections stay owner-scoped).
    const result = await pool.query<PersonRefRow & Record<string, unknown>>(
      `SELECT a.*, ${personRefSql('u')}
         FROM accounts a
         LEFT JOIN connections c ON c.id = a.connection_id
         LEFT JOIN users u ON u.id = c.user_id
        WHERE a.budget_id = $1 AND a.deleted = false
        ORDER BY a.sort_order`,
      [budget_id],
    );
    return result.rows.map(({ ref_user_id, ref_name, ref_email, avatar_seed, avatar_image_version, ...account }) => ({
      ...account,
      linked_by: toPersonRef({ ref_user_id, ref_name, ref_email, avatar_seed, avatar_image_version }),
    }));
  }),
  createAccount,
  updateAccount,
  reconcileAccount,
  deleteAccount,
];

export default budgetRouter('/accounts', operations);
