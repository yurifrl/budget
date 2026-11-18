/**
 * Budget ownership + membership (v1.1 Phase 2 — USER-03/04/05; sharing).
 *
 * The rule, defined ONCE here: a person reaches a budget only as its owner or
 * as a member (public.budget_members). Everyone else gets 404, never 403, and
 * that includes users with the `admin` role: `admin` is an operator role (the
 * jobs ledger, app-wide settings, claiming legacy unowned budgets), not a
 * pass into other people's budgets. Owner-only actions (fresh start, restore,
 * rename/archive/delete, removing people) use the owner predicate instead.
 *
 * Enforcement is app-layer: budgetAccess is a Hono guard mounted at the top
 * of every budget-data route file. RLS remains a documented future hardening
 * step (the dead is_budget_member RLS blocks from 0004/0011 were deleted).
 *
 * Pre-v1.1 budgets have no owner. The first sign-in of an admin claims them
 * (claim-on-first-login), after which ownership is finalized to NOT NULL.
 *
 * Accounts/transactions/payees/… resolve ownership transitively through
 * their budget_id, so only budgets carry owner_user_id.
 */

import type { MiddlewareHandler } from 'hono';

import { pool, withTransaction } from '../core/db';
import type { IdentityUser } from '../user';
import { isUuid, errorResponse } from '../core/validate';

/** A pool or a checked-out transaction client. */
type Queryable = Pick<typeof pool, 'query'>;

/**
 * SQL predicate: `userParam` (e.g. '$2') may ACCESS the budget row at
 * `budgetAlias` — owner or member, nobody else (no role bypass). The single
 * definition of "can access"; reuse it in any query that scopes budgets to a
 * user.
 */
export function accessibleBudgetSql(budgetAlias: string, userParam: string): string {
  return `(${budgetAlias}.owner_user_id = ${userParam}::uuid OR EXISTS (
    SELECT 1 FROM public.budget_members bm
     WHERE bm.budget_id = ${budgetAlias}.id AND bm.user_id = ${userParam}::uuid))`;
}

/**
 * SQL predicate: `userParam` owns the budget at `budgetAlias`. For owner-only
 * actions (members cannot do them; neither can an admin who is not the owner).
 */
export function ownerSql(budgetAlias: string, userParam: string): string {
  return `(${budgetAlias}.owner_user_id = ${userParam}::uuid)`;
}

/**
 * Is `userId` a member of the budget — the owner or a budget_members row
 * (the same predicate as accessibleBudgetSql). Used to validate
 * account↔person assignments.
 */
export async function isBudgetMember(budgetId: string, userId: string, db: Queryable = pool): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM public.budgets b WHERE b.id = $1 AND ${accessibleBudgetSql('b', '$2')} LIMIT 1`,
    [budgetId, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Owner check for a budget id (the owner-only actions' guard). */
export async function isBudgetOwner(userId: string, budgetId: string, db: Queryable = pool): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM public.budgets b WHERE b.id = $1 AND ${ownerSql('b', '$2')} LIMIT 1`, [budgetId, userId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Claim every unowned budget for `ownerId`, then — only when zero unowned
 * rows remain — finalize `owner_user_id` to NOT NULL (USER-04: claim ends
 * with NOT NULL). Transactional and idempotent: re-running against fully
 * owned data is a no-op update plus an already-satisfied ALTER.
 */
export async function claimUnownedBudgets(ownerId: string): Promise<void> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE public.budgets
         SET owner_user_id = $1, claimed_at = now()
       WHERE owner_user_id IS NULL`,
      [ownerId],
    );
    // Claimed budgets get the claimer as their first member (owner ⇒ member).
    await client.query(
      `INSERT INTO public.budget_members (budget_id, user_id)
       SELECT id, owner_user_id FROM public.budgets WHERE owner_user_id = $1
       ON CONFLICT DO NOTHING`,
      [ownerId],
    );
    const unowned = await client.query(
      'SELECT 1 FROM public.budgets WHERE owner_user_id IS NULL LIMIT 1',
    );
    if ((unowned.rowCount ?? 0) === 0) {
      await client.query(
        'ALTER TABLE public.budgets ALTER COLUMN owner_user_id SET NOT NULL',
      );
    }
  });
}

/**
 * Every valid budget_id the request carries — query string AND (cached) JSON
 * body. Handlers read it from either place, so the guard must authorize all
 * of them, not just the first one found.
 */
async function budgetIdsFrom(c: { req: { query: (k: string) => string | undefined; json: () => Promise<unknown> } }): Promise<string[]> {
  const ids = new Set<string>();
  const q = c.req.query('budget_id');
  if (isUuid(q)) ids.add(q);
  const body = await c.req.json().catch(() => undefined);
  const v = (body as { budget_id?: unknown } | undefined)?.budget_id;
  if (typeof v === 'string' && isUuid(v)) ids.add(v);
  return [...ids];
}

/**
 * Owner/member guard (USER-05). Mounted via `app.use('*', budgetAccess)`
 * at the top of every budget-data route file, before handlers:
 * - missing identity → 401 (requireUser guarantees one; defense in depth);
 * - a budget the user neither owns nor is a member of — or not yet claimed —
 *   → 404 `not found`, never 403. No role bypasses this, admin included;
 * - EVERY budget_id carried (query and body) must be accessible, else 404;
 * - no budget addressed (no budget_id anywhere) → pass through; handlers
 *   own the 400 for a missing budget_id, and no budget is being touched.
 *
 * Stateless by design: the guard never writes. Claim-on-first-login lives
 * only at the budgets list route (GET /budgets), the app's bootstrap call,
 * so data-route access can never reassign ownership as a side effect.
 */
export const budgetAccess: MiddlewareHandler = async (c, next) => {
  const user: IdentityUser | undefined = c.get('user');
  if (!user) return errorResponse(c, 401, 'unauthorized');

  const budgetIds = await budgetIdsFrom(c);
  if (budgetIds.length === 0) return next();

  const owned = await pool.query(
    `SELECT count(*)::int AS n FROM public.budgets b WHERE b.id = ANY($1::uuid[]) AND ${accessibleBudgetSql('b', '$2')}`,
    [budgetIds, user.id],
  );
  if (owned.rows[0].n === budgetIds.length) return next();

  return errorResponse(c, 404, 'not found');
};
