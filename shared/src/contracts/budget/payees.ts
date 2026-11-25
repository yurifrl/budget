import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId, categorizationModeSchema, matchTypeSchema, nameSchema, ruleMatchTypeSchema, uuidSchema } from './schemas';
import { noContent, payeeAdminRowSchema, payeeMergedSchema, payeeRowSchema, payeeTxnPageSchema, renameRuleSchema } from './outputs';

const scoped = z.object({ id: uuidSchema, budget_id: budgetId });

export const payeesList = defineOperation({
  name: 'budget_payees_list',
  description:
    'List payees with transaction counts, last-used date and inferred category. hidden=false lists visible payees only, true hidden only. Each account has one system payee "Transfer : <account>" (transfer_account_id set, transfer_account_name = the account\'s current name): it is listed only with include_transfers=true, and it cannot be renamed, merged, hidden or deleted.',
  input: z.object({ budget_id: budgetId, hidden: z.string().optional(), include_transfers: z.string().optional() }),
  output: z.array(payeeAdminRowSchema),
  method: 'GET',
  path: '/payees',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const payeesCreate = defineOperation({
  name: 'budget_payees_create',
  description: 'Create a payee by the name given (no renaming rule applies: rules are for imported text); an existing name is returned as-is.',
  input: z.object({
    budget_id: budgetId,
    name: nameSchema,
    default_category_id: uuidSchema.nullish(),
    hidden: z.boolean().optional(),
    categorization_mode: categorizationModeSchema.optional(),
  }),
  output: payeeRowSchema,
  method: 'POST',
  path: '/payees',
  status: 201,
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const payeesTransactions = defineOperation({
  name: 'budget_payees_transactions',
  description: "Paginated ledger of one payee's transactions (limit 1..200, default 50). Returned `amount` is signed integer milliunits (12.34 = 12340).",
  input: z.object({
    id: uuidSchema,
    budget_id: budgetId,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  output: payeeTxnPageSchema,
  method: 'GET',
  path: '/payees/:id/transactions',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const payeesRename = defineOperation({
  name: 'budget_payees_rename',
  description: 'Rename a payee.',
  input: scoped.extend({ name: nameSchema }),
  output: noContent,
  method: 'PATCH',
  path: '/payees/:id/name',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const payeesSetHidden = defineOperation({
  name: 'budget_payees_set_hidden',
  description: 'Hide or show a payee.',
  input: scoped.extend({ hidden: z.boolean() }),
  output: noContent,
  method: 'PATCH',
  path: '/payees/:id/hidden',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const payeesSetCategorization = defineOperation({
  name: 'budget_payees_set_categorization',
  description: "Set a payee's auto-categorization mode and/or default category.",
  input: scoped.extend({
    categorization_mode: categorizationModeSchema.optional(),
    default_category_id: uuidSchema.nullable().optional(),
  }),
  output: noContent,
  method: 'PATCH',
  path: '/payees/:id/categorization',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const payeesDelete = defineOperation({
  name: 'budget_payees_delete',
  description: 'Delete a payee (soft delete; transactions keep their payee_id). Prefer merge.',
  input: scoped,
  output: noContent,
  method: 'DELETE',
  path: '/payees/:id',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_ALL,
});

export const payeesMerge = defineOperation({
  name: 'budget_payees_merge',
  description: 'Merge a payee into target_id: re-points its transactions, then deletes it.',
  input: scoped.extend({ target_id: uuidSchema }),
  output: payeeMergedSchema,
  method: 'POST',
  path: '/payees/:id/merge',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_ALL,
});

export const payeesSetRenameRule = defineOperation({
  name: 'budget_payees_set_rename_rule',
  description:
    "Single-rule form kept for released clients: set the payee's first \"is\" / \"contains\" renaming rule (imported text matching the condition is assigned to this payee); empty condition removes that rule. Other rules of the payee are untouched. Use budget_payees_rename_rules_* for several rules and \"starts with\" / \"ends with\".",
  input: scoped.extend({ match_type: matchTypeSchema, condition: z.string().trim().max(200) }),
  output: noContent,
  method: 'PUT',
  path: '/payees/:id/rename-rule',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

const ruleScoped = scoped.extend({ rule_id: uuidSchema });
const ruleBody = {
  match_type: ruleMatchTypeSchema,
  condition: z.string().trim().min(1).max(200),
};
const RULE_MATCHING =
  'Matching ignores case and surrounding or repeated spaces (accents count). When several rules match one text the most specific wins: is, then starts with / ends with, then contains; then the longest pattern; then the oldest rule.';

export const payeesRenameRulesList = defineOperation({
  name: 'budget_payees_rename_rules_list',
  description: `List a payee's renaming rules, oldest first. A rule says "imported payees that <is | contains | starts with | ends with> condition are renamed to this payee": a matching imported row is assigned to the payee itself and keeps the imported text as its import name. A payee can hold several rules. ${RULE_MATCHING}`,
  input: scoped,
  output: z.array(renameRuleSchema),
  method: 'GET',
  path: '/payees/:id/rename-rules',
  query: ['budget_id'],
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const payeesRenameRulesAdd = defineOperation({
  name: 'budget_payees_rename_rules_add',
  description: `Add a renaming rule to a payee. A transfer payee ("Transfer : <account>") can hold rules too: a row a rule assigns to it on import or bank sync stays an ordinary uncategorized row with a transfer hint for that account, and a register entry makes the transfer with its mirror. 409 when another payee already holds the same rule. ${RULE_MATCHING}`,
  input: scoped.extend(ruleBody),
  output: renameRuleSchema,
  method: 'POST',
  path: '/payees/:id/rename-rules',
  query: ['budget_id'],
  status: 201,
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const payeesRenameRulesUpdate = defineOperation({
  name: 'budget_payees_rename_rules_update',
  description: 'Change the match type and condition of one renaming rule of a payee. 404 when the rule is not that payee\'s, 409 when another rule already has these values.',
  input: ruleScoped.extend(ruleBody),
  output: renameRuleSchema,
  method: 'PUT',
  path: '/payees/:id/rename-rules/:rule_id',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const payeesRenameRulesRemove = defineOperation({
  name: 'budget_payees_rename_rules_remove',
  description: 'Remove one renaming rule of a payee. Rows already imported keep their payee.',
  input: ruleScoped,
  output: noContent,
  method: 'DELETE',
  path: '/payees/:id/rename-rules/:rule_id',
  query: ['budget_id'],
  kind: 'destructive',
  expose: EXPOSE_ALL,
});
