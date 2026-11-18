/**
 * Budget store: budgets (list, create, rename, archive, delete, fresh start).
 * SQL only (moved verbatim from routes/budgets.ts); every function takes a
 * Queryable. Owner/member predicates come from ../ownership.
 */
import type { Queryable } from '../../core/db';
import { accessibleBudgetSql, ownerOrAdminSql } from '../ownership';

export interface BudgetRow {
  id: string;
  name: string;
  /** Null for active budgets; the archive moment for archived ones. */
  archived_at: string | null;
}

export async function anyUnownedBudget(db: Queryable): Promise<boolean> {
  const unowned = await db.query('SELECT 1 FROM public.budgets WHERE owner_user_id IS NULL LIMIT 1');
  return (unowned.rowCount ?? 0) > 0;
}

/** Every budget (admin view). */
export async function listAllBudgets(db: Queryable) {
  return (await db.query('SELECT id, name, archived_at FROM public.budgets ORDER BY created_at')).rows;
}

/** Budgets the user owns or is a member of. */
export async function listAccessibleBudgets(db: Queryable, userId: string) {
  return (
    await db.query(
      `SELECT id, name, archived_at FROM public.budgets b
            WHERE ${accessibleBudgetSql('b', '$1')} ORDER BY created_at`,
      [userId],
    )
  ).rows;
}

/** Lock the budget for a fresh start when the caller owns it (or is admin). */
export async function lockOwnedBudget(
  db: Queryable,
  budgetId: string,
  user: { id: string; role: string },
): Promise<Pick<BudgetRow, 'id' | 'name' | 'archived_at'> | undefined> {
  const current = await db.query<Pick<BudgetRow, 'id' | 'name' | 'archived_at'>>(
    `SELECT id, name, archived_at FROM public.budgets
         WHERE id = $1
           AND ${ownerOrAdminSql('budgets', '$2', '$3')}
         FOR UPDATE`,
    [budgetId, user.id, user.role],
  );
  return current.rows[0];
}

/** Archive with the timestamp appended to the name ("Casa" -> "Casa 2026-10-24 14:05"). */
export async function archiveWithTimestampedName(db: Queryable, budgetId: string): Promise<BudgetRow> {
  const archived = await db.query<BudgetRow>(
    `UPDATE public.budgets
         SET name = name || ' ' || to_char(now(), 'YYYY-MM-DD HH24:MI'),
             archived_at = now()
       WHERE id = $1
       RETURNING id, name, archived_at`,
    [budgetId],
  );
  return archived.rows[0];
}

/** New budget row (fresh start: returns id, name, archived_at). */
export async function insertBudgetReturningArchive(db: Queryable, name: string, ownerId: string): Promise<BudgetRow> {
  const budgetResult = await db.query<BudgetRow>(
    'INSERT INTO budgets (name, owner_user_id) VALUES ($1, $2) RETURNING id, name, archived_at',
    [name, ownerId],
  );
  return budgetResult.rows[0];
}

/** The old budget's members plus the caller become the new budget's members. */
export async function copyMembersPlusCaller(db: Queryable, oldId: string, newId: string, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO public.budget_members (budget_id, user_id)
       SELECT $2::uuid, user_id FROM public.budget_members WHERE budget_id = $1
       UNION SELECT $2::uuid, $3::uuid
       ON CONFLICT DO NOTHING`,
    [oldId, newId, userId],
  );
}

/**
 * Fresh-start carry-over from `oldId` into `newId`, inside the caller's
 * transaction (the temp id-map tables are ON COMMIT DROP): payees, accounts
 * (linked ones keep balance and history through today), plan structure,
 * repeat rules with their upcoming rows, targets, category notes, payee
 * default categories. Assignments and month notes are not copied.
 */
export async function copyBudgetForFreshStart(client: Queryable, oldId: string, newId: string): Promise<void> {
  // Temp old→new id maps, dropped with the transaction (no leak, no naming
  // collisions between concurrent fresh-starts). Every copy pairs rows
  // through a `src` CTE that generates the new id right next to the old one,
  // so the maps are exact — never rebuilt by name (names are not unique).
  await client.query(`CREATE TEMP TABLE acc_map (old uuid PRIMARY KEY, new uuid NOT NULL) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE pay_map (old uuid PRIMARY KEY, new uuid NOT NULL) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE grp_map (old uuid PRIMARY KEY, new uuid NOT NULL) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE cat_map (old uuid PRIMARY KEY, new uuid NOT NULL) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE txn_map (old uuid PRIMARY KEY, new uuid NOT NULL) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE rule_map (old uuid PRIMARY KEY, new uuid NOT NULL) ON COMMIT DROP`);

  // ---- payees (YNAB: payees carry). transfer_account_id and
  // default_category_id are cross-table pointers — patched from the maps
  // once their targets exist.
  await client.query(
    `WITH src AS (
     SELECT id AS old_id, gen_random_uuid() AS new_id, name, hidden, deleted,
            categorization_mode, rename_match_type, rename_condition
       FROM payees WHERE budget_id = $1
   ), ins AS (
     INSERT INTO payees (id, budget_id, name, hidden, deleted,
                         categorization_mode, rename_match_type, rename_condition)
     SELECT new_id, $2, name, hidden, deleted,
            categorization_mode, rename_match_type, rename_condition
       FROM src
   )
   INSERT INTO pay_map SELECT old_id, new_id FROM src`,
    [oldId, newId],
  );

  // ---- accounts (YNAB: "All your accounts"). Linked accounts keep today's
  // balance — the materialized cleared/uncleared pair, the same value the
  // app treats as authoritative; unlinked ones reset to zero so the fresh
  // plan starts from actuals only. connection_id/external_account_id
  // survive so linked accounts stay linked; transfer_payee_id is patched
  // from the maps below.
  await client.query(
    `WITH src AS (
     SELECT id AS old_id, gen_random_uuid() AS new_id, name, type, account_group,
            on_budget,
            CASE WHEN direct_import_linked THEN cleared_balance ELSE 0 END AS cleared_balance,
            CASE WHEN direct_import_linked THEN uncleared_balance ELSE 0 END AS uncleared_balance,
            sort_order, created_at, closed, note, direct_import_linked,
            direct_import_in_error, debt_interest_rates, debt_minimum_payments,
            debt_escrow_amounts, deleted, connection_id, external_account_id, institution, user_id
       FROM accounts WHERE budget_id = $1
   ), ins AS (
     INSERT INTO accounts
       (id, budget_id, name, type, account_group, on_budget, cleared_balance,
        uncleared_balance, sort_order, created_at, closed, note, direct_import_linked,
        direct_import_in_error, debt_interest_rates, debt_minimum_payments,
        debt_escrow_amounts, deleted, connection_id, external_account_id, institution, user_id)
     SELECT new_id, $2, name, type, account_group, on_budget, cleared_balance,
            uncleared_balance, sort_order, created_at, closed, note, direct_import_linked,
            direct_import_in_error, debt_interest_rates, debt_minimum_payments,
            debt_escrow_amounts, deleted, connection_id, external_account_id, institution, user_id
       FROM src
   )
   INSERT INTO acc_map SELECT old_id, new_id FROM src`,
    [oldId, newId],
  );
  // Transfer links: the copied "Transfer : <name>" payee points at the new
  // account; the new account points back at the copied payee.
  await client.query(
    `UPDATE payees p_new SET transfer_account_id = acc.new
     FROM pay_map pay, acc_map acc, payees p_old
    WHERE p_new.budget_id = $1 AND pay.new = p_new.id
      AND pay.old = p_old.id AND p_old.transfer_account_id = acc.old`,
    [newId],
  );
  await client.query(
    `UPDATE accounts a_new SET transfer_payee_id = pay.new
     FROM acc_map acc, accounts a_old, pay_map pay
    WHERE a_new.budget_id = $1 AND acc.new = a_new.id
      AND acc.old = a_old.id AND a_old.transfer_payee_id = pay.old`,
    [newId],
  );
  // Belt-and-braces: an account without a transfer payee gets a fresh one
  // (mirrors the account-create convention).
  await client.query(
    `INSERT INTO payees (budget_id, name, transfer_account_id, hidden, deleted)
   SELECT $1, 'Transfer : ' || a.name, a.id, false, false
     FROM accounts a
    WHERE a.budget_id = $1 AND a.transfer_payee_id IS NULL
   ON CONFLICT DO NOTHING`,
    [newId],
  );
  await client.query(
    `UPDATE accounts a SET transfer_payee_id = p.id
     FROM payees p WHERE a.budget_id = $1 AND p.budget_id = $1
       AND p.transfer_account_id = a.id AND a.transfer_payee_id IS NULL`,
    [newId],
  );

  // ---- plan structure maps (YNAB: groups + categories carry; assignments
  // reset — the plan starts empty). Built before the transaction copy:
  // every carried txn/rule references its category through cat_map. No name
  // joins — the maps are captured at insert time.
  await client.query(
    `WITH src AS (
     SELECT id AS old_id, gen_random_uuid() AS new_id, name, sort_order,
            is_credit_card_payments, hidden, internal, deleted
       FROM category_groups WHERE budget_id = $1
   ), ins AS (
     INSERT INTO category_groups
       (id, budget_id, name, sort_order, is_credit_card_payments, hidden, internal, deleted)
     SELECT new_id, $2, name, sort_order, is_credit_card_payments, hidden, internal, deleted
       FROM src
   )
   INSERT INTO grp_map SELECT old_id, new_id FROM src`,
    [oldId, newId],
  );
  await client.query(
    `WITH src AS (
     SELECT c.id AS old_id, gen_random_uuid() AS new_id,
            c.group_id, c.name, c.sort_order, c.note, c.hidden, c.internal,
            c.deleted, c.goal_type, c.goal_needs_whole_amount, c.goal_day,
            c.goal_cadence, c.goal_cadence_frequency, c.goal_creation_month,
            c.goal_target, c.goal_target_date, c.goal_snoozed_at, c.user_id
       FROM categories c WHERE c.budget_id = $1
   ), ins AS (
     INSERT INTO categories
       (id, budget_id, group_id, name, sort_order, note, hidden, internal,
        deleted, goal_type, goal_needs_whole_amount, goal_day, goal_cadence,
        goal_cadence_frequency, goal_creation_month, goal_target,
        goal_target_date, goal_snoozed_at, user_id)
     SELECT s.new_id, $2, grp.new, s.name, s.sort_order, s.note, s.hidden,
            s.internal, s.deleted, s.goal_type, s.goal_needs_whole_amount,
            s.goal_day, s.goal_cadence, s.goal_cadence_frequency,
            s.goal_creation_month, s.goal_target, s.goal_target_date,
            s.goal_snoozed_at, s.user_id
       FROM src s
       JOIN grp_map grp ON grp.old = s.group_id
   )
   INSERT INTO cat_map SELECT old_id, new_id FROM src`,
    [oldId, newId],
  );

  // ---- transactions (linked accounts carry history through today).
  // The partial unique index on (account_id, import_id) among live rows
  // makes the straight copy collision-free; upcoming occurrences (which
  // withhold their balance delta) are excluded here — the rules step below
  // copies them with the rule they belong to. Split parents are inserted
  // before their legs (FK transaction_id), with splits re-aggregated
  // server-side so the register total can't drift from the legs.
  await client.query(
    `WITH src AS (
     SELECT t.id AS old_id, gen_random_uuid() AS new_id,
            t.date, t.amount, t.payee_id, t.category_id, t.memo,
            t.cleared, t.approved, t.flag_color, t.flag_name,
            t.transfer_account_id,
            t.import_id, t.import_payee_name, t.import_payee_name_original,
            t.debt_transaction_type, t.repeat,
            acc.new AS new_account_id
       FROM transactions t
       JOIN acc_map acc ON acc.old = t.account_id
       JOIN accounts a_old ON a_old.id = acc.old
      WHERE t.budget_id = $1 AND NOT t.deleted
        AND NOT t.upcoming
        AND t.date <= current_date
        AND a_old.direct_import_linked
   ), ins AS (
     INSERT INTO transactions
       (id, budget_id, account_id, date, amount, payee_id, category_id, memo,
        cleared, approved, flag_color, flag_name,
        transfer_account_id, transfer_transaction_id,
        import_id, import_payee_name, import_payee_name_original,
        debt_transaction_type, matched_transaction_id, repeat, deleted)
     SELECT s.new_id, $2, s.new_account_id, s.date, s.amount, pay.new, cat.new, s.memo,
            s.cleared, s.approved, s.flag_color, s.flag_name,
            acc2.new, NULL,
            s.import_id, s.import_payee_name, s.import_payee_name_original,
            s.debt_transaction_type, NULL, s.repeat, false
       FROM src s
       LEFT JOIN acc_map acc2 ON acc2.old = s.transfer_account_id
       LEFT JOIN pay_map pay ON pay.old = s.payee_id
       LEFT JOIN cat_map cat ON cat.old = s.category_id
   )
   INSERT INTO txn_map SELECT old_id, new_id FROM src`,
    [oldId, newId],
  );
  // Split legs follow their parents through the txn map.
  await client.query(
    `INSERT INTO subtransactions
     (budget_id, transaction_id, amount, memo, payee_id, category_id,
      transfer_account_id, transfer_transaction_id, deleted)
   SELECT $2, tmap.new, s.amount, s.memo, pay.new, cat.new,
          acc2.new, NULL, false
     FROM subtransactions s
     JOIN transactions t_old ON t_old.id = s.transaction_id AND t_old.budget_id = $1
     JOIN txn_map tmap ON tmap.old = t_old.id
     LEFT JOIN pay_map pay ON pay.old = s.payee_id
     LEFT JOIN cat_map cat ON cat.old = s.category_id
     LEFT JOIN acc_map acc2 ON acc2.old = s.transfer_account_id`,
    [oldId, newId],
  );

  // ---- repeat rules + their upcoming occurrences (scheduled transactions
  // carry; future stays scheduled). Rules for ALL accounts copy — a rule on
  // an unlinked account still belongs to the fresh plan. Upcoming rows copy
  // through rule_map with their delta still withheld, exactly as
  // generateDueOccurrences materializes them.
  await client.query(
    `WITH src AS (
     SELECT r.id AS old_id, gen_random_uuid() AS new_id,
            r.account_id, r.payee_id, r.category_id, r.memo, r.amount,
            r.frequency, r.next_due_date, r.month_last_day, r.deleted
       FROM txn_repeat_rules r
      WHERE r.budget_id = $1
   ), ins AS (
     INSERT INTO txn_repeat_rules
       (id, budget_id, account_id, payee_id, category_id, memo, amount,
        frequency, next_due_date, month_last_day, deleted)
     SELECT s.new_id, $2, acc.new, pay.new, cat.new, s.memo, s.amount,
            s.frequency, s.next_due_date, s.month_last_day, s.deleted
       FROM src s
       JOIN acc_map acc ON acc.old = s.account_id
       LEFT JOIN pay_map pay ON pay.old = s.payee_id
       LEFT JOIN cat_map cat ON cat.old = s.category_id
   )
   INSERT INTO rule_map SELECT old_id, new_id FROM src`,
    [oldId, newId],
  );
  await client.query(
    `INSERT INTO transactions
     (budget_id, account_id, date, amount, payee_id, category_id, memo,
      cleared, approved, repeat, repeat_rule_id, occurrence_date, upcoming, deleted)
   SELECT $2, acc.new, t_old.date, t_old.amount, pay.new, cat.new, t_old.memo,
          'uncleared', true, t_old.repeat, rmap.new, t_old.occurrence_date, true, false
     FROM transactions t_old
     JOIN txn_repeat_rules r_old ON r_old.id = t_old.repeat_rule_id
     JOIN rule_map rmap ON rmap.old = r_old.id
     JOIN acc_map acc ON acc.old = t_old.account_id
     LEFT JOIN pay_map pay ON pay.old = t_old.payee_id
     LEFT JOIN cat_map cat ON cat.old = t_old.category_id
    WHERE t_old.budget_id = $1 AND t_old.upcoming AND NOT t_old.deleted`,
    [oldId, newId],
  );

  // ---- targets, notes, payee pointers (assignments reset — YNAB parity).
  // YNAB targets carry; assignments (budgeted amounts) reset.
  await client.query(
    `INSERT INTO category_targets (budget_id, category_id, kind, amount_cents, config, snooze_month)
   SELECT $2, cat.new, t.kind, t.amount_cents, t.config, t.snooze_month
     FROM category_targets t
     JOIN cat_map cat ON cat.old = t.category_id
    WHERE t.budget_id = $1`,
    [oldId, newId],
  );
  // Category notes carry (all months); month notes reset.
  await client.query(
    `INSERT INTO category_notes (budget_id, category_id, month, note)
   SELECT $2, cat.new, n.month, n.note
     FROM category_notes n
     JOIN cat_map cat ON cat.old = n.category_id
    WHERE n.budget_id = $1`,
    [oldId, newId],
  );
  await client.query(
    `UPDATE payees p_new SET default_category_id = cat.new
     FROM pay_map pay, cat_map cat, payees p_old
    WHERE p_new.budget_id = $1 AND pay.new = p_new.id
      AND pay.old = p_old.id AND p_old.default_category_id = cat.old`,
    [newId],
  );
}

/** New budget row (create: returns id, name). */
export async function insertBudget(db: Queryable, name: string, ownerId: string): Promise<BudgetRow> {
  const budgetResult = await db.query<BudgetRow>(
    'INSERT INTO budgets (name, owner_user_id) VALUES ($1, $2) RETURNING id, name',
    [name, ownerId],
  );
  return budgetResult.rows[0];
}

export async function insertBudgetMember(db: Queryable, budgetId: string, userId: string): Promise<void> {
  await db.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2)', [budgetId, userId]);
}

export async function insertDefaultGroup(db: Queryable, budgetId: string): Promise<void> {
  await db.query('INSERT INTO category_groups (budget_id, name, sort_order) VALUES ($1, $2, $3)', [budgetId, 'Geral', 0]);
}

type Caller = { id: string; role: string };

export async function renameOwnedBudget(db: Queryable, id: string, name: string, user: Caller) {
  const updated = await db.query(
    `UPDATE public.budgets
       SET name = $1
     WHERE id = $2
       AND ${ownerOrAdminSql('budgets', '$3', '$4')}
     RETURNING id, name`,
    [name, id, user.id, user.role],
  );
  return updated.rows[0];
}

export async function archiveOwnedBudget(db: Queryable, id: string, user: Caller) {
  const archived = await db.query(
    `UPDATE public.budgets SET archived_at = now()
       WHERE id = $1
         AND ${ownerOrAdminSql('budgets', '$2', '$3')}
     RETURNING id, name, archived_at`,
    [id, user.id, user.role],
  );
  return archived.rows[0];
}

export async function unarchiveOwnedBudget(db: Queryable, id: string, user: Caller) {
  const restored = await db.query(
    `UPDATE public.budgets SET archived_at = NULL
       WHERE id = $1
         AND ${ownerOrAdminSql('budgets', '$2', '$3')}
     RETURNING id, name, archived_at`,
    [id, user.id, user.role],
  );
  return restored.rows[0];
}

/** Delete (cascades to every budget-scoped table); undefined when not owned. */
export async function deleteOwnedBudget(db: Queryable, id: string, user: Caller) {
  const deleted = await db.query(
    `DELETE FROM public.budgets
       WHERE id = $1
         AND ${ownerOrAdminSql('budgets', '$2', '$3')}
       RETURNING id`,
    [id, user.id, user.role],
  );
  return deleted.rows[0];
}

/** The budget's change revision (bumped by DB triggers, migration 0033); undefined when no such budget. */
export async function getBudgetRevision(db: Queryable, budgetId: string): Promise<string | undefined> {
  const r = await db.query<{ revision: string }>('SELECT revision FROM public.budgets WHERE id = $1', [budgetId]);
  return r.rows[0]?.revision;
}
