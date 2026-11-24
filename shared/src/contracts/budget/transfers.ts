/**
 * Transfers between a person's own accounts (budget-mit6): the matcher's
 * suggestions, linking / unlinking pairs, "not a transfer" decisions and the
 * payee "treat as transfer" rule.
 */
import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL } from '../../operation-contract';
import { budgetId, uuidSchema } from './schemas';
import {
  payeeTransferRuleSchema,
  transferLinkResultSchema,
  transferNoMatchPolicies,
  transferRuleModes,
  transferSuggestionSchema,
} from './outputs';

const idList = z.array(uuidSchema).min(1).max(1000);

export const transferSuggestionsList = defineOperation({
  name: 'budget_transfer_suggestions_list',
  description:
    'Rows that look like transfers between two of the budget\'s own accounts but were not linked automatically, with the proposed other side(s), why (`basis`) and how sure (`confidence`: sure = one match, choose = several possible, one_side = no matching row). account_id narrows to suggestions touching that account. `amount` fields are signed milliunits (1/1000 of the currency unit, 12.34 = 12340).',
  input: z.object({ budget_id: budgetId, account_id: uuidSchema.optional() }),
  output: z.array(transferSuggestionSchema),
  method: 'GET',
  path: '/transfers/suggestions',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const transfersLink = defineOperation({
  name: 'budget_transfers_link',
  description:
    'Link rows as transfers. Each link names a transaction and either the counterpart transaction (equal and opposite amount, another on-budget account) or an account: the matching row there is linked, or a mirrored row is created when none exists. Both legs lose their category and get the "Transfer : <account>" payee. remember_payee also sets an "auto" treat-as-transfer rule on each named transaction\'s payee. Undo with budget_transfers_unlink.',
  input: z.object({
    budget_id: budgetId,
    links: z
      .array(
        // Exactly one of counterpart_id / account_id (400 otherwise).
        z.object({ transaction_id: uuidSchema, counterpart_id: uuidSchema.optional(), account_id: uuidSchema.optional() }),
      )
      .min(1)
      .max(500),
    remember_payee: z.boolean().optional(),
  }),
  output: transferLinkResultSchema,
  method: 'POST',
  path: '/transfers/link',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const transfersUnlink = defineOperation({
  name: 'budget_transfers_unlink',
  description:
    'Undo transfer links made by the matcher, a payee rule or budget_transfers_link: both legs get back their previous payee and category (a leg the link created is deleted) and are never auto-linked again (they stay suggestions). Ids may name either leg; rows without a recorded link are left alone.',
  input: z.object({ budget_id: budgetId, transaction_ids: idList }),
  output: z.object({ unlinked: z.number().int() }),
  method: 'POST',
  path: '/transfers/unlink',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const transfersMark = defineOperation({
  name: 'budget_transfers_mark',
  description:
    'Record a decision about rows the transfer matcher looks at: `dismissed` = not a transfer (never suggested or linked again), `outside` = a transfer to an account outside the budget (no category asked), null = clear the decision.',
  input: z.object({
    budget_id: budgetId,
    transaction_ids: idList,
    state: z.enum(['dismissed', 'outside']).nullable(),
  }),
  output: z.object({ updated: z.number().int() }),
  method: 'PUT',
  path: '/transfers/marks',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const payeesTransferRuleGet = defineOperation({
  name: 'budget_payees_transfer_rule_get',
  description:
    'A payee\'s "treat as transfer" rule: mode (off, auto = link to the matching row in any own account, account = always to account_id, never = never a transfer), what happens when no matching row shows up within wait_days (outside = keep as a transfer to an account outside the budget, review = leave for review), and how many past rows it could still apply to.',
  input: z.object({ id: uuidSchema, budget_id: budgetId }),
  output: payeeTransferRuleSchema,
  method: 'GET',
  path: '/payees/:id/transfer-rule',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const payeesSetTransferRule = defineOperation({
  name: 'budget_payees_set_transfer_rule',
  description:
    'Set a payee\'s "treat as transfer" rule (see budget_payees_transfer_rule_get). A new rule covers rows imported from now on; apply_to_past also links its earlier rows. Returns the saved rule and how many rows were linked.',
  input: z.object({
    id: uuidSchema,
    budget_id: budgetId,
    mode: z.enum(transferRuleModes),
    account_id: uuidSchema.nullable().optional(),
    no_match: z.enum(transferNoMatchPolicies).optional(),
    wait_days: z.number().int().min(1).max(60).optional(),
    apply_to_past: z.boolean().optional(),
  }),
  output: payeeTransferRuleSchema,
  method: 'PUT',
  path: '/payees/:id/transfer-rule',
  query: ['budget_id'],
  kind: 'write',
  expose: EXPOSE_ALL,
});
