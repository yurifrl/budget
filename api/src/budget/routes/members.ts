import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import {
  createPlaceholderUser,
  EmailLinkError,
  linkEmailToPlaceholder,
  personAvatarSql,
  personPendingSql,
  provisionUserByEmail,
  renameUnclaimedUser,
  toPersonAvatar,
} from '../../user';
import type { IdentityUser, PersonAvatarRow } from '../../user';
import { membersAdd, membersLinkEmail, membersList, membersRemove, membersRename } from '@shared/contracts/budget';
import { isBudgetMember, isBudgetOwnerOrAdmin } from '../ownership';
import { budgetRouter } from '../router';

/**
 * Budget members — the people a budget is grouped by. Everyone listed sees
 * and edits everything (no per-member restriction). This is grouping, not
 * permission: any member may add a person (with an email, or a named
 * placeholder), link a placeholder's email, or rename an unclaimed person;
 * only the owner (or an admin) removes people. Sign-in is still gated by the
 * AUTH_ALLOWED_EMAILS allow-list, so an added email must also be allow-listed.
 *
 * The owner is always listed (even if the budget_members row is missing), and
 * an unowned budget lists the viewer.
 */
interface MemberRow extends PersonAvatarRow {
  user_id: string;
  email: string | null;
  name: string | null;
  is_owner: boolean;
  is_me: boolean;
  pending: boolean;
}

/** Members as the API returns them: avatar nested, `is_me` relative to the viewer. */
async function listMembers(budgetId: string, viewerId: string) {
  const { rows } = await pool.query<MemberRow>(
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
  return rows.map(({ avatar_seed, avatar_image_version, ...m }) => ({
    ...m,
    avatar: toPersonAvatar({ avatar_seed, avatar_image_version }),
  }));
}

/** Signed-in caller (budgetRouter already scoped the budget to a member/owner/admin). */
function requireUser(c: { get: (k: 'user') => IdentityUser | undefined }) {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'unauthorized');
  return user;
}

/** Owner-or-admin gate for removing people; non-managers get 404. */
async function requireManager(c: { get: (k: 'user') => IdentityUser | undefined }, budgetId: string) {
  const user = c.get('user');
  if (!user || !(await isBudgetOwnerOrAdmin(user, budgetId))) throw new HttpError(404, 'not found');
  return user;
}

// Member-or-owner-or-admin scoping comes from budgetRouter (budget_id from
// query or body); the write routes below additionally require owner-or-admin.
export const operations = [
  implement(membersList, async (c, { budget_id: budgetId }) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const members = await listMembers(budgetId, user.id);
    return { members, can_manage: await isBudgetOwnerOrAdmin(user, budgetId) };
  }),

  implement(membersAdd, async (c, body) => {
    const user = requireUser(c);
    let personId: string;
    if (body.email) {
      personId = (await provisionUserByEmail(body.email, body.name)).id;
    } else {
      if (!body.name) throw new HttpError(400, 'name is required when no email is given');
      personId = (await createPlaceholderUser(body.name)).id;
    }
    await pool.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      body.budget_id,
      personId,
    ]);
    return { members: await listMembers(body.budget_id, user.id) };
  }),

  implement(membersLinkEmail, async (c, body) => {
    const user = requireUser(c);
    if (!(await isBudgetMember(body.budget_id, body.user_id))) throw new HttpError(404, 'not found');
    try {
      await linkEmailToPlaceholder(body.user_id, body.email);
    } catch (err) {
      if (err instanceof EmailLinkError) throw new HttpError(400, err.message);
      throw err;
    }
    return { members: await listMembers(body.budget_id, user.id) };
  }),

  implement(membersRename, async (c, body) => {
    const user = requireUser(c);
    if (!(await isBudgetMember(body.budget_id, body.user_id))) throw new HttpError(404, 'not found');
    if (!(await renameUnclaimedUser(body.user_id, body.name))) {
      throw new HttpError(400, 'a signed-in person edits their own name in their profile');
    }
    return { members: await listMembers(body.budget_id, user.id) };
  }),

  implement(membersRemove, async (c, { budget_id: budgetId, user_id: userId }) => {
    const user = await requireManager(c, budgetId);
    const owner = await pool.query('SELECT 1 FROM public.budgets WHERE id = $1 AND owner_user_id = $2', [
      budgetId,
      userId,
    ]);
    if ((owner.rowCount ?? 0) > 0) throw new HttpError(400, 'the owner cannot be removed');
    // Their accounts and categories fall back to Shared in the same transaction as the removal.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM public.budget_members WHERE budget_id = $1 AND user_id = $2', [budgetId, userId]);
      await client.query('UPDATE public.accounts SET user_id = NULL WHERE budget_id = $1 AND user_id = $2', [
        budgetId,
        userId,
      ]);
      await client.query('UPDATE public.categories SET user_id = NULL WHERE budget_id = $1 AND user_id = $2', [
        budgetId,
        userId,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { members: await listMembers(budgetId, user.id) };
  }),
];

export default budgetRouter('/budget-members', operations);
