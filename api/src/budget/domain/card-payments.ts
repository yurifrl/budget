/**
 * Credit-card statement payments in bank imports (server side).
 *
 * A bank reports a card payment as two unrelated rows: an outflow on a cash
 * account and an inflow on the card. The budget engine only treats it as a
 * transfer (draining the card's payment envelope instead of Ready to Assign)
 * when the rows carry `transfer_account_id`, so imports are paired here after
 * the fact. `linkCardPayments` runs at the end of every connections sync and
 * of every `/bulk` import for the budget; it is idempotent, so it is also the
 * backfill for rows imported earlier.
 *
 * The matcher is deliberately conservative (see `matchCardPayments`). The
 * providers expose no reliable payment marker through the connections port
 * (Pluggy's `type` is only DEBIT/CREDIT and its free-form `category` is not
 * carried by the adapter), so the rule is structural: amounts, dates, account
 * kinds and uniqueness. Description text is never consulted.
 */
import type { PoolClient } from 'pg';

import { ensureTransferPayee } from './transfers';

/** One transaction plus the account facts the matcher needs. Amount in milliunits. */
export interface PaymentRow {
  id: string;
  budgetId: string;
  accountId: string;
  /** `cash` = checking/savings/cash; `card` = credit card; anything else never pairs. */
  accountKind: 'cash' | 'card' | 'other';
  onBudget: boolean;
  amount: number;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  categoryId: string | null;
  splitCount: number;
  transferAccountId: string | null;
  transferTransactionId: string | null;
  /** Bank-imported and not edited since (payee still the bank text, sync-owned). */
  untouched: boolean;
}

export const MAX_PAYMENT_DAYS_APART = 3;

const DAY_MS = 86_400_000;
const daysApart = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;

const eligible = (r: PaymentRow): boolean =>
  r.untouched &&
  r.onBudget &&
  r.categoryId == null &&
  r.splitCount === 0 &&
  r.transferAccountId == null &&
  r.transferTransactionId == null;

/**
 * Pairs of (cash outflow, card inflow) that are unambiguously one statement
 * payment: same budget, exactly equal absolute amounts, at most 3 days apart,
 * and each side is the other's only candidate.
 */
export function matchCardPayments(rows: readonly PaymentRow[]): { outflowId: string; inflowId: string }[] {
  const ok = rows.filter(eligible);
  const outflows = ok.filter((r) => r.accountKind === 'cash' && r.amount < 0);
  const inflows = ok.filter((r) => r.accountKind === 'card' && r.amount > 0);
  const fits = (o: PaymentRow, i: PaymentRow) =>
    o.budgetId === i.budgetId &&
    -o.amount === i.amount &&
    daysApart(o.date, i.date) <= MAX_PAYMENT_DAYS_APART;
  const pairs: { outflowId: string; inflowId: string }[] = [];
  for (const o of outflows) {
    const candidates = inflows.filter((i) => fits(o, i));
    if (candidates.length !== 1) continue;
    const [i] = candidates;
    if (outflows.filter((o2) => fits(o2, i)).length !== 1) continue;
    pairs.push({ outflowId: o.id, inflowId: i.id });
  }
  return pairs;
}

interface CandidateSql {
  id: string;
  budget_id: string;
  account_id: string;
  account_name: string;
  kind: 'cash' | 'card' | 'other';
  on_budget: boolean;
  amount: string;
  date: string;
  category_id: string | null;
  split_count: string;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  untouched: boolean;
}

/**
 * Pair the budget's unlinked statement payments and return how many pairs were
 * linked. Call inside the caller's transaction.
 *
 * "Untouched" is what lets a manual edit win without a schema change: the row
 * must be bank-imported (`import_id`), its payee must still be the bank text
 * (`import_payee_name[_original]`; the app's unlink/edit flows leave a
 * `Transfer : ...` or user-chosen payee behind) and the sync shadow must not
 * be `blocked`. Linking rewrites the payee exactly as app-made transfers do
 * (`Transfer : <other account>`); the bank text stays in `import_payee_name*`
 * and the shadow row is blocked so later syncs leave the linked rows frozen.
 * Amounts, dates, cleared state, approval and import ids are not touched.
 */
export async function linkCardPayments(client: PoolClient, budgetId: string): Promise<number> {
  const found = await client.query<CandidateSql>(
    `SELECT t.id, t.budget_id, t.account_id, a.name AS account_name,
            CASE WHEN a.type = 'creditCard' OR a.account_group = 'CREDIT' THEN 'card'
                 WHEN a.type IN ('checking','savings','cash') THEN 'cash' ELSE 'other' END AS kind,
            a.on_budget, t.amount::text AS amount, t.date::text AS date, t.category_id,
            (SELECT count(*) FROM subtransactions s WHERE s.transaction_id = t.id AND NOT s.deleted)::text AS split_count,
            t.transfer_account_id, t.transfer_transaction_id,
            (t.import_id IS NOT NULL
             AND COALESCE(cs.blocked, false) = false
             AND (t.payee_id IS NULL OR p.name IN (t.import_payee_name, t.import_payee_name_original))) AS untouched
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN payees p ON p.id = t.payee_id
     LEFT JOIN connection_transactions cs ON cs.transaction_id = t.id
     WHERE t.budget_id = $1 AND NOT t.deleted AND NOT a.deleted AND NOT a.closed
       AND t.transfer_account_id IS NULL AND t.transfer_transaction_id IS NULL AND t.category_id IS NULL`,
    [budgetId],
  );
  const byId = new Map(found.rows.map((r) => [r.id, r]));
  const pairs = matchCardPayments(
    found.rows.map((r) => ({
      id: r.id,
      budgetId: r.budget_id,
      accountId: r.account_id,
      accountKind: r.kind,
      onBudget: r.on_budget,
      amount: Number(r.amount),
      date: r.date,
      categoryId: r.category_id,
      splitCount: Number(r.split_count),
      transferAccountId: r.transfer_account_id,
      transferTransactionId: r.transfer_transaction_id,
      untouched: r.untouched,
    })),
  );
  for (const { outflowId, inflowId } of pairs) {
    const out = byId.get(outflowId)!;
    const inn = byId.get(inflowId)!;
    const outPayee = await ensureTransferPayee(client, budgetId, inn.account_id, inn.account_name);
    const inPayee = await ensureTransferPayee(client, budgetId, out.account_id, out.account_name);
    await client.query(
      `UPDATE transactions SET transfer_account_id = $2, transfer_transaction_id = $3, payee_id = $4 WHERE id = $1`,
      [out.id, inn.account_id, inn.id, outPayee],
    );
    await client.query(
      `UPDATE transactions SET transfer_account_id = $2, transfer_transaction_id = $3, payee_id = $4 WHERE id = $1`,
      [inn.id, out.account_id, out.id, inPayee],
    );
    await client.query(
      `UPDATE connection_transactions SET blocked = true, updated_at = now() WHERE transaction_id = ANY($1)`,
      [[out.id, inn.id]],
    );
  }
  return pairs.length;
}
