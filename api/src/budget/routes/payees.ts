import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { applyRules } from '@shared/domain/payees';
import {
  payeesCreate,
  payeesDelete,
  payeesList,
  payeesMerge,
  payeesRename,
  payeesSetCategorization,
  payeesSetHidden,
  payeesSetRenameRule,
  payeesTransactions,
} from '@shared/contracts/budget';
import { loadRenameRules } from '../domain/transactions';
import { budgetRouter } from '../router';
import { categoryInBudget } from '../store/categories';
import * as payeesStore from '../store/payees';
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

async function requirePayee(budgetId: string, id: string): Promise<void> {
  if (!(await payeesStore.livePayeeExists(pool, budgetId, id))) throw new HttpError(404, 'payee not found');
}

export const operations = [
  implement(payeesList, async (_c, { budget_id, hidden }) => payeesStore.listPayees(pool, budget_id, hidden)),

  implement(payeesCreate, async (_c, { budget_id, name, default_category_id, hidden, categorization_mode }) => {
    if (default_category_id) {
      if (!(await categoryInBudget(pool, default_category_id, budget_id))) throw new HttpError(400, 'category not found in budget', 'category_not_in_budget');
    }
    // Rule-aware create: a name matching a payee's rename condition lands as
    // that payee's name, mirroring what transaction creation would do.
    const rules = await loadRenameRules(pool, budget_id);
    const effectiveName = applyRules(rules.rows, name);
    return payeesStore.insertPayee(pool, {
      budgetId: budget_id,
      name: effectiveName,
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
    if (!(await payeesStore.softDeletePayee(pool, id, budget_id))) throw new HttpError(404, 'payee not found');
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

      const merged = await payeesStore.movePayeeTransactions(client, id, target_id);
      await payeesStore.markPayeeDeleted(client, id);
      return { merged_transactions: merged, source_deleted: true };
    });
  }),

  // per-payee renaming rule (the payee's own name is the rename target)
  implement(payeesSetRenameRule, async (_c, { id, budget_id, match_type, condition }) => {
    // Empty condition clears the rule (one rule per payee; deleting = clearing).
    const updated = await payeesStore.setPayeeRenameRule(
      pool,
      id,
      budget_id,
      condition === '' ? null : match_type,
      condition === '' ? null : condition,
    );
    if (!updated) throw new HttpError(404, 'payee not found');
  }),
];

export default budgetRouter('/payees', operations);
