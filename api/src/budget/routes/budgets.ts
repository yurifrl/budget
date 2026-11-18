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
import { claimUnownedBudgets } from '../ownership';
import { budgetRouter } from '../router';
import * as budgetsStore from '../store/budgets';
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
      if (await budgetsStore.anyUnownedBudget(pool)) await claimUnownedBudgets(user.id);
    }

    const rows =
      user.role === 'admin'
        ? await budgetsStore.listAllBudgets(pool)
        : await budgetsStore.listAccessibleBudgets(pool, user.id);
    return c.json(rows);
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
      const current = await budgetsStore.lockOwnedBudget(client, body.budget_id, user);
      // Early exits happen before any write: the transaction only holds the
      // row lock, so the COMMIT withTransaction issues has the same effect as
      // the explicit ROLLBACK these exits used to send.
      if (!current) return c.json({ error: 'not_found' }, 404);
      if (current.archived_at !== null) return c.json({ error: 'already_archived' }, 409);
      // "Casa" → "Casa 2026-10-24 14:05" — the timestamp is the access key for
      // the archive (visible in the switcher row itself), so it lands in the
      // name AND the archived_at column.
      const archived = await budgetsStore.archiveWithTimestampedName(client, body.budget_id);
      // Fresh start keeps the original name on the new instance.
      const created = await budgetsStore.insertBudgetReturningArchive(client, current.name, user.id);
      // The household carries over: same members, plus the (possibly admin)
      // caller who is now the owner.
      await budgetsStore.copyMembersPlusCaller(client, body.budget_id, created.id, user.id);
      const oldId = body.budget_id;
      const newId = created.id;

      await budgetsStore.copyBudgetForFreshStart(client, oldId, newId);

      return c.json({ archived, created });
    });
  }),

  implement(budgetCreate, async (c, body) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    return withTransaction(pool, async (client) => {
      // Ownership resolves from the request identity — never the client body.
      const budget = await budgetsStore.insertBudget(client, body.name, user.id);
      await budgetsStore.insertBudgetMember(client, budget.id, user.id);
      await budgetsStore.insertDefaultGroup(client, budget.id);
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
    const updated = await budgetsStore.renameOwnedBudget(pool, body.id, body.name, user);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json(updated);
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
    const archived = await budgetsStore.archiveOwnedBudget(pool, id, user);
    if (!archived) return c.json({ error: 'not_found' }, 404);
    return c.json(archived);
  }),

  /**
   * Unarchive a budget (Configure pane): clears archived_at, returning it to
   * the active Open Budget list. Idempotent like archive. Owner-or-admin.
   */
  implement(budgetUnarchive, async (c, { id }) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const restored = await budgetsStore.unarchiveOwnedBudget(pool, id, user);
    if (!restored) return c.json({ error: 'not_found' }, 404);
    return c.json(restored);
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
    const deleted = await budgetsStore.deleteOwnedBudget(pool, id, user);
    if (!deleted) return c.json({ error: 'not_found' }, 404);
    return c.json({ deleted: true });
  }),
];


export default budgetRouter('/budgets', operations, { guarded: false });
