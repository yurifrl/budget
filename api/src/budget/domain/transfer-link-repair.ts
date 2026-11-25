/**
 * Repair of half-linked transfers (budget-nq2f, transfers T3), part of the
 * transfer repair (`repairTransferPayees`, scripts/repair-transfer-payees.ts).
 *
 * A transfer is two live rows that point at each other, each at the other's
 * account (`transfer_account_id` / `transfer_transaction_id`, kept correct
 * because another app reads them), each carrying the peer account's transfer
 * payee, with no category between two on-budget accounts. Older writers left
 * rows that are only part of that (repeat rules, restored backups and budget
 * copies before this change; imports that stored the payee only). Reading such
 * a row never rewrites it; this repair finds them and, with `apply`, completes
 * them. Everything is scoped to one budget and idempotent: a second run lists
 * only what needs a decision.
 *
 * What it finds (`HalfLinkedItem.kind`):
 *  - `complete_pointers`  a mutual pair whose leg misses the peer's ACCOUNT pointer
 *                         (restored backups): the pointer is set;
 *  - `set_payee`          a leg of a mutual pair whose payee is empty or another
 *                         account's transfer payee: the peer account's transfer
 *                         payee is set (an ordinary payee is left as it is);
 *  - `clear_category`     a leg of a pair between two on-budget accounts that still
 *                         carries a category: cleared (the engine ignored it);
 *  - `pair`               a leg with only the account pointer (budget copies), or
 *                         with only a transfer payee (repeat rules, old imports), and
 *                         exactly one row in the peer account that is its other side
 *                         (opposite amount; the same day for a copy, within 3 days for
 *                         a payee-only row, which must be unlinked and uncategorized):
 *                         both are linked, no balance moves. A bank row that takes a
 *                         new payee keeps its old one in `transfer_links`, so
 *                         POST /transfers/unlink undoes it;
 *  - `needs_mirror`       such a leg with NO other side anywhere: reported, and
 *                         created only with `createMirrors` (it moves the peer
 *                         account's balance, which the owner decides);
 *  - `ambiguous`          several equally close other sides, or an account that
 *                         cannot receive the transfer (closed, deleted, its own):
 *                         reported, never touched.
 */
import type { Queryable } from '../../core/db';
import { blockImportShadows, listImportHints } from '../../connections';
import * as store from '../store/transfers';
import { MAX_TRANSFER_DAYS_APART } from './transfer-matcher';
import { applyBalanceDeltas } from './transactions';
import { ensureTransferPayee } from './transfer-payees';
import { insertMirror } from './transfers';
import { planAdoptions } from './transfer-links';

export type HalfLinkedKind = 'complete_pointers' | 'set_payee' | 'clear_category' | 'pair' | 'needs_mirror' | 'ambiguous' | 'unadopted';

export interface HalfLinkedItem {
  kind: HalfLinkedKind;
  transaction_id: string;
  /** The other leg: the row at the other end (`pair`, `complete_pointers`) or null. */
  peer_id: string | null;
  /** The peer account (all kinds but `clear_category`). */
  peer_account_id: string | null;
  detail?: string;
}

export interface HalfLinkedReport {
  items: HalfLinkedItem[];
  complete_pointers: number;
  set_payee: number;
  clear_category: number;
  paired: number;
  needs_mirror: number;
  ambiguous: number;
  /** Hand-made mirrors and bank rows that look like one movement but the matcher's gates refused to merge (see `planAdoptions`). */
  unadopted: number;
  /** Mirrors created by `apply` with `createMirrors`. */
  mirrors_created: number;
}

interface LegRow {
  id: string;
  account_id: string;
  date: string;
  amount: string;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  approved: boolean;
  memo: string | null;
  upcoming: boolean;
  payee_id: string | null;
  category_id: string | null;
  peer_account_id: string;
  /** `pointer`: only transfer_account_id is set; `payee`: only the payee says transfer. */
  how: 'pointer' | 'payee';
}

const LEG_COLUMNS = `r.id, r.account_id, r.date::text AS date, r.amount::text AS amount, r.cleared, r.approved, r.memo,
  r.upcoming, r.payee_id, r.category_id`;

/** Rows of mutual pairs whose pointers, payees or category are incomplete. */
async function planCompleteLinks(db: Queryable, budgetId: string): Promise<HalfLinkedItem[]> {
  const items: HalfLinkedItem[] = [];
  const pairs = await db.query<{ id: string; peer_id: string; peer_account_id: string; account_ok: boolean; payee_bad: boolean; categorized: boolean }>(
    `SELECT r.id, p.id AS peer_id, p.account_id AS peer_account_id,
            (r.transfer_account_id = p.account_id) AS account_ok,
            (r.payee_id IS NULL OR (py.transfer_account_id IS NOT NULL AND py.transfer_account_id <> p.account_id)) AS payee_bad,
            (r.category_id IS NOT NULL AND ra.on_budget AND pa.on_budget) AS categorized
       FROM transactions r
       JOIN transactions p ON p.id = r.transfer_transaction_id AND p.transfer_transaction_id = r.id
                          AND p.budget_id = r.budget_id AND NOT p.deleted AND p.account_id <> r.account_id
       JOIN accounts ra ON ra.id = r.account_id
       JOIN accounts pa ON pa.id = p.account_id
       LEFT JOIN payees py ON py.id = r.payee_id
      WHERE r.budget_id = $1 AND NOT r.deleted
        AND (r.transfer_account_id IS DISTINCT FROM p.account_id
             OR r.payee_id IS NULL OR (py.transfer_account_id IS NOT NULL AND py.transfer_account_id <> p.account_id)
             OR (r.category_id IS NOT NULL AND ra.on_budget AND pa.on_budget))
      ORDER BY r.date, r.id`,
    [budgetId],
  );
  for (const r of pairs.rows) {
    const base = { transaction_id: r.id, peer_id: r.peer_id, peer_account_id: r.peer_account_id };
    if (!r.account_ok) items.push({ kind: 'complete_pointers', ...base });
    if (r.payee_bad) items.push({ kind: 'set_payee', ...base });
    if (r.categorized) items.push({ kind: 'clear_category', ...base });
  }
  return items;
}

/** Legs with only the account pointer, or only a transfer payee, and no transaction pointer. */
async function listOneSidedLegs(db: Queryable, budgetId: string): Promise<LegRow[]> {
  const byPointer = await db.query<Omit<LegRow, 'how'>>(
    `SELECT ${LEG_COLUMNS}, r.transfer_account_id AS peer_account_id
       FROM transactions r
      WHERE r.budget_id = $1 AND NOT r.deleted AND r.transfer_account_id IS NOT NULL AND r.transfer_transaction_id IS NULL`,
    [budgetId],
  );
  const byPayee = await db.query<Omit<LegRow, 'how'>>(
    `SELECT ${LEG_COLUMNS}, py.transfer_account_id AS peer_account_id
       FROM transactions r
       JOIN payees py ON py.id = r.payee_id AND py.transfer_account_id IS NOT NULL
      WHERE r.budget_id = $1 AND NOT r.deleted AND r.transfer_account_id IS NULL AND r.transfer_transaction_id IS NULL`,
    [budgetId],
  );
  return [
    ...byPointer.rows.map((r) => ({ ...r, how: 'pointer' as const })),
    ...byPayee.rows.map((r) => ({ ...r, how: 'payee' as const })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

interface Candidate {
  id: string;
  payee_id: string | null;
  category_id: string | null;
  days: number;
}

/** The other sides a one-sided leg could have, closest first. */
async function candidatesFor(db: Queryable, budgetId: string, leg: LegRow): Promise<Candidate[]> {
  const sameDay = leg.how === 'pointer';
  const r = await db.query<Candidate>(
    `SELECT p.id, p.payee_id, p.category_id, abs(p.date - $4::date)::int AS days
       FROM transactions p
      WHERE p.budget_id = $1 AND p.account_id = $2 AND NOT p.deleted AND p.upcoming = $6 AND p.id <> $3
        AND p.amount = -$5::bigint AND p.transfer_transaction_id IS NULL
        AND ($7::boolean OR (p.transfer_account_id IS NULL AND p.category_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM subtransactions s WHERE s.transaction_id = p.id AND NOT s.deleted)
             AND NOT EXISTS (SELECT 1 FROM transfer_marks m WHERE m.transaction_id = p.id AND m.state = 'dismissed')))
        AND (p.transfer_account_id IS NULL OR p.transfer_account_id = $8)
        AND abs(p.date - $4::date) <= $9
      ORDER BY days, p.date, p.id`,
    [budgetId, leg.peer_account_id, leg.id, leg.date, leg.amount, leg.upcoming, sameDay, leg.account_id, sameDay ? 0 : MAX_TRANSFER_DAYS_APART],
  );
  return r.rows;
}

/** An account that can take part in a transfer now (live, open, not the leg's own). */
async function peerUsable(db: Queryable, budgetId: string, ownAccountId: string, peerAccountId: string): Promise<boolean> {
  if (peerAccountId === ownAccountId) return false;
  const r = await db.query('SELECT 1 FROM accounts WHERE id = $1 AND budget_id = $2 AND NOT deleted AND NOT closed', [peerAccountId, budgetId]);
  return (r.rowCount ?? 0) > 0;
}

async function bothOnBudget(db: Queryable, budgetId: string, a: string, b: string): Promise<boolean> {
  const r = await db.query('SELECT count(*)::int AS n FROM accounts WHERE id = ANY($1) AND budget_id = $2 AND on_budget', [[a, b], budgetId]);
  return r.rows[0]?.n === 2;
}

interface PlannedPair {
  leg: LegRow;
  other: Candidate;
}

/**
 * The repair plan of one budget, read-only. `pairs` carries what `apply` needs
 * beyond the report's items.
 */
export async function planHalfLinkedTransfers(db: Queryable, budgetId: string): Promise<{ report: HalfLinkedReport; pairs: PlannedPair[]; mirrors: LegRow[] }> {
  const items = await planCompleteLinks(db, budgetId);
  const pairs: PlannedPair[] = [];
  const mirrors: LegRow[] = [];
  const claimed = new Set<string>();
  for (const leg of await listOneSidedLegs(db, budgetId)) {
    if (claimed.has(leg.id)) continue; // already the other side of an earlier leg
    if (!(await peerUsable(db, budgetId, leg.account_id, leg.peer_account_id))) {
      items.push({ kind: 'ambiguous', transaction_id: leg.id, peer_id: null, peer_account_id: leg.peer_account_id, detail: 'the account cannot receive a transfer (closed, deleted or its own)' });
      continue;
    }
    const free = (await candidatesFor(db, budgetId, leg)).filter((c) => !claimed.has(c.id));
    const best = free[0];
    if (!best) {
      items.push({ kind: 'needs_mirror', transaction_id: leg.id, peer_id: null, peer_account_id: leg.peer_account_id });
      mirrors.push(leg);
    } else if (free[1] && free[1].days === best.days) {
      items.push({ kind: 'ambiguous', transaction_id: leg.id, peer_id: null, peer_account_id: leg.peer_account_id, detail: 'several rows could be the other side' });
    } else {
      claimed.add(best.id).add(leg.id);
      items.push({ kind: 'pair', transaction_id: leg.id, peer_id: best.id, peer_account_id: leg.peer_account_id });
      pairs.push({ leg, other: best });
    }
  }
  for (const refusal of (await planAdoptions(db, budgetId)).refused) {
    items.push({ kind: 'unadopted', transaction_id: refusal.bank_id, peer_id: refusal.hand_id, peer_account_id: null, detail: refusal.reason });
  }
  const count = (kind: HalfLinkedKind) => items.filter((i) => i.kind === kind).length;
  return {
    report: {
      items,
      complete_pointers: count('complete_pointers'),
      set_payee: count('set_payee'),
      clear_category: count('clear_category'),
      paired: count('pair'),
      needs_mirror: count('needs_mirror'),
      ambiguous: count('ambiguous'),
      unadopted: count('unadopted'),
      mirrors_created: 0,
    },
    pairs,
    mirrors,
  };
}

/** Report (`apply: false`: reads only) or perform the half-link repair of one budget. */
export async function repairHalfLinkedTransfers(
  db: Queryable,
  budgetId: string,
  opts: { apply: boolean; createMirrors?: boolean },
): Promise<HalfLinkedReport> {
  const { report, pairs, mirrors } = await planHalfLinkedTransfers(db, budgetId);
  if (!opts.apply) return report;

  // Rows that only miss the account pointer / payee / category (mutual pairs).
  const touched: string[] = [];
  for (const item of report.items) {
    if (item.kind === 'complete_pointers') {
      await db.query('UPDATE transactions SET transfer_account_id = $2 WHERE id = $1 AND budget_id = $3', [item.transaction_id, item.peer_account_id, budgetId]);
    } else if (item.kind === 'set_payee') {
      const payeeId = await ensureTransferPayee(db, budgetId, item.peer_account_id!);
      await db.query('UPDATE transactions SET payee_id = $2 WHERE id = $1 AND budget_id = $3', [item.transaction_id, payeeId, budgetId]);
    }
    if (item.kind === 'clear_category') touched.push(item.transaction_id);
  }
  await store.clearCategoryOfOnBudgetTransfers(db, budgetId, touched);

  // One-sided legs with exactly one other side: link them (no balance moves).
  for (const { leg, other } of pairs) {
    const legPayee = await ensureTransferPayee(db, budgetId, leg.peer_account_id);
    const otherPayee = await ensureTransferPayee(db, budgetId, leg.account_id);
    const hints = await listImportHints(db, [other.id]);
    // Between two on-budget accounts no category; a transfer to an off-budget account keeps its own.
    const internal = await bothOnBudget(db, budgetId, leg.account_id, leg.peer_account_id);
    await store.writeTransferLeg(db, leg.id, leg.peer_account_id, other.id, legPayee, { clearCategory: internal });
    await store.writeTransferLeg(db, other.id, leg.account_id, leg.id, otherPayee, { clearCategory: internal });
    // A record on BOTH legs, each with what it was, so POST /transfers/unlink restores
    // the state from before the repair (the one-sided record made unlink a no-op).
    await store.insertTransferLink(db, budgetId, {
      transaction_id: other.id,
      peer_transaction_id: leg.id,
      method: 'auto',
      prev_payee_id: other.payee_id,
      prev_category_id: other.category_id,
      prev_blocked: hints.get(other.id)?.blocked ?? null,
      created_mirror: false,
    });
    await store.insertTransferLink(db, budgetId, {
      transaction_id: leg.id,
      peer_transaction_id: other.id,
      method: 'auto',
      prev_payee_id: leg.payee_id,
      prev_category_id: leg.category_id,
      prev_blocked: null,
      created_mirror: false,
    });
    await blockImportShadows(db, [other.id]);
    await store.setTransferMarks(db, budgetId, [leg.id, other.id], null);
    await store.clearTransferHints(db, budgetId, [leg.id, other.id]);
  }

  // Legs with no other side anywhere: a mirror only when asked (it moves a balance).
  let created = 0;
  if (opts.createMirrors) {
    for (const leg of mirrors) {
      const made = await insertMirror(db, budgetId, leg, leg.peer_account_id);
      await applyBalanceDeltas(db, budgetId, made.deltas);
      await store.clearCategoryOfOnBudgetTransfers(db, budgetId, [leg.id]);
      created += 1;
    }
  }
  return { ...report, mirrors_created: created };
}
