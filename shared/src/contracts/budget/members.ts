import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { budgetId, uuidSchema } from './schemas';
import { budgetMembersChangedSchema, budgetMembersSchema } from './outputs';

export const membersList = defineOperation({
  name: 'budget_members_list',
  description: 'List who a budget is shared with, and whether the caller can remove people (can_manage: true for the owner only).',
  input: z.object({ budget_id: budgetId }),
  output: budgetMembersSchema,
  method: 'GET',
  path: '/budget-members',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const membersAdd = defineOperation({
  name: 'budget_members_add',
  description:
    'Add a person to a budget (any member may). With an email: share the budget with that person; they see it the first time they sign in through Cloudflare Access, with no further allow-listing (Google sign-in still needs the email on the Google allow-list). Without one: a named placeholder person (grouping only, cannot sign in), linkable to an email later with budget_members_link_email.',
  input: z.object({
    budget_id: budgetId,
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    /** Display name; required when no email is given. Never overwrites an existing name. */
    name: z.string().trim().min(1).max(80).optional(),
  }),
  output: budgetMembersChangedSchema,
  method: 'POST',
  path: '/budget-members',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const membersLinkEmail = defineOperation({
  name: 'budget_members_link_email',
  description:
    'Attach an email to a placeholder person (any member may), which shares the budget with that email. If that email already belongs to a user, the placeholder is merged into them (their accounts, categories and memberships move over).',
  input: z.object({
    budget_id: budgetId,
    user_id: uuidSchema,
    email: z.string().trim().toLowerCase().email().max(254),
  }),
  output: budgetMembersChangedSchema,
  method: 'POST',
  path: '/budget-members/link-email',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const membersRename = defineOperation({
  name: 'budget_members_rename',
  description: 'Rename a person who has not signed in yet (placeholder or invitee). Signed-in users keep their own name.',
  input: z.object({ budget_id: budgetId, user_id: uuidSchema, name: z.string().trim().min(1).max(80) }),
  output: budgetMembersChangedSchema,
  method: 'PATCH',
  path: '/budget-members',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const membersRemove = defineOperation({
  name: 'budget_members_remove',
  description: "Stop sharing a budget with a member (owner only; the owner cannot be removed); the member's accounts and categories fall back to Shared.",
  input: z.object({ budget_id: budgetId, user_id: uuidSchema }),
  output: budgetMembersChangedSchema,
  method: 'DELETE',
  path: '/budget-members',
  query: ['budget_id', 'user_id'],
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});
