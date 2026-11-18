import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import {
  budgetArchive,
  budgetCreate,
  budgetDelete,
  budgetFreshStart,
  budgetList,
  budgetRename,
  budgetUnarchive,
} from '@shared/contracts/budget';
import { accessibleBudgetSql, claimUnownedBudgets, ownerOrAdminSql } from '../ownership';
import { budgetRouter } from '../router';
import { authDisabled, DEV_EMAIL, type IdentityUser } from '../../user';

export const operations = [
  /**
   * Budget list — owner-scoped (USER-05): admins see every budget, everyone
   * else only budgets they own or are members of. The app's first call is usually this list, so
   * it doubles as the claim-on-first-login trigger (USER-04): session humans
   * sweep unowned budgets into their ownership before the filter applies.
   * Only app session logins claim: the service bearer lane (no principal) and
   * OAuth access tokens (MCP/CLI — principal carries grantId/scope) never
   * claim, so they see only what they own or are members of.
   */
  implement(budgetList, async (c) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);

    const principal = c.get('principal');
    // The dev bypass (auth unconfigured, no principal, the synthetic dev user)
    // is the one local human, so it claims like a first real sign-in; the
    // service lane (a different identity, and only exists with auth on) never does.
    const humanSession = principal
      ? principal.grantId === undefined && principal.scope === undefined
      : authDisabled() && user.email === DEV_EMAIL;
    if (humanSession) {
      const unowned = await pool.query('SELECT 1 FROM public.budgets WHERE owner_user_id IS NULL LIMIT 1');
      if ((unowned.rowCount ?? 0) > 0) await claimUnownedBudgets(user.id);
    }

    const result =
      user.role === 'admin'
        ? await pool.query('SELECT id, name, archived_at FROM public.budgets ORDER BY created_at')
        : await pool.query(
            `SELECT id, name, archived_at FROM public.budgets b
            WHERE ${accessibleBudgetSql('b', '$1')} ORDER BY created_at`,
            [user.id],
          );
    return c.json(result.rows);
  }),

  /**
   * Fresh Start — archive the current budget and create a replacement in a
   * single transaction (AUTHORED-06, YNAB parity): the previous instance
   * survives with every row (nothing is deleted), renamed to
   * "<name> <archive timestamp>" and marked with archived_at. The replacement
   * keeps the original name and carries over a curated subset — all accounts
   * (linked ones keep today's balance and their transaction history through
   * today; unlinked ones reset to $0 with no transactions), repeat rules, the
   * category structure with goals/notes/targets, saved payees and rename
   * rules — while assignments and month notes reset so the plan starts empty.
   *
   * Every carry-over is a set-based INSERT … SELECT keyed through temporary
   * id-map tables (ON COMMIT DROP), so cross-budget FKs (payee → account,
   * transaction → category, split leg → parent) repoint at the fresh rows
   * without per-row round trips.
   */
  implement(budgetFreshStart, async (c, body) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    return withTransaction(pool, async (client) => {
      const current = await client.query<Pick<BudgetRow, 'id' | 'name' | 'archived_at'>>(
        `SELECT id, name, archived_at FROM public.budgets
         WHERE id = $1
           AND ${ownerOrAdminSql('budgets', '$2', '$3')}
         FOR UPDATE`,
        [body.budget_id, user.id, user.role],
      );
      // Early exits end the transaction here; the COMMIT withTransaction then
      // issues is a no-op (server WARNING), as before the refactor.
      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        return c.json({ error: 'not_found' }, 404);
      }
      if (current.rows[0].archived_at !== null) {
        await client.query('ROLLBACK');
        return c.json({ error: 'already_archived' }, 409);
      }
      // "Casa" → "Casa 2026-10-24 14:05" — the timestamp is the access key for
      // the archive (visible in the switcher row itself), so it lands in the
      // name AND the archived_at column.
      const archived = await client.query<BudgetRow>(
        `UPDATE public.budgets
         SET name = name || ' ' || to_char(now(), 'YYYY-MM-DD HH24:MI'),
             archived_at = now()
       WHERE id = $1
       RETURNING id, name, archived_at`,
        [body.budget_id],
      );
      // Fresh start keeps the original name on the new instance.
      const budgetResult = await client.query<BudgetRow>(
        'INSERT INTO budgets (name, owner_user_id) VALUES ($1, $2) RETURNING id, name, archived_at',
        [current.rows[0].name, user.id],
      );
      const created = budgetResult.rows[0];
      // The household carries over: same members, plus the (possibly admin)
      // caller who is now the owner.
      await client.query(
        `INSERT INTO public.budget_members (budget_id, user_id)
       SELECT $2::uuid, user_id FROM public.budget_members WHERE budget_id = $1
       UNION SELECT $2::uuid, $3::uuid
       ON CONFLICT DO NOTHING`,
        [body.budget_id, created.id, user.id],
      );
      const oldId = body.budget_id;
      const newId = created.id;

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

      return c.json({ archived: archived.rows[0], created });
    });
  }),

  implement(budgetCreate, async (c, body) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    return withTransaction(pool, async (client) => {
      // Ownership resolves from the request identity — never the client body.
      const budgetResult = await client.query<BudgetRow>(
        'INSERT INTO budgets (name, owner_user_id) VALUES ($1, $2) RETURNING id, name',
        [body.name, user.id],
      );
      const budget = budgetResult.rows[0];
      await client.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2)', [
        budget.id,
        user.id,
      ]);
      await client.query('INSERT INTO category_groups (budget_id, name, sort_order) VALUES ($1, $2, $3)', [
        budget.id,
        'Geral',
        0,
      ]);
      return c.json(budget);
    });
  }),

  /**
   * Rename a budget (Plan Settings). Owner-or-admin like every budget-data
   * route (USER-05): cross-owner renames surface as 404, never 403.
   */
  implement(budgetRename, async (c, body) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const updated = await pool.query(
      `UPDATE public.budgets
       SET name = $1
     WHERE id = $2
       AND ${ownerOrAdminSql('budgets', '$3', '$4')}
     RETURNING id, name`,
      [body.name, body.id, user.id, user.role],
    );
    if (updated.rows.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.json(updated.rows[0]);
  }),

  /**
   * Archive a budget (Configure pane): stamps archived_at so it moves to the
   * Open Budget ARCHIVED section. Idempotent — archiving an archived budget
   * returns its existing row. Owner-or-admin (USER-05): cross-owner calls
   * surface as 404, never 403.
   */
  implement(budgetArchive, async (c, { id }) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const archived = await pool.query(
      `UPDATE public.budgets SET archived_at = now()
       WHERE id = $1
         AND ${ownerOrAdminSql('budgets', '$2', '$3')}
     RETURNING id, name, archived_at`,
      [id, user.id, user.role],
    );
    if (archived.rows.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.json(archived.rows[0]);
  }),

  /**
   * Unarchive a budget (Configure pane): clears archived_at, returning it to
   * the active Open Budget list. Idempotent like archive. Owner-or-admin.
   */
  implement(budgetUnarchive, async (c, { id }) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const restored = await pool.query(
      `UPDATE public.budgets SET archived_at = NULL
       WHERE id = $1
         AND ${ownerOrAdminSql('budgets', '$2', '$3')}
     RETURNING id, name, archived_at`,
      [id, user.id, user.role],
    );
    if (restored.rows.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.json(restored.rows[0]);
  }),

  /**
   * Permanently delete a budget: every budget-scoped table references
   * public.budgets(id) ON DELETE CASCADE (0001_budget_schema), so this one
   * statement wipes accounts, transactions, categories, payees, rules and
   * targets. Owner-or-admin; cross-owner deletes surface as 404.
   */
  implement(budgetDelete, async (c, { id }) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const deleted = await pool.query(
      `DELETE FROM public.budgets
       WHERE id = $1
         AND ${ownerOrAdminSql('budgets', '$2', '$3')}
       RETURNING id`,
      [id, user.id, user.role],
    );
    if (deleted.rows.length === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ deleted: true });
  }),
];

export interface BudgetRow {
  id: string;
  name: string;
  /** Null for active budgets; the archive moment for archived ones. */
  archived_at: string | null;
}

export default budgetRouter('/budgets', operations, { guarded: false });
