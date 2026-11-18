/**
 * Budget store: budget members. SQL only (moved verbatim from
 * routes/members.ts); every function takes a Queryable.
 */
import type { Queryable } from '../../core/db';
import { personAvatarSql, personPendingSql, type PersonAvatarRow } from '../../user';

export interface MemberRow extends PersonAvatarRow {
  user_id: string;
  email: string | null;
  name: string | null;
  is_owner: boolean;
  is_me: boolean;
  pending: boolean;
}

/**
 * The budget's people: members, plus the owner (even without a
 * budget_members row), plus the viewer when the budget is unowned.
 */
export async function listMemberRows(db: Queryable, budgetId: string, viewerId: string): Promise<MemberRow[]> {
  const { rows } = await db.query<MemberRow>(
    `SELECT u.id AS user_id, u.email, u.name, COALESCE(u.id = b.owner_user_id, false) AS is_owner,
            (u.id = $2) AS is_me, ${personPendingSql('u')}, ${personAvatarSql('u')}
       FROM public.budgets b
       JOIN public.users u ON u.id IN (
              SELECT user_id FROM public.budget_members WHERE budget_id = b.id
              UNION SELECT b.owner_user_id WHERE b.owner_user_id IS NOT NULL
              UNION SELECT $2::uuid WHERE b.owner_user_id IS NULL)
      WHERE b.id = $1
      ORDER BY is_owner DESC, lower(COALESCE(u.name, u.email))`,
    [budgetId, viewerId],
  );
  return rows;
}

export async function addMember(db: Queryable, budgetId: string, userId: string): Promise<void> {
  await db.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [budgetId, userId]);
}

/**
 * Remove a member; their accounts and categories fall back to Shared, and
 * accounts linked to THEIR bank connections are unlinked (the rows and their
 * history stay): a removed person's bank must stop feeding a budget they can
 * no longer see, and they could not unlink it themselves any more. Call
 * inside one transaction.
 */
export async function removeMemberAndUnassign(db: Queryable, budgetId: string, userId: string): Promise<void> {
  await db.query('DELETE FROM public.budget_members WHERE budget_id = $1 AND user_id = $2', [budgetId, userId]);
  await db.query(
    `UPDATE public.accounts SET connection_id = NULL, external_account_id = NULL, institution = NULL
      WHERE budget_id = $1 AND connection_id IN (SELECT id FROM public.connections WHERE user_id = $2)`,
    [budgetId, userId],
  );
  await db.query('UPDATE public.accounts SET user_id = NULL WHERE budget_id = $1 AND user_id = $2', [budgetId, userId]);
  await db.query('UPDATE public.categories SET user_id = NULL WHERE budget_id = $1 AND user_id = $2', [budgetId, userId]);
}
