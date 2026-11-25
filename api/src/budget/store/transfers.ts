/**
 * Budget store: transfers between own accounts (budget-mit6). SQL only; every
 * function takes a Queryable. Tables: `transfer_marks`, `transfer_links`, the
 * payee `transfer_rule*` columns, plus the transaction columns a link writes.
 */
import type { Queryable } from '../../core/db';

/** A row the transfer matcher may look at, with names for the review list. */
export interface TransferCandidateSql {
  id: string;
  budget_id: string;
  account_id: string;
  account_name: string;
  kind: 'cash' | 'card' | 'other';
  /** The account type is 'checking' (kind 'cash' also covers savings and cash). */
  checking: boolean;
  on_budget: boolean;
  amount: string;
  date: string;
  created_at: string | null;
  category_id: string | null;
  split_count: string;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  payee_id: string | null;
  payee_name: string | null;
  /** Bank-imported with the bank's payee text (the sync shadow's `blocked` flag is read separately). */
  untouched_ledger: boolean;
  mark: 'dismissed' | 'outside' | 'manual' | null;
  /** The account's bank connection, when linked. */
  connection_id: string | null;
  /** The account's institution label, else its connection's (raw text; see domain/bank-key.ts). */
  institution: string | null;
  /** The account an import's payee text pointed at (`transfer_hints`), until the row is linked. */
  hint_account_id: string | null;
}

const CANDIDATE_SELECT = `
  SELECT t.id, t.budget_id, t.account_id, a.name AS account_name,
         CASE WHEN a.type = 'creditCard' OR a.account_group = 'CREDIT' THEN 'card'
              WHEN a.type IN ('checking','savings','cash') THEN 'cash' ELSE 'other' END AS kind,
         (a.type = 'checking') AS checking,
         a.on_budget, t.amount::text AS amount, t.date::text AS date,
         to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
         t.category_id,
         (SELECT count(*) FROM subtransactions s WHERE s.transaction_id = t.id AND NOT s.deleted)::text AS split_count,
         t.transfer_account_id, t.transfer_transaction_id, t.payee_id, p.name AS payee_name,
         (t.import_id IS NOT NULL
          AND (t.payee_id IS NULL OR p.name IN (t.import_payee_name, t.import_payee_name_original))) AS untouched_ledger,
         m.state AS mark,
         a.connection_id, COALESCE(NULLIF(btrim(a.institution), ''), c.institution) AS institution,
         h.account_id AS hint_account_id
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN connections c ON c.id = a.connection_id
  LEFT JOIN payees p ON p.id = t.payee_id
  LEFT JOIN transfer_marks m ON m.transaction_id = t.id
  LEFT JOIN transfer_hints h ON h.transaction_id = t.id`;

/**
 * The budget's live, unlinked, uncategorized rows in open accounts: every row
 * the matcher could pair (the rest can never be a candidate). Upcoming
 * (future repeat) rows are left out.
 */
export async function listTransferCandidates(db: Queryable, budgetId: string): Promise<TransferCandidateSql[]> {
  const r = await db.query<TransferCandidateSql>(
    `${CANDIDATE_SELECT}
     WHERE t.budget_id = $1 AND NOT t.deleted AND NOT t.upcoming AND NOT a.deleted AND NOT a.closed
       AND t.transfer_account_id IS NULL AND t.transfer_transaction_id IS NULL AND t.category_id IS NULL`,
    [budgetId],
  );
  return r.rows;
}

/** Specific rows of the budget in the candidate shape (any state; missing ids are absent). */
export async function getTransferRows(db: Queryable, budgetId: string, ids: readonly string[]): Promise<TransferCandidateSql[]> {
  if (ids.length === 0) return [];
  const r = await db.query<TransferCandidateSql>(
    `${CANDIDATE_SELECT}
     WHERE t.budget_id = $1 AND t.id = ANY($2) AND NOT t.deleted AND NOT a.deleted`,
    [budgetId, ids],
  );
  return r.rows;
}

/** Rows of `accountId` that could be the other leg of `amount` around `date` (unlinked, live), closest first. */
export async function findCounterpartInAccount(
  db: Queryable,
  budgetId: string,
  accountId: string,
  amount: number,
  date: string,
  maxDays: number,
): Promise<string | undefined> {
  const r = await db.query<{ id: string }>(
    `SELECT t.id FROM transactions t
     WHERE t.budget_id = $1 AND t.account_id = $2 AND NOT t.deleted AND NOT t.upcoming
       AND t.amount = $3 AND t.transfer_account_id IS NULL AND t.transfer_transaction_id IS NULL
       AND abs(t.date - $4::date) <= $5
       AND NOT EXISTS (SELECT 1 FROM transfer_marks m WHERE m.transaction_id = t.id AND m.state = 'dismissed')
     ORDER BY abs(t.date - $4::date), (t.category_id IS NOT NULL), t.date, t.id
     LIMIT 1`,
    [budgetId, accountId, amount, date, maxDays],
  );
  return r.rows[0]?.id;
}

/** Ids of `ids` that are live rows of the budget. */
export async function liveTransactionIdsInBudget(db: Queryable, budgetId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const r = await db.query<{ id: string }>(
    'SELECT id FROM transactions WHERE budget_id = $1 AND id = ANY($2) AND NOT deleted',
    [budgetId, ids],
  );
  return new Set(r.rows.map((row) => row.id));
}

// ---- payee rules --------------------------------------------------------------

export interface TransferRuleSql {
  payee_id: string;
  mode: 'auto' | 'account' | 'never';
  account_id: string | null;
  no_match: 'outside' | 'review';
  wait_days: number;
  since: string | null;
}

const RULE_SELECT = `SELECT p.id AS payee_id, p.transfer_rule AS mode, p.transfer_rule_account_id AS account_id,
         p.transfer_rule_no_match AS no_match, p.transfer_rule_wait_days AS wait_days,
         to_char(p.transfer_rule_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS since
  FROM payees p`;

/** The budget's active payee transfer rules. */
export async function listTransferRules(db: Queryable, budgetId: string): Promise<TransferRuleSql[]> {
  const r = await db.query<TransferRuleSql>(
    `${RULE_SELECT} WHERE p.budget_id = $1 AND NOT p.deleted AND p.transfer_rule IN ('auto','account','never')`,
    [budgetId],
  );
  return r.rows;
}

/** One payee's rule columns (mode null = off), or undefined for a payee outside the budget. */
export async function getPayeeTransferRule(
  db: Queryable,
  budgetId: string,
  payeeId: string,
): Promise<(Omit<TransferRuleSql, 'mode'> & { mode: TransferRuleSql['mode'] | null }) | undefined> {
  const r = await db.query(
    `${RULE_SELECT} WHERE p.id = $1 AND p.budget_id = $2 AND NOT p.deleted`,
    [payeeId, budgetId],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return { ...row, mode: ['auto', 'account', 'never'].includes(row.mode) ? row.mode : null };
}

/** Write a payee's rule. `since`: 'keep' leaves it, 'now' stamps now(), null = every row. */
export async function setPayeeTransferRule(
  db: Queryable,
  budgetId: string,
  payeeId: string,
  rule: { mode: TransferRuleSql['mode'] | null; accountId: string | null; noMatch: string; waitDays: number; since: 'keep' | 'now' | null },
): Promise<void> {
  const sinceSql = rule.since === 'keep' ? 'transfer_rule_since' : rule.since === 'now' ? 'now()' : 'NULL';
  await db.query(
    `UPDATE payees SET transfer_rule = $3, transfer_rule_account_id = $4, transfer_rule_no_match = $5,
            transfer_rule_wait_days = $6, transfer_rule_since = ${sinceSql}
     WHERE id = $1 AND budget_id = $2`,
    [payeeId, budgetId, rule.mode, rule.accountId, rule.noMatch, rule.waitDays],
  );
}

/** Live rows of a payee still uncategorized, unsplit and unlinked (not dismissed). */
export async function countOpenPayeeRows(db: Queryable, budgetId: string, payeeId: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM transactions t
     WHERE t.budget_id = $1 AND t.payee_id = $2 AND NOT t.deleted AND NOT t.upcoming
       AND t.category_id IS NULL AND t.transfer_account_id IS NULL AND t.transfer_transaction_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM subtransactions s WHERE s.transaction_id = t.id AND NOT s.deleted)
       AND NOT EXISTS (SELECT 1 FROM transfer_marks m WHERE m.transaction_id = t.id AND m.state = 'dismissed')`,
    [budgetId, payeeId],
  );
  return r.rows[0]?.n ?? 0;
}

// ---- marks ----------------------------------------------------------------------

export async function setTransferMarks(
  db: Queryable,
  budgetId: string,
  ids: readonly string[],
  state: 'dismissed' | 'outside' | 'manual' | null,
): Promise<number> {
  if (ids.length === 0) return 0;
  if (state === null) {
    const r = await db.query('DELETE FROM transfer_marks WHERE budget_id = $1 AND transaction_id = ANY($2)', [budgetId, ids]);
    return r.rowCount ?? 0;
  }
  const r = await db.query(
    `INSERT INTO transfer_marks (transaction_id, budget_id, state)
     SELECT id, budget_id, $3 FROM transactions WHERE budget_id = $1 AND id = ANY($2)
     ON CONFLICT (transaction_id) DO UPDATE SET state = EXCLUDED.state, created_at = now()`,
    [budgetId, ids, state],
  );
  return r.rowCount ?? 0;
}

// ---- links ----------------------------------------------------------------------

export interface TransferLinkSql {
  transaction_id: string;
  peer_transaction_id: string;
  method: 'auto' | 'rule' | 'user';
  prev_payee_id: string | null;
  prev_category_id: string | null;
  prev_blocked: boolean | null;
  created_mirror: boolean;
  /** Set on the bank row of an adopted pair: the hand-made row it replaced and what it took over. */
  adopted?: AdoptedRecord | null;
}

/** What an adoption replaced (stored in `transfer_links.adopted`), enough to undo it. */
export interface AdoptedRecord {
  /** The hand-made row that was soft-deleted. */
  replaced_id: string;
  /** The bank row's own fields before it took the user's over. */
  prev: { memo: string | null; flag_color: string | null; flag_name: string | null; approved: boolean; cleared: 'cleared' | 'uncleared' | 'reconciled'; date: string };
}

/** Point both legs at each other with their transfer payees; categories cleared (both accounts on budget). */
export async function writeTransferLeg(
  db: Queryable,
  legId: string,
  peerAccountId: string,
  peerId: string,
  payeeId: string,
  opts: { clearCategory?: boolean } = {},
): Promise<void> {
  await db.query(
    `UPDATE transactions SET transfer_account_id = $2, transfer_transaction_id = $3, payee_id = $4,
            category_id = CASE WHEN $5 THEN NULL ELSE category_id END WHERE id = $1`,
    [legId, peerAccountId, peerId, payeeId, opts.clearCategory ?? true],
  );
}

export async function insertTransferLink(db: Queryable, budgetId: string, link: TransferLinkSql): Promise<void> {
  await db.query(
    `INSERT INTO transfer_links
       (transaction_id, budget_id, peer_transaction_id, method, prev_payee_id, prev_category_id, prev_blocked, created_mirror, adopted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (transaction_id) DO UPDATE SET peer_transaction_id = EXCLUDED.peer_transaction_id,
       method = EXCLUDED.method, prev_payee_id = EXCLUDED.prev_payee_id, prev_category_id = EXCLUDED.prev_category_id,
       prev_blocked = EXCLUDED.prev_blocked, created_mirror = EXCLUDED.created_mirror, adopted = EXCLUDED.adopted,
       created_at = now()`,
    [
      link.transaction_id,
      budgetId,
      link.peer_transaction_id,
      link.method,
      link.prev_payee_id,
      link.prev_category_id,
      link.prev_blocked,
      link.created_mirror,
      link.adopted ? JSON.stringify(link.adopted) : null,
    ],
  );
}

/** Link records of `ids` and of their peers. */
export async function getTransferLinks(db: Queryable, budgetId: string, ids: readonly string[]): Promise<TransferLinkSql[]> {
  if (ids.length === 0) return [];
  const r = await db.query<TransferLinkSql>(
    `SELECT transaction_id, peer_transaction_id, method, prev_payee_id, prev_category_id, prev_blocked, created_mirror, adopted
     FROM transfer_links
     WHERE budget_id = $1 AND (transaction_id = ANY($2) OR peer_transaction_id = ANY($2))`,
    [budgetId, ids],
  );
  return r.rows;
}

export async function deleteTransferLinks(db: Queryable, budgetId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query('DELETE FROM transfer_links WHERE budget_id = $1 AND transaction_id = ANY($2)', [budgetId, ids]);
}

/** Restore a leg's pre-link payee and category and drop its transfer pointers. */
export async function restoreUnlinkedLeg(
  db: Queryable,
  legId: string,
  prev: { payeeId: string | null; categoryId: string | null },
): Promise<void> {
  await db.query(
    `UPDATE transactions SET transfer_account_id = NULL, transfer_transaction_id = NULL, payee_id = $2, category_id = $3 WHERE id = $1`,
    [legId, prev.payeeId, prev.categoryId],
  );
}

/** Who linked each still-linked leg of the budget (rows whose link record matches their pointers). */
export async function listTransferLinkMethods(db: Queryable, budgetId: string): Promise<Map<string, 'auto' | 'rule' | 'user'>> {
  const r = await db.query<{ transaction_id: string; method: 'auto' | 'rule' | 'user' }>(
    `SELECT l.transaction_id, l.method FROM transfer_links l
     JOIN transactions t ON t.id = l.transaction_id
     WHERE l.budget_id = $1 AND NOT t.deleted AND t.transfer_transaction_id = l.peer_transaction_id`,
    [budgetId],
  );
  return new Map(r.rows.map((row) => [row.transaction_id, row.method]));
}

/** The live transfer pointers of `ids` (to tell a still-linked pair from a stale record). */
export async function getTransferPointers(
  db: Queryable,
  budgetId: string,
  ids: readonly string[],
): Promise<Map<string, { account_id: string; amount: string; cleared: 'cleared' | 'uncleared' | 'reconciled'; transfer_transaction_id: string | null; deleted: boolean }>> {
  if (ids.length === 0) return new Map();
  const r = await db.query(
    `SELECT id, account_id, amount, cleared, transfer_transaction_id, deleted FROM transactions WHERE budget_id = $1 AND id = ANY($2)`,
    [budgetId, ids],
  );
  return new Map(r.rows.map((row) => [row.id as string, row]));
}

/** A live account of the budget with what linking needs; undefined when absent. */
export async function getTransferAccount(
  db: Queryable,
  budgetId: string,
  accountId: string,
): Promise<{ id: string; name: string; on_budget: boolean; closed: boolean } | undefined> {
  const r = await db.query<{ id: string; name: string; on_budget: boolean; closed: boolean }>(
    'SELECT id, name, on_budget, closed FROM accounts WHERE id = $1 AND budget_id = $2 AND NOT deleted',
    [accountId, budgetId],
  );
  return r.rows[0];
}

// ---- hints ----------------------------------------------------------------------

/** Remember which account an imported row's payee text pointed at (one per row). */
export async function setTransferHint(db: Queryable, budgetId: string, transactionId: string, accountId: string): Promise<void> {
  await db.query(
    `INSERT INTO transfer_hints (transaction_id, budget_id, account_id)
     SELECT id, budget_id, $3 FROM transactions WHERE id = $1 AND budget_id = $2
     ON CONFLICT (transaction_id) DO UPDATE SET account_id = EXCLUDED.account_id, created_at = now()`,
    [transactionId, budgetId, accountId],
  );
}

/** Drop the hints of rows that were linked (the link is the answer). */
export async function clearTransferHints(db: Queryable, budgetId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query('DELETE FROM transfer_hints WHERE budget_id = $1 AND transaction_id = ANY($2)', [budgetId, ids]);
}

// ---- categories on pairs ----------------------------------------------------------

/**
 * A leg of a transfer between two on-budget accounts carries no category
 * ("category not needed"), whatever wrote it. A leg is a row whose transfer
 * pointer or whose payee names the peer account; a leg to an off-budget
 * account keeps its category. Returns how many rows were cleared.
 */
export async function clearCategoryOfOnBudgetTransfers(db: Queryable, budgetId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await db.query(
    `UPDATE transactions t SET category_id = NULL
      WHERE t.id = ANY($2) AND t.budget_id = $1 AND t.category_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM accounts own WHERE own.id = t.account_id AND own.on_budget)
        AND EXISTS (
          SELECT 1 FROM accounts peer
           WHERE peer.budget_id = t.budget_id AND peer.on_budget
             AND peer.id = COALESCE(t.transfer_account_id, (SELECT p.transfer_account_id FROM payees p WHERE p.id = t.payee_id)))`,
    [budgetId, ids],
  );
  return r.rowCount ?? 0;
}

// ---- releasing and adopting legs ----------------------------------------------------

/** The link record of one leg (the undo record of the matcher / a person's link), if any. */
export async function getTransferLink(db: Queryable, budgetId: string, transactionId: string): Promise<TransferLinkSql | undefined> {
  const r = await db.query<TransferLinkSql>(
    `SELECT transaction_id, peer_transaction_id, method, prev_payee_id, prev_category_id, prev_blocked, created_mirror, adopted
     FROM transfer_links WHERE budget_id = $1 AND transaction_id = $2`,
    [budgetId, transactionId],
  );
  return r.rows[0];
}

/** Point a leg's link record at a new peer (the peer was replaced by another row). */
export async function repointTransferLinkPeer(
  db: Queryable,
  budgetId: string,
  transactionId: string,
  fromPeer: string,
  toPeer: string,
): Promise<void> {
  await db.query(
    'UPDATE transfer_links SET peer_transaction_id = $4 WHERE budget_id = $1 AND transaction_id = $2 AND peer_transaction_id = $3',
    [budgetId, transactionId, fromPeer, toPeer],
  );
}

/** What releasing a leg's mirror needs to know about the mirror row. */
export interface MirrorFacts {
  id: string;
  account_id: string;
  import_id: string | null;
  import_payee_name: string | null;
  upcoming: boolean;
}

/** A live row of the budget in the shape `releaseMirror` needs; undefined when absent or deleted. */
export async function getMirrorFacts(db: Queryable, budgetId: string, id: string): Promise<MirrorFacts | undefined> {
  const r = await db.query<MirrorFacts>(
    `SELECT id, account_id, import_id, import_payee_name, upcoming FROM transactions
     WHERE id = $1 AND budget_id = $2 AND NOT deleted`,
    [id, budgetId],
  );
  return r.rows[0];
}

/** A hand-made transfer leg and a bank-imported row that could be its real counterpart (same account, amount, within days). */
export interface AdoptablePair {
  /** The hand-made row the bank row would replace. */
  hand_id: string;
  bank_id: string;
  /** The hand-made row's peer (kept). */
  peer_id: string;
  peer_account_id: string;
  days: number;
}

/**
 * Pairs of (hand-made transfer leg, imported row) that look like one movement.
 * A hand-made leg has no import id and no sync shadow, sits in a mutual pair
 * with a live row of another on-budget account, and is not reconciled. The
 * imported row is live, uncategorized, unsplit, unlinked, in the SAME account
 * with the SAME signed amount, at most `maxDays` apart, carries NO decision of
 * the person's (no mark of any kind) and no payee "never" rule, and is not
 * hinted at another account. Neither hand-made row has a mark or a "never"
 * payee. The domain applies the matcher's account/bank rules, evidence and
 * ambiguity checks on top.
 */
export async function listAdoptablePairs(db: Queryable, budgetId: string, maxDays: number): Promise<AdoptablePair[]> {
  const r = await db.query<AdoptablePair>(
    `SELECT h.id AS hand_id, n.id AS bank_id, p.id AS peer_id, p.account_id AS peer_account_id,
            abs(n.date - h.date)::int AS days
       FROM transactions h
       JOIN transactions p ON p.id = h.transfer_transaction_id AND p.transfer_transaction_id = h.id
                          AND p.budget_id = h.budget_id AND NOT p.deleted
       JOIN accounts ha ON ha.id = h.account_id AND ha.on_budget AND NOT ha.deleted AND NOT ha.closed
       JOIN accounts pa ON pa.id = p.account_id AND pa.on_budget AND NOT pa.deleted
       JOIN transactions n ON n.budget_id = h.budget_id AND n.account_id = h.account_id AND n.amount = h.amount
                          AND n.id <> h.id AND abs(n.date - h.date) <= $2
      WHERE h.budget_id = $1 AND NOT h.deleted AND NOT h.upcoming AND h.import_id IS NULL AND h.cleared <> 'reconciled'
        AND h.transfer_account_id = p.account_id AND p.transfer_account_id = h.account_id
        AND NOT EXISTS (SELECT 1 FROM connection_transactions s WHERE s.transaction_id = h.id)
        AND NOT EXISTS (SELECT 1 FROM transfer_marks m WHERE m.transaction_id IN (h.id, p.id, n.id))
        AND NOT EXISTS (SELECT 1 FROM payees py WHERE py.id IN (n.payee_id, h.payee_id, p.payee_id) AND py.transfer_rule = 'never')
        AND NOT n.deleted AND NOT n.upcoming AND n.import_id IS NOT NULL AND n.category_id IS NULL
        AND n.transfer_account_id IS NULL AND n.transfer_transaction_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM subtransactions s WHERE s.transaction_id = n.id AND NOT s.deleted)
        AND NOT EXISTS (SELECT 1 FROM transfer_hints th WHERE th.transaction_id = n.id AND th.account_id <> p.account_id)
      ORDER BY days, h.date, h.id, n.date, n.id`,
    [budgetId, maxDays],
  );
  return r.rows;
}

/** The user-facing fields of a row (what an adoption merges). */
export interface RowFields {
  id: string;
  account_id: string;
  amount: string;
  date: string;
  memo: string | null;
  flag_color: string | null;
  flag_name: string | null;
  approved: boolean;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  payee_id: string | null;
  category_id: string | null;
  deleted: boolean;
}

export async function getRowFields(db: Queryable, budgetId: string, id: string): Promise<RowFields | undefined> {
  const r = await db.query<RowFields>(
    `SELECT id, account_id, amount::text AS amount, date::text AS date, memo, flag_color, flag_name, approved, cleared,
            payee_id, category_id, deleted
       FROM transactions WHERE id = $1 AND budget_id = $2`,
    [id, budgetId],
  );
  return r.rows[0];
}

/** Write the merged user-facing fields of an adoption (or restore them on undo). */
export async function setRowFields(
  db: Queryable,
  budgetId: string,
  id: string,
  f: { memo: string | null; flag_color: string | null; flag_name: string | null; approved: boolean; cleared: string; date: string },
): Promise<void> {
  await db.query(
    `UPDATE transactions SET memo = $3, flag_color = $4, flag_name = $5, approved = $6, cleared = $7, date = $8
      WHERE id = $1 AND budget_id = $2`,
    [id, budgetId, f.memo, f.flag_color, f.flag_name, f.approved, f.cleared, f.date],
  );
}

/** Bring a soft-deleted row back as one leg of a pair (undo of an adoption). */
export async function reviveLeg(db: Queryable, budgetId: string, id: string, peerAccountId: string, peerId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE transactions SET deleted = false, transfer_account_id = $3, transfer_transaction_id = $4
      WHERE id = $1 AND budget_id = $2 AND deleted`,
    [id, budgetId, peerAccountId, peerId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Point the peer of an adopted pair at the imported row (both pointers). */
export async function repointPeerLeg(db: Queryable, budgetId: string, peerId: string, ownAccountId: string, newPeerId: string): Promise<void> {
  await db.query('UPDATE transactions SET transfer_transaction_id = $4, transfer_account_id = $3 WHERE id = $1 AND budget_id = $2', [
    peerId,
    budgetId,
    ownAccountId,
    newPeerId,
  ]);
}

/**
 * The bank row a person's transfer leg was released from earlier (marked
 * "manual" when the leg stopped being a transfer) that is again the other side
 * of a leg now becoming a transfer: same account, same signed amount, within
 * `maxDays`, live, unlinked, uncategorized, unsplit. Only when exactly one row
 * fits.
 */
export async function findReleasedBankRow(
  db: Queryable,
  budgetId: string,
  accountId: string,
  amount: number,
  date: string,
  maxDays: number,
): Promise<string | undefined> {
  const r = await db.query<{ id: string }>(
    `SELECT t.id FROM transactions t
      WHERE t.budget_id = $1 AND t.account_id = $2 AND NOT t.deleted AND NOT t.upcoming AND t.import_id IS NOT NULL
        AND t.amount = $3 AND abs(t.date - $4::date) <= $5
        AND t.transfer_account_id IS NULL AND t.transfer_transaction_id IS NULL AND t.category_id IS NULL
        AND EXISTS (SELECT 1 FROM transfer_marks m WHERE m.transaction_id = t.id AND m.state = 'manual')
        AND NOT EXISTS (SELECT 1 FROM subtransactions s WHERE s.transaction_id = t.id AND NOT s.deleted)`,
    [budgetId, accountId, amount, date, maxDays],
  );
  return r.rows.length === 1 ? r.rows[0]!.id : undefined;
}
