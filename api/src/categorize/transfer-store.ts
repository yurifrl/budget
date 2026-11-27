/**
 * SQL for the Categorize page's Transfers section: Jev's transfer suggestions,
 * read as pending rows of `category_suggestions` that name an account instead of
 * a category. Nothing here applies one; accept goes through decision-store.
 *
 * A row appears here only when its TOP visible suggestion is a transfer (a row
 * whose best suggestion is a category stays in the category queue, with its
 * category suggestions only: one row, one place), and only while accept would
 * take it — the same rules (`TRANSFER_ASKABLE_WHERE`, and `TRANSFER_PAIR_OPEN`
 * inside the visible suggestions) accept re-checks for that account, so the
 * section cannot offer something accept then refuses. A pair the person refused,
 * or that their "not a transfer" mark covers, is gone from both.
 */
import type { CategorizeTransferGroup } from '@shared/contracts/categorize';

import type { Queryable } from '../core/db';

import { getConfidenceThreshold } from './queue-store';
import { matcherRowIds, NEEDS_CATEGORY_FROM, TRANSFER_ASKABLE_WHERE, VISIBLE_SUGGESTIONS } from './store';
import { TRANSFER_WINDOW_DAYS } from './run-store';

type SuggestionRow = {
  transaction_id: string;
  date: string;
  amount: number;
  account_id: string;
  account_name: string;
  payee_id: string | null;
  payee: string;
  confidence: number;
  transfer_account_id: string;
  transfer_account_name: string;
  on_budget: boolean;
};

/**
 * Jev's transfer suggestions, grouped by the account they name and by direction
 * (`to` on an outflow, `from` on an inflow). The threshold is read at call time,
 * so a changed setting applies to the very next read.
 */
export async function transferSuggestions(
  db: Queryable,
  budgetId: string,
): Promise<CategorizeTransferGroup[]> {
  const threshold = await getConfidenceThreshold(db, budgetId);
  const matcherRows = await matcherRowIds(db, budgetId);
  const { rows } = await db.query<SuggestionRow>(
    `select s.transaction_id, t.date::text as date, t.amount,
            t.account_id, a.name as account_name, t.payee_id,
            coalesce(p.name, t.import_payee_name, '') as payee,
            s.confidence, s.transfer_account_id,
            ta.name as transfer_account_name, ta.on_budget
       ${NEEDS_CATEGORY_FROM}
       join lateral (${VISIBLE_SUGGESTIONS('$3')} limit 1) s on true
       join public.accounts ta on ta.id = s.transfer_account_id and ta.budget_id = t.budget_id
      ${TRANSFER_ASKABLE_WHERE('$4')}
        -- A transfer answer is one that names ONLY an account: a row whose top
        -- suggestion also carries a category (a released build's leftover) is a
        -- category suggestion everywhere, so it is never listed here.
        and s.category_id is null
        and s.transfer_account_id is not null
      order by ta.name, t.date desc, t.id`,
    [budgetId, matcherRows, threshold, TRANSFER_WINDOW_DAYS],
  );

  const groups = new Map<string, CategorizeTransferGroup>();
  for (const row of rows) {
    const direction = row.amount < 0 ? 'to' : 'from';
    const key = `${row.transfer_account_id}:${direction}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        transfer_account_id: row.transfer_account_id,
        transfer_account_name: row.transfer_account_name,
        direction,
        on_budget: row.on_budget,
        total: 0,
        rows: [],
      };
      groups.set(key, group);
    }
    group.total += row.amount;
    group.rows.push({
      transaction_id: row.transaction_id,
      date: row.date,
      amount: row.amount,
      account_id: row.account_id,
      account_name: row.account_name,
      payee_id: row.payee_id,
      payee: row.payee,
      confidence: row.confidence,
    });
  }
  return [...groups.values()];
}
