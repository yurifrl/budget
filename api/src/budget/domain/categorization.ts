import type { Queryable } from '../../core/db';
import {
  suggestCategory,
  type CategorizationHistoryRow,
  type CategorizationMode,
} from '@shared/domain/payees';

/**
 * The category a new transaction for this payee should be preselected with,
 * per the payee's categorization mode and history (auto-categorization).
 * Only categories still present and not tombstoned participate; null means
 * "leave uncategorized". Shared by the transaction-create path and the
 * payee-suggestions preview route.
 */
export async function suggestedCategoryForPayee(
  client: Queryable,
  budgetId: string,
  payeeId: string | null,
): Promise<string | null> {
  if (!payeeId) return null;
  const payee = await client.query<{
    categorization_mode: CategorizationMode;
    default_category_id: string | null;
  }>('SELECT categorization_mode, default_category_id FROM payees WHERE id = $1 AND budget_id = $2', [
    payeeId,
    budgetId,
  ]);
  const row = payee.rows[0];
  if (!row || row.categorization_mode === 'never') return null;

  if (row.categorization_mode === 'fixed') {
    if (row.default_category_id == null) return null;
    // A tombstoned default must not resurrect onto new transactions.
    const live = await client.query(
      'SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2 AND deleted = false',
      [row.default_category_id, budgetId],
    );
    return live.rowCount ? row.default_category_id : null;
  }

  // 'auto': infer from this payee's live-transaction history. Rows with no
  // (or a tombstoned) category carry no signal and are filtered out.
  const history = await client.query<CategorizationHistoryRow>(
    `SELECT t.category_id, t.date::text AS date
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.payee_id = $1 AND t.budget_id = $2 AND t.deleted = false
       AND c.deleted = false AND c.budget_id = $2
     ORDER BY t.date, t.created_at`,
    [payeeId, budgetId],
  );
  return suggestCategory(row, history.rows, row.categorization_mode);
}
