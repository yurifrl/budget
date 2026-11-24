/**
 * Derived upcoming card installments for the register list
 * (`budget_transactions_list`). The rule lives in
 * `@shared/domain/installments`; this module turns its projections into
 * register rows. Nothing is stored: the rows exist only in the list answer,
 * so a newly imported installment makes its placeholder disappear on the next
 * read and there is nothing to clean up.
 */
import type { z } from '@shared/zod';
import type { transactionRowSchema } from '@shared/contracts/budget/outputs';
import { projectUpcomingInstallments } from '@shared/domain/installments';
import type { InstallmentSourceRow } from '../../connections';

type TransactionRow = z.input<typeof transactionRowSchema>;

/**
 * Register rows for the not-yet-billed installments of every installment
 * purchase in `sources`: `upcoming` (so no balance and no budget activity),
 * approved (never in the approval queue), uncleared, payee name
 * "<stem> kk/NN", the anchor's category and amount.
 */
export function upcomingInstallmentRows(sources: readonly InstallmentSourceRow[]): TransactionRow[] {
  const projected = projectUpcomingInstallments(
    sources.map((s) => ({
      id: s.id,
      accountId: s.account_id,
      date: s.date.slice(0, 10),
      amount: Number(s.amount),
      description: s.description ?? '',
      categoryId: s.category_id,
      deleted: s.deleted,
      raw: s.raw_payload,
    })),
  );
  return projected.map((p) => ({
    id: p.id,
    account_id: p.accountId,
    date: p.date,
    amount: p.amount,
    payee_id: null,
    payee_name: p.label,
    category_id: p.categoryId,
    memo: null,
    cleared: 'uncleared',
    approved: true,
    flag_color: null,
    flag_name: null,
    transfer_account_id: null,
    transfer_transaction_id: null,
    matched_transaction_id: null,
    import_id: null,
    import_payee_name: null,
    import_payee_name_original: null,
    debt_transaction_type: null,
    repeat: 'never',
    repeat_rule_id: null,
    occurrence_date: null,
    subtransactions: [],
    upcoming: true,
    deleted: false,
    installment: { number: p.number, total: p.total },
  }));
}
