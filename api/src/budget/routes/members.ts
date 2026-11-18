import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import {
  createPlaceholderUser,
  EmailLinkError,
  linkEmailToPlaceholder,
  provisionUserByEmail,
  renameUnclaimedUser,
  toPersonAvatar,
} from '../../user';
import type { IdentityUser } from '../../user';
import { membersAdd, membersLinkEmail, membersList, membersRemove, membersRename } from '@shared/contracts/budget';
import { isBudgetMember, isBudgetOwnerOrAdmin } from '../ownership';
import { budgetRouter } from '../router';
import * as membersStore from '../store/members';

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

/** Members as the API returns them: avatar nested, `is_me` relative to the viewer. */
async function listMembers(budgetId: string, viewerId: string) {
  const rows = await membersStore.listMemberRows(pool, budgetId, viewerId);
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
    await membersStore.addMember(pool, body.budget_id, personId);
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
    if (await membersStore.isBudgetOwner(pool, budgetId, userId)) throw new HttpError(400, 'the owner cannot be removed');
    // Their accounts and categories fall back to Shared in the same transaction as the removal.
    await withTransaction(pool, (client) => membersStore.removeMemberAndUnassign(client, budgetId, userId));
    return { members: await listMembers(budgetId, user.id) };
  }),
];

export default budgetRouter('/budget-members', operations);
