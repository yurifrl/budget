import { pool, withTransaction, type Queryable } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import {
  payeesCreate,
  payeesDelete,
  payeesList,
  payeesMerge,
  payeesRename,
  payeesRenameRulesAdd,
  payeesRenameRulesApply,
  payeesRenameRulesApplyPreview,
  payeesRenameRulesList,
  payeesRenameRulesRemove,
  payeesRenameRulesRevert,
  payeesRenameRulesUpdate,
  payeesSetCategorization,
  payeesSetHidden,
  payeesSetRenameRule,
  payeesSetTransferRule,
  payeesTransactions,
  payeesTransferRuleGet,
} from '@shared/contracts/budget';
import { planRuleApply, revertRuleApply, writeRuleApply } from '../domain/rename-apply';
import { lockBudgetImportWrites, withApplyLockTimeout } from '../store/rename-apply';
import { linkTransfers } from '../domain/transfer-links';
import { assertNotTransferPayee, transferPayeeProtected } from '../domain/transfer-payees';
import * as transferStore from '../store/transfers';
import { MIN_RULE_PATTERN_LENGTH } from '@shared/domain/payees';
import { budgetRouter } from '../router';
import type { IdentityUser } from '../../user';
import { categoryInBudget } from '../store/categories';
import * as payeesStore from '../store/payees';
import * as rulesStore from '../store/rename-rules';
import type { PayeeNameHolder } from '../store/payees';

const PAYEE_NAME_UNIQUE = 'payees_budget_id_name_key';

/** 409 naming the payee that already holds the name. Merge is only offered when it can work. */
function payeeNameConflict(other: PayeeNameHolder): HttpError {
  if (other.transfer) {
    return new HttpError(409, `The name "${other.name}" is reserved for a transfer payee. Choose a different name.`, 'payee_name_reserved', { name: other.name });
  }
  if (other.deleted) {
    return new HttpError(409, `A deleted payee is already named "${other.name}". Choose a different name.`, 'payee_name_deleted_exists', { name: other.name });
  }
  return new HttpError(
    409,
    `A payee named "${other.name}" already exists. Choose a different name, or use Merge to combine them.`,
    'payee_name_exists',
    { name: other.name },
  );
}

/** The wire shape of a payee's transfer rule (mode null = off). */
function transferRuleOutput(
  payeeId: string,
  rule: NonNullable<Awaited<ReturnType<typeof transferStore.getPayeeTransferRule>>>,
  pastRows: number,
  linked: number,
) {
  return {
    payee_id: payeeId,
    mode: rule.mode ?? ('off' as const),
    account_id: rule.account_id,
    no_match: rule.no_match,
    wait_days: Number(rule.wait_days),
    since: rule.since,
    past_rows: pastRows,
    linked,
  };
}

async function requirePayee(budgetId: string, id: string): Promise<void> {
  if (!(await payeesStore.livePayeeExists(pool, budgetId, id))) throw new HttpError(404, 'payee not found');
}

async function requirePayeeIn(db: Queryable, budgetId: string, id: string): Promise<void> {
  if (!(await payeesStore.livePayeeExists(db, budgetId, id))) throw new HttpError(404, 'payee not found');
}

/**
 * A rule being added or changed: a "contains" / "starts with" / "ends with" pattern is at least
 * MIN_RULE_PATTERN_LENGTH long (400; stored shorter ones keep working), and no OTHER rule of the budget
 * already says the same (same match type and pattern, case ignored as matching ignores it: 409
 * naming the holder). A write that leaves the rule's type and text as they are is not asked.
 */
async function assertRuleAllowed(
  db: Queryable,
  budgetId: string,
  matchType: string,
  condition: string,
  existing: { id: string; match_type: string; condition: string } | null,
  /** The 2-character minimum belongs to the new operations; the released client's single-rule call may still send 1 character. */
  opts: { enforceMinLength: boolean } = { enforceMinLength: true },
): Promise<void> {
  const text = condition.trim();
  if (existing && existing.match_type === matchType && existing.condition.toLowerCase() === text.toLowerCase()) return;
  if (opts.enforceMinLength && matchType !== 'is' && text.length < MIN_RULE_PATTERN_LENGTH) {
    throw new HttpError(400, `A "${matchType.replace('_', ' ')}" rule needs at least ${MIN_RULE_PATTERN_LENGTH} characters.`, 'rename_rule_too_short', { min: MIN_RULE_PATTERN_LENGTH });
  }
  const holder = await rulesStore.findRuleHolder(db, budgetId, matchType, text, existing?.id ?? null);
  if (!holder) return;
  throw new HttpError(
    409,
    `The payee "${holder.payee_name}" already has that renaming rule. A rule belongs to one payee.`,
    'rename_rule_exists',
    { name: holder.payee_name },
  );
}

/** A unique violation on the exact rule index (two writers raced past the check): the same 409. */
async function ruleWrite<T>(db: Queryable, budgetId: string, matchType: string, condition: string, write: () => Promise<T>): Promise<T> {
  const done = await rulesStore.guardRuleWrite(db, write);
  if (done.ok) return done.value;
  const holder = await rulesStore.findRuleHolder(db, budgetId, matchType, condition.trim(), null);
  throw new HttpError(409, 'Another payee already has that renaming rule.', 'rename_rule_exists', { name: holder?.payee_name ?? '' });
}

/** An apply or revert that could not get the budget's import lock (or a row) in time: 409, the person can simply try again. */
const syncRunning = () => new HttpError(409, 'A bank sync is running for this budget. Try again in a moment.', 'bank_sync_running');

export const operations = [
  // Transfer payees (one per account) are listed only on request: the pickers
  // and Manage Payees show them through the accounts, not as ordinary payees.
  implement(payeesList, async (_c, { budget_id, hidden, include_transfers }) => {
    // A rule only the old columns hold (written by the other app) is part of what the list returns, computed at read time.
    return payeesStore.listPayees(pool, budget_id, hidden, include_transfers === 'true');
  }),

  implement(payeesCreate, async (_c, { budget_id, name, default_category_id, hidden, categorization_mode }) => {
    if (default_category_id) {
      if (!(await categoryInBudget(pool, default_category_id, budget_id))) throw new HttpError(400, 'category not found in budget', 'category_not_in_budget');
    }
    // Creating a payee by name is not an import: no renaming rule applies, the payee is created (or found) by the name given.
    return payeesStore.insertPayee(pool, {
      budgetId: budget_id,
      name,
      defaultCategoryId: default_category_id ?? null,
      hidden: hidden ?? false,
      categorizationMode: categorization_mode ?? 'auto',
    });
  }),

  // GET /:id/transactions?budget_id=… — paginated ledger for one payee.
  implement(payeesTransactions, async (_c, { id, budget_id, limit, offset }) => {
    await requirePayee(budget_id, id);
    return payeesStore.payeeTransactionsPage(pool, id, budget_id, limit, offset);
  }),

  implement(payeesRename, async (_c, { id, budget_id, name }) => {
    await requirePayee(budget_id, id);
    await assertNotTransferPayee(pool, budget_id, id);
    // Case-insensitive pre-check for a friendly message (the DB constraint is
    // case-sensitive, so it can't catch "ifood" vs "iFood"). The payee itself is
    // excluded so a case-only rename of the same payee ("ifood" -> "iFood") works.
    const clash = await payeesStore.findPayeeNameClash(pool, budget_id, id, name);
    if (clash) throw payeeNameConflict(clash);
    // The payee must belong to this budget and not be tombstoned; otherwise the
    // update would silently rename another budget's row.
    let renamed: boolean;
    try {
      renamed = await payeesStore.renamePayee(pool, id, budget_id, name);
    } catch (err) {
      // A concurrent request can win the race between the check above and this
      // UPDATE: the unique constraint is the source of truth, so map it to 409.
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === PAYEE_NAME_UNIQUE) {
        const taken = await payeesStore.findPayeeByExactName(pool, budget_id, name);
        throw payeeNameConflict(taken ?? { name, deleted: false, transfer: false });
      }
      throw err;
    }
    if (!renamed) throw new HttpError(404, 'payee not found');
  }),

  implement(payeesSetHidden, async (_c, { id, budget_id, hidden }) => {
    if (hidden) await assertNotTransferPayee(pool, budget_id, id);
    if (!(await payeesStore.setPayeeHidden(pool, id, budget_id, hidden))) throw new HttpError(404, 'payee not found');
  }),

  implement(payeesSetCategorization, async (_c, { id, budget_id, categorization_mode, default_category_id }) => {
    await requirePayee(budget_id, id);
    if (default_category_id) {
      if (!(await categoryInBudget(pool, default_category_id, budget_id))) throw new HttpError(400, 'category not found in budget', 'category_not_in_budget');
    }
    await payeesStore.setPayeeCategorization(pool, id, budget_id, {
      categorizationMode: categorization_mode,
      defaultCategoryId: default_category_id,
    });
  }),

  // Soft-delete only: transactions keep their payee_id, so a hard delete would
  // orphan them — the UI offers merge instead.
  implement(payeesDelete, async (_c, { id, budget_id }) => {
    await assertNotTransferPayee(pool, budget_id, id);
    await withTransaction(pool, async (client) => {
      if (!(await payeesStore.softDeletePayee(client, id, budget_id))) throw new HttpError(404, 'payee not found');
      // A deleted payee takes no imported text any more: its rules go with it.
      await rulesStore.deletePayeeRules(client, budget_id, id);
      await rulesStore.syncLegacyRuleColumns(client, budget_id, id);
    });
  }),

  /**
   * Merge: every transaction of the source payee re-points to the target
   * (same budget, live), then the source is soft-deleted — matching the issue
   * spec ("source payee txns re-pointed to target, source soft-deleted").
   */
  implement(payeesMerge, async (_c, { id, budget_id, target_id }) => {
    if (target_id === id) throw new HttpError(400, 'cannot merge a payee into itself', 'cannot_merge_into_itself');

    return withTransaction(pool, async (client) => {
      const rows = await payeesStore.lockLivePayees(client, [id, target_id], budget_id);
      if (!rows.some((r) => r.id === id)) throw new HttpError(404, 'payee not found');
      if (!rows.some((r) => r.id === target_id)) throw new HttpError(404, 'target payee not found');
      // A transfer payee belongs to its account: neither the source nor the target of a merge.
      for (const merging of [id, target_id]) {
        const row = rows.find((r) => r.id === merging);
        if (row?.transfer_account_id) throw transferPayeeProtected(row.name);
      }

      // A rule only the old columns hold is adopted before the source is deleted, so it moves with the rest.
      await rulesStore.adoptColumnRule(client, budget_id, id);
      await rulesStore.adoptColumnRule(client, budget_id, target_id);
      const merged = await payeesStore.movePayeeTransactions(client, id, target_id);
      await payeesStore.markPayeeDeleted(client, id);
      // The merged payee's renaming rules now assign the target (imported text that used to
      // become the merged payee keeps resolving to the same rows' payee).
      await rulesStore.moveRules(client, budget_id, id, target_id);
      await rulesStore.syncLegacyRuleColumns(client, budget_id, id);
      await rulesStore.syncLegacyRuleColumns(client, budget_id, target_id);
      return { merged_transactions: merged, source_deleted: true };
    });
  }),

  // The single-rule form the released clients use: the payee's FIRST "is" / "contains" rule.
  // Other rules of the payee (and "starts with" / "ends with" rules) are never touched.
  implement(payeesSetRenameRule, async (_c, { id, budget_id, match_type, condition }) =>
    withTransaction(pool, async (client) => {
      await requirePayeeIn(client, budget_id, id);
      await rulesStore.adoptColumnRule(client, budget_id, id);
      const first = (await rulesStore.listPayeeRules(client, budget_id, id)).find((r) => r.match_type === 'is' || r.match_type === 'contains');
      if (condition === '') {
        if (first) await rulesStore.deleteRule(client, budget_id, id, first.id);
      } else {
        await assertRuleAllowed(client, budget_id, match_type, condition, first ?? null, { enforceMinLength: false });
        await ruleWrite(client, budget_id, match_type, condition, () =>
          first ? rulesStore.updateRule(client, budget_id, id, first.id, match_type, condition) : rulesStore.insertRule(client, budget_id, id, match_type, condition),
        );
      }
      await rulesStore.syncLegacyRuleColumns(client, budget_id, id);
    }),
  ),

  // Renaming rules of a payee, any number: "imported text that <is | contains | starts with |
  // ends with> X is renamed to this payee".
  implement(payeesRenameRulesList, async (_c, { id, budget_id }) => {
    await requirePayee(budget_id, id);
    return rulesStore.listPayeeRules(pool, budget_id, id);
  }),

  implement(payeesRenameRulesAdd, async (_c, { id, budget_id, match_type, condition }) =>
    withTransaction(pool, async (client) => {
      await requirePayeeIn(client, budget_id, id);
      await rulesStore.adoptColumnRule(client, budget_id, id);
      await assertRuleAllowed(client, budget_id, match_type, condition, null);
      const rule = await ruleWrite(client, budget_id, match_type, condition, () => rulesStore.insertRule(client, budget_id, id, match_type, condition));
      await rulesStore.syncLegacyRuleColumns(client, budget_id, id);
      return rule;
    }),
  ),

  implement(payeesRenameRulesUpdate, async (_c, { id, budget_id, rule_id, match_type, condition }) =>
    withTransaction(pool, async (client) => {
      await requirePayeeIn(client, budget_id, id);
      await rulesStore.adoptColumnRule(client, budget_id, id);
      const existing = await rulesStore.getRule(client, budget_id, id, rule_id);
      if (!existing) throw new HttpError(404, 'rule not found');
      await assertRuleAllowed(client, budget_id, match_type, condition, existing);
      const rule = await ruleWrite(client, budget_id, match_type, condition, () => rulesStore.updateRule(client, budget_id, id, rule_id, match_type, condition));
      await rulesStore.syncLegacyRuleColumns(client, budget_id, id);
      return rule!;
    }),
  ),

  implement(payeesRenameRulesRemove, async (_c, { id, budget_id, rule_id }) =>
    withTransaction(pool, async (client) => {
      await requirePayeeIn(client, budget_id, id);
      await rulesStore.adoptColumnRule(client, budget_id, id);
      if (!(await rulesStore.deleteRule(client, budget_id, id, rule_id))) throw new HttpError(404, 'rule not found');
      await rulesStore.syncLegacyRuleColumns(client, budget_id, id);
    }),
  ),

  // Applying ONE rule to past transactions, on purpose (budget-ou8p): preview, apply, revert.
  implement(payeesRenameRulesApplyPreview, async (_c, { id, budget_id, rule_id }) => {
    await requirePayee(budget_id, id);
    if (!(await rulesStore.getRule(pool, budget_id, id, rule_id))) throw new HttpError(404, 'rule not found');
    const plan = await planRuleApply(pool, budget_id, rule_id);
    return {
      rule_id,
      count: plan.changes.length,
      sample: plan.changes.slice(0, 10).map(({ row }) => ({
        id: row.id,
        account_id: row.account_id,
        date: row.date,
        amount: Number(row.amount),
        payee_id: row.payee_id,
        payee_name: row.payee_name,
        bank_text: row.bank_text,
      })),
      skipped: plan.skipped,
    };
  }),

  implement(payeesRenameRulesApply, async (c, { id, budget_id, rule_id }) =>
    withTransaction(pool, async (client) => {
      await requirePayeeIn(client, budget_id, id);
      if (!(await rulesStore.getRule(client, budget_id, id, rule_id))) throw new HttpError(404, 'rule not found');
      // The same per-budget lock the bank sync takes for its writes: no deadlock with a running sync.
      return withApplyLockTimeout(client, async () => {
        await lockBudgetImportWrites(client, [budget_id], 'exclusive');
        const plan = await planRuleApply(client, budget_id, rule_id, true);
        const user: IdentityUser | undefined = c.get('user');
        const { applyId, rows } = await writeRuleApply(client, budget_id, plan, user?.id ?? null);
        return { apply_id: applyId, rule_id, changed: rows.length, rows, skipped: plan.skipped };
      }, syncRunning);
    }),
  ),

  implement(payeesRenameRulesRevert, async (_c, { budget_id, apply_id }) =>
    withTransaction(pool, (client) => withApplyLockTimeout(client, () => revertRuleApply(client, budget_id, apply_id), syncRunning)),
  ),

  // "Treat as transfer" rule (budget-mit6).
  implement(payeesTransferRuleGet, async (_c, { id, budget_id }) => {
    const rule = await transferStore.getPayeeTransferRule(pool, budget_id, id);
    if (!rule) throw new HttpError(404, 'payee not found');
    return transferRuleOutput(id, rule, await transferStore.countOpenPayeeRows(pool, budget_id, id), 0);
  }),

  implement(payeesSetTransferRule, async (_c, { id, budget_id, mode, account_id, no_match, wait_days, apply_to_past }) =>
    withTransaction(pool, async (client) => {
      const current = await transferStore.getPayeeTransferRule(client, budget_id, id);
      if (!current) throw new HttpError(404, 'payee not found');
      const accountId = mode === 'account' ? (account_id ?? null) : null;
      if (mode === 'account' && !accountId) throw new HttpError(400, 'choose the other account', 'transfer_rule_needs_account');
      if (accountId) {
        const account = await transferStore.getTransferAccount(client, budget_id, accountId);
        if (!account) throw new HttpError(400, 'account not found in budget', 'account_not_in_budget');
        if (!account.on_budget) throw new HttpError(400, 'only accounts in the budget', 'transfer_off_budget');
      }
      const linking = mode === 'auto' || mode === 'account';
      const wasLinking = current.mode === 'auto' || current.mode === 'account';
      // A new rule covers rows created from now on; "Apply to past rows" covers every row.
      const since = apply_to_past && linking ? null : linking && wasLinking ? 'keep' : 'now';
      await transferStore.setPayeeTransferRule(client, budget_id, id, {
        mode: mode === 'off' ? null : mode,
        accountId,
        noMatch: no_match ?? current.no_match,
        waitDays: wait_days ?? Number(current.wait_days),
        since,
      });
      const linked = linking ? await linkTransfers(client, budget_id) : 0;
      const saved = (await transferStore.getPayeeTransferRule(client, budget_id, id))!;
      return transferRuleOutput(id, saved, await transferStore.countOpenPayeeRows(client, budget_id, id), linked);
    }),
  ),
];

export default budgetRouter('/payees', operations);
