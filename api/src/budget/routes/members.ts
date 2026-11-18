import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError, errorResponse } from '../../core/validate';
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
import { isBudgetMember, isBudgetOwner } from '../ownership';
import { budgetRouter } from '../router';
import * as membersStore from '../store/members';

/**
 * Budget members — the people a budget is shared with and grouped by.
 * Everyone listed sees and edits everything in the budget (no per-member
 * restriction on budget data). On the list itself: any member may add a
 * person (with an email = share the budget with them, or a named
 * placeholder), link a placeholder's email, or rename a person who has not
 * signed in; only the OWNER removes people, and the owner cannot be removed.
 * Renaming, archiving, deleting, restoring and fresh-starting the budget are
 * owner-only too (routes/budgets.ts, budget-restore.ts). The `admin` role
 * gives none of this.
 *
 * An added email needs no further allow-listing to sign in through
 * Cloudflare Access (the Access policy is that gate); Google sign-in still
 * needs the email on AUTH_ALLOWED_EMAILS.
 *
 * The owner is always listed (even if the budget_members row is missing).
 */

/** Members as the API returns them: avatar nested, `is_me` relative to the viewer. */
async function listMembers(budgetId: string, viewerId: string) {
  const rows = await membersStore.listMemberRows(pool, budgetId, viewerId);
  return rows.map(({ avatar_seed, avatar_image_version, ...m }) => ({
    ...m,
    avatar: toPersonAvatar({ avatar_seed, avatar_image_version }),
  }));
}

/** Signed-in caller (budgetRouter already scoped the budget to its owner or a member). */
function requireUser(c: { get: (k: 'user') => IdentityUser | undefined }) {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'unauthorized');
  return user;
}

/** Owner gate for removing people; anyone else gets 404. */
async function requireManager(c: { get: (k: 'user') => IdentityUser | undefined }, budgetId: string) {
  const user = c.get('user');
  if (!user || !(await isBudgetOwner(user.id, budgetId))) throw new HttpError(404, 'not found');
  return user;
}

// Owner-or-member scoping comes from budgetRouter (budget_id from query or
// body); removing a person additionally requires the owner.
export const operations = [
  implement(membersList, async (c, { budget_id: budgetId }) => {
    const user: IdentityUser | undefined = c.get('user');
    if (!user) return errorResponse(c, 401, 'unauthorized');
    const members = await listMembers(budgetId, user.id);
    return { members, can_manage: await isBudgetOwner(user.id, budgetId) };
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
    if (await isBudgetOwner(userId, budgetId)) throw new HttpError(400, 'the owner cannot be removed');
    // Their accounts and categories fall back to Shared in the same transaction as the removal.
    await withTransaction(pool, (client) => membersStore.removeMemberAndUnassign(client, budgetId, userId));
    return { members: await listMembers(budgetId, user.id) };
  }),
];

export default budgetRouter('/budget-members', operations);
