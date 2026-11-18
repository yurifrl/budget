import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId, uuidSchema } from './schemas';

export const membersList = defineOperation({
  name: 'budget_members_list',
  description: 'List who a budget is shared with, and whether the caller can manage the list.',
  input: z.object({ budget_id: budgetId }),
  method: 'GET',
  path: '/budget-members',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const membersAdd = defineOperation({
  name: 'budget_members_add',
  description:
    'Add a person to a budget (any member; grouping, not permission). With an email: share with that person (the email must also be allow-listed to sign in). Without one: a named placeholder person, linkable to an email later with budget_members_link_email.',
  input: z.object({
    budget_id: budgetId,
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    /** Display name; required when no email is given. Never overwrites an existing name. */
    name: z.string().trim().min(1).max(80).optional(),
  }),
  method: 'POST',
  path: '/budget-members',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const membersLinkEmail = defineOperation({
  name: 'budget_members_link_email',
  description:
    'Attach an email to a placeholder person. If that email already belongs to a user, the placeholder is merged into them (their accounts, categories and memberships move over).',
  input: z.object({
    budget_id: budgetId,
    user_id: uuidSchema,
    email: z.string().trim().toLowerCase().email().max(254),
  }),
  method: 'POST',
  path: '/budget-members/link-email',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const membersRename = defineOperation({
  name: 'budget_members_rename',
  description: 'Rename a person who has not signed in yet (placeholder or invitee). Signed-in users keep their own name.',
  input: z.object({ budget_id: budgetId, user_id: uuidSchema, name: z.string().trim().min(1).max(80) }),
  method: 'PATCH',
  path: '/budget-members',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const membersRemove = defineOperation({
  name: 'budget_members_remove',
  description: "Stop sharing a budget with a member (owner or admin only); the member's accounts fall back to Shared.",
  input: z.object({ budget_id: budgetId, user_id: uuidSchema }),
  method: 'DELETE',
  path: '/budget-members',
  query: ['budget_id', 'user_id'],
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});
