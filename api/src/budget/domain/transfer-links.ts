/**
 * Transfers between own accounts (server side, budget-mit6): load the budget's
 * candidate rows, run the pure matcher (transfer-matcher.ts) and write links.
 *
 * `linkTransfers` runs at the end of every connections sync and every `/bulk`
 * import for the budget (it replaced the card-payment-only pairing). It is
 * idempotent and only reads unlinked, uncategorized rows (bucketed by amount),
 * so it is also the backfill over the whole history.
 *
 * A link rewrites both legs exactly as app-made transfers do: the peer
 * account's `Transfer : <name>` payee, no category, pointers to each other.
 * What it replaced (payee, category, the sync shadow's `blocked` flag) is kept
 * in `transfer_links`, so unlinking (Undo) restores it. The bank text stays in
 * `import_payee_name*`; the shadows are blocked so later syncs leave the linked
 * rows frozen. Amounts, dates, cleared state, approval and import ids are not
 * touched.
 */
import type { PoolClient } from 'pg';

import type { Queryable } from '../../core/db';
import { HttpError } from '../../core/validate';
import { blockImportShadows, listImportHints, setImportShadowsBlocked, type ImportHint } from '../../connections';
import * as store from '../store/transfers';
import { bankKey } from './bank-key';
import { applyBalanceDeltas, type BalanceDelta } from './transactions';
import { deleteMirror, ensureTransferPayee, insertMirror } from './transfers';
import {
  MAX_TRANSFER_DAYS_APART,
  daysApart,
  evidenceLabel,
  pairViolation,
  planTransfers,
  readView,
  type MatchRow,
  type PairViolation,
  type PendingTransfer,
  type RowSuggestion,
  type Suggestion,
  type TransferPlan,
  type TransferRule,
} from './transfer-matcher';

/** How far a person-picked account is searched for the other leg ("Other account..."). */
const MANUAL_LINK_DAYS = 7;

const todayIso = (): string => new Date().toISOString().slice(0, 10);

interface Context {
  byId: Map<string, store.TransferCandidateSql>;
  hints: Map<string, ImportHint>;
  plan: TransferPlan;
}

function toMatchRow(r: store.TransferCandidateSql, hint: ImportHint | undefined): MatchRow {
  return {
    id: r.id,
    budgetId: r.budget_id,
    accountId: r.account_id,
    accountKind: r.kind,
    checking: r.checking,
    onBudget: r.on_budget,
    amount: Number(r.amount),
    date: r.date,
    bankTime: hint?.bankTime ?? null,
    createdAt: r.created_at,
    categoryId: r.category_id,
    splitCount: Number(r.split_count),
    transferAccountId: r.transfer_account_id,
    transferTransactionId: r.transfer_transaction_id,
    untouched: r.untouched_ledger && !hint?.blocked,
    payeeId: r.payee_id,
    hint: hint ? { category: hint.category, operationType: hint.operationType } : null,
    mark: r.mark,
    bank: bankKey(r.institution),
    connectionId: r.connection_id,
    hintAccountId: r.hint_account_id,
  };
}

const sideOf = (r: store.TransferCandidateSql) => ({ accountKind: r.kind, checking: r.checking, bank: bankKey(r.institution), connectionId: r.connection_id });

async function loadRules(db: Queryable, budgetId: string): Promise<Map<string, TransferRule>> {
  const rules = await store.listTransferRules(db, budgetId);
  return new Map(
    rules.map((r) => [
      r.payee_id,
      { mode: r.mode, accountId: r.account_id, noMatch: r.no_match, waitDays: Number(r.wait_days), since: r.since },
    ]),
  );
}

async function loadContext(db: Queryable, budgetId: string, today: string): Promise<Context> {
  const rows = await store.listTransferCandidates(db, budgetId);
  const hints = await listImportHints(db, rows.map((r) => r.id));
  const rules = await loadRules(db, budgetId);
  const plan = planTransfers(
    rows.map((r) => toMatchRow(r, hints.get(r.id))),
    rules,
    today,
  );
  return { byId: new Map(rows.map((r) => [r.id, r])), hints, plan };
}

interface LegFacts {
  id: string;
  account_id: string;
  account_name: string;
  payee_id: string | null;
  category_id: string | null;
}

/** Link two existing rows as one transfer (see module doc). */
async function linkLegs(
  client: PoolClient,
  budgetId: string,
  out: LegFacts,
  inn: LegFacts,
  method: 'auto' | 'rule' | 'user',
  blocked: (id: string) => boolean | null,
): Promise<void> {
  const outPayee = await ensureTransferPayee(client, budgetId, inn.account_id, inn.account_name);
  const inPayee = await ensureTransferPayee(client, budgetId, out.account_id, out.account_name);
  await store.writeTransferLeg(client, out.id, inn.account_id, inn.id, outPayee);
  await store.writeTransferLeg(client, inn.id, out.account_id, out.id, inPayee);
  for (const [leg, peer] of [
    [out, inn],
    [inn, out],
  ] as const) {
    await store.insertTransferLink(client, budgetId, {
      transaction_id: leg.id,
      peer_transaction_id: peer.id,
      method,
      prev_payee_id: leg.payee_id,
      prev_category_id: leg.category_id,
      prev_blocked: blocked(leg.id),
      created_mirror: false,
    });
  }
  await blockImportShadows(client, [out.id, inn.id]);
  await store.setTransferMarks(client, budgetId, [out.id, inn.id], null);
  await store.clearTransferHints(client, budgetId, [out.id, inn.id]);
}

/**
 * A transfer entered by hand has a hand-made mirror in the other account (no
 * import id, no bank shadow). When the bank later imports the REAL other side
 * (same account, same signed amount, within MAX_TRANSFER_DAYS_APART), keeping
 * both would count the money twice: the imported row replaces the mirror. The
 * hand-made row is soft-deleted (its balance reversed, so the account ends where
 * it would be had only the bank row ever existed), the imported row takes its
 * place in the pair (both pointers on both legs, the peer account's transfer
 * payee, no category, shadow frozen) and gets a link record, so unlinking it
 * later restores it. A leg of the pair with its own link record keeps it,
 * pointed at the new row. Nothing is created: only what already pairs is joined.
 * Closest date first; a row is used once; repeated until nothing more adopts
 * (a pair of two hand-made rows can be replaced by both bank sides in turn).
 * Idempotent: with nothing hand-made left it reads and writes nothing.
 */
async function adoptHandMadeMirrors(client: PoolClient, budgetId: string): Promise<number> {
  let adopted = 0;
  for (let pass = 0; pass < 10; pass++) {
    const used = new Set<string>();
    const deltas: BalanceDelta[] = [];
    let applied = 0;
    for (const pair of await store.listAdoptablePairs(client, budgetId, MAX_TRANSFER_DAYS_APART)) {
      if (used.has(pair.hand_id) || used.has(pair.bank_id) || used.has(pair.peer_id)) continue;
      used.add(pair.hand_id).add(pair.bank_id).add(pair.peer_id);
      const [bank] = await store.getTransferRows(client, budgetId, [pair.bank_id]);
      if (!bank) continue;
      const hints = await listImportHints(client, [bank.id]);
      const peerPayee = await ensureTransferPayee(client, budgetId, pair.peer_account_id);
      await store.writeTransferLeg(client, bank.id, pair.peer_account_id, pair.peer_id, peerPayee);
      await store.repointPeerLeg(client, budgetId, pair.peer_id, bank.account_id, bank.id);
      await store.insertTransferLink(client, budgetId, {
        transaction_id: bank.id,
        peer_transaction_id: pair.peer_id,
        method: 'auto',
        prev_payee_id: bank.payee_id,
        prev_category_id: bank.category_id,
        prev_blocked: hints.get(bank.id)?.blocked ?? null,
        created_mirror: false,
      });
      await store.repointTransferLinkPeer(client, budgetId, pair.peer_id, pair.hand_id, bank.id);
      await store.deleteTransferLinks(client, budgetId, [pair.hand_id]);
      deltas.push(...(await deleteMirror(client, budgetId, pair.hand_id)));
      await blockImportShadows(client, [bank.id]);
      await store.setTransferMarks(client, budgetId, [bank.id], null);
      await store.clearTransferHints(client, budgetId, [bank.id]);
      applied += 1;
    }
    if (deltas.length > 0) await applyBalanceDeltas(client, budgetId, deltas);
    adopted += applied;
    if (applied === 0) break;
  }
  return adopted;
}

/**
 * Link every pair the matcher is sure of (auto-link rules and payee rules) and
 * return how many pairs were linked. Call inside the caller's transaction.
 */
export async function linkTransfers(client: PoolClient, budgetId: string, today: string = todayIso()): Promise<number> {
  // Hand-made mirrors first: a bank row that is the real other side of one joins
  // that pair, so it is not left for the matcher to pair with something else.
  const adopted = await adoptHandMadeMirrors(client, budgetId);
  const { byId, hints, plan } = await loadContext(client, budgetId, today);
  for (const link of plan.links) {
    await linkLegs(client, budgetId, byId.get(link.outflowId)!, byId.get(link.inflowId)!, link.method, (id) => hints.get(id)?.blocked ?? null);
  }
  return plan.links.length + adopted;
}

/** What the register list needs per row: suggestion summary, pending state, who linked it. */
export interface TransferOverview {
  rows: Map<string, RowSuggestion>;
  pending: Map<string, PendingTransfer>;
  methods: Map<string, 'auto' | 'rule' | 'user'>;
}

export async function transferOverview(db: Queryable, budgetId: string, today: string = todayIso()): Promise<TransferOverview> {
  const { plan } = await loadContext(db, budgetId, today);
  const view = readView(plan);
  return { rows: view.rows, pending: view.pending, methods: await store.listTransferLinkMethods(db, budgetId) };
}

/** The review list: each suggestion with its row and candidates (newest first). */
export async function listTransferSuggestions(db: Queryable, budgetId: string, accountId?: string, today: string = todayIso()) {
  const { byId, hints, plan } = await loadContext(db, budgetId, today);
  const leg = (id: string) => {
    const r = byId.get(id)!;
    const hint = hints.get(id);
    return {
      transaction_id: r.id,
      account_id: r.account_id,
      account_name: r.account_name,
      date: r.date,
      amount: Number(r.amount),
      payee_name: r.payee_name,
      bank_label: evidenceLabel(hint ? { category: hint.category, operationType: hint.operationType } : null),
      untouched: r.untouched_ledger && !hint?.blocked,
    };
  };
  const touches = (s: Suggestion) =>
    !accountId || [s.id, ...s.candidateIds].some((id) => byId.get(id)?.account_id === accountId);
  return readView(plan)
    .suggestions.filter(touches)
    .map((s) => ({
      id: s.id,
      confidence: s.confidence,
      basis: s.basis,
      leg: leg(s.id),
      candidates: s.candidateIds.map((c) => ({
        ...leg(c),
        days_apart: daysApart(byId.get(c)!.date, byId.get(s.id)!.date),
        ...(s.violations?.[c] ? { rule: s.violations[c] } : {}),
      })),
    }))
    .sort((a, b) => b.leg.date.localeCompare(a.leg.date) || a.id.localeCompare(b.id));
}

const isLinked = (r: store.TransferCandidateSql) => r.transfer_account_id != null || r.transfer_transaction_id != null;

export interface TransferLinkWarning {
  transaction_id: string;
  counterpart_id: string;
  rule: PairViolation;
}

/**
 * Person-made links (POST /transfers/link). Validates every link before
 * writing (404 / 400 / 409). A counterpart pair that breaks the account rules
 * (transfer-matcher `pairViolation`) is still linked, with a warning.
 */
export async function linkByUser(
  client: PoolClient,
  budgetId: string,
  links: readonly { transaction_id: string; counterpart_id?: string; account_id?: string }[],
  rememberPayee: boolean,
): Promise<{ linked: string[]; rules_created: number; warnings: TransferLinkWarning[] }> {
  for (const l of links) {
    if (Boolean(l.counterpart_id) === Boolean(l.account_id)) {
      throw new HttpError(400, 'give exactly one of counterpart_id or account_id', 'transfer_link_target');
    }
  }
  const ids = [...new Set(links.flatMap((l) => [l.transaction_id, ...(l.counterpart_id ? [l.counterpart_id] : [])]))];
  const rows = new Map((await store.getTransferRows(client, budgetId, ids)).map((r) => [r.id, r]));
  if (rows.size !== ids.length) throw new HttpError(404, 'transaction not found');
  const hints = await listImportHints(client, ids);
  const used = new Set<string>();
  const linked: string[] = [];
  const deltas: BalanceDelta[] = [];
  const rulePayees = new Set<string>();
  const warnings: TransferLinkWarning[] = [];

  const claim = (r: store.TransferCandidateSql) => {
    if (isLinked(r) || used.has(r.id)) throw new HttpError(409, 'transaction is already a transfer', 'transfer_already_linked');
    if (!r.on_budget) throw new HttpError(400, 'only rows of on-budget accounts can be linked here', 'transfer_off_budget');
    used.add(r.id);
  };

  for (const l of links) {
    const row = rows.get(l.transaction_id)!;
    claim(row);
    if (row.payee_id) rulePayees.add(row.payee_id);
    let otherId = l.counterpart_id;
    if (!otherId) {
      const account = await store.getTransferAccount(client, budgetId, l.account_id!);
      if (!account) throw new HttpError(404, 'account not found');
      if (account.id === row.account_id) throw new HttpError(400, 'cannot transfer to the same account', 'cannot_transfer_to_same_account');
      if (account.closed) throw new HttpError(409, 'account is closed', 'account_closed');
      if (!account.on_budget) throw new HttpError(400, 'only rows of on-budget accounts can be linked here', 'transfer_off_budget');
      otherId = await store.findCounterpartInAccount(client, budgetId, account.id, -Number(row.amount), row.date, MANUAL_LINK_DAYS);
      if (otherId && used.has(otherId)) otherId = undefined;
      if (otherId) {
        const [found] = await store.getTransferRows(client, budgetId, [otherId]);
        rows.set(found.id, found);
      } else {
        // No row in that account yet: create the mirrored leg, like a transfer
        // entered by hand.
        const mirror = await insertMirror(
          client,
          budgetId,
          await legForMirror(client, row.id),
          account.id,
        );
        const payee = await ensureTransferPayee(client, budgetId, account.id, account.name);
        await store.writeTransferLeg(client, row.id, account.id, mirror.mirrorId, payee);
        await store.insertTransferLink(client, budgetId, {
          transaction_id: row.id,
          peer_transaction_id: mirror.mirrorId,
          method: 'user',
          prev_payee_id: row.payee_id,
          prev_category_id: row.category_id,
          prev_blocked: hints.get(row.id)?.blocked ?? null,
          created_mirror: false,
        });
        await store.insertTransferLink(client, budgetId, {
          transaction_id: mirror.mirrorId,
          peer_transaction_id: row.id,
          method: 'user',
          prev_payee_id: null,
          prev_category_id: null,
          prev_blocked: null,
          created_mirror: true,
        });
        await blockImportShadows(client, [row.id]);
        await store.setTransferMarks(client, budgetId, [row.id], null);
        await store.clearTransferHints(client, budgetId, [row.id]);
        deltas.push(...mirror.deltas);
        linked.push(row.id, mirror.mirrorId);
        continue;
      }
    }
    const other = rows.get(otherId)!;
    claim(other);
    if (other.account_id === row.account_id) throw new HttpError(400, 'cannot transfer to the same account', 'cannot_transfer_to_same_account');
    if (Number(other.amount) !== -Number(row.amount) || Number(row.amount) === 0) {
      throw new HttpError(400, 'the two rows must have equal and opposite amounts', 'transfer_amount_mismatch');
    }
    const [out, inn] = Number(row.amount) < 0 ? [row, other] : [other, row];
    const violation = pairViolation(sideOf(out), sideOf(inn));
    if (violation) warnings.push({ transaction_id: row.id, counterpart_id: other.id, rule: violation });
    const extraHints = await listImportHints(client, [other.id]);
    await linkLegs(client, budgetId, out, inn, 'user', (id) => (hints.get(id) ?? extraHints.get(id))?.blocked ?? null);
    linked.push(row.id, other.id);
  }

  if (deltas.length > 0) await applyBalanceDeltas(client, budgetId, deltas);
  let rulesCreated = 0;
  if (rememberPayee) {
    for (const payeeId of rulePayees) {
      const rule = await store.getPayeeTransferRule(client, budgetId, payeeId);
      if (!rule || rule.mode) continue;
      await store.setPayeeTransferRule(client, budgetId, payeeId, {
        mode: 'auto',
        accountId: null,
        noMatch: rule.no_match,
        waitDays: Number(rule.wait_days),
        since: 'now',
      });
      rulesCreated += 1;
    }
  }
  return { linked, rules_created: rulesCreated, warnings };
}

async function legForMirror(client: PoolClient, id: string) {
  const r = await client.query(
    'SELECT id, account_id, date::text AS date, memo, amount, cleared, approved FROM transactions WHERE id = $1',
    [id],
  );
  return r.rows[0];
}

/**
 * Undo links (POST /transfers/unlink): restore both legs' previous payee and
 * category, delete legs the link created, unfreeze shadows that were not
 * frozen before, and mark both rows 'manual' so the matcher only suggests
 * them from now on. Returns the number of pairs unlinked.
 */
export async function unlinkTransfers(client: PoolClient, budgetId: string, ids: readonly string[]): Promise<number> {
  const live = await store.liveTransactionIdsInBudget(client, budgetId, ids);
  if (live.size !== new Set(ids).size) throw new HttpError(404, 'transaction not found');
  const links = await store.getTransferLinks(client, budgetId, ids);
  const record = new Map(links.map((l) => [l.transaction_id, l]));
  const pointers = await store.getTransferPointers(client, budgetId, [
    ...new Set(links.flatMap((l) => [l.transaction_id, l.peer_transaction_id])),
  ]);
  const done = new Set<string>();
  const deltas: BalanceDelta[] = [];
  let count = 0;
  for (const id of ids) {
    const rec = record.get(id) ?? links.find((l) => l.peer_transaction_id === id);
    if (!rec || done.has(rec.transaction_id)) continue;
    const a = rec.transaction_id;
    const b = rec.peer_transaction_id;
    done.add(a);
    done.add(b);
    const ra = record.get(a);
    const rb = record.get(b);
    const pa = pointers.get(a);
    const pb = pointers.get(b);
    const stillLinked =
      ra && rb && pa && pb && !pa.deleted && !pb.deleted && pa.transfer_transaction_id === b && pb.transfer_transaction_id === a;
    if (stillLinked) {
      const kept: string[] = [];
      const unblock: string[] = [];
      for (const r of [ra, rb]) {
        if (r.created_mirror) {
          deltas.push(...(await deleteMirror(client, budgetId, r.transaction_id)));
          continue;
        }
        await store.restoreUnlinkedLeg(client, r.transaction_id, { payeeId: r.prev_payee_id, categoryId: r.prev_category_id });
        kept.push(r.transaction_id);
        if (r.prev_blocked === false) unblock.push(r.transaction_id);
      }
      await setImportShadowsBlocked(client, unblock, false);
      await store.setTransferMarks(client, budgetId, kept, 'manual');
      count += 1;
    }
    await store.deleteTransferLinks(client, budgetId, [a, b]);
  }
  if (deltas.length > 0) await applyBalanceDeltas(client, budgetId, deltas);
  return count;
}

/** PUT /transfers/marks: 404 unless every id is a live row of the budget. */
export async function markTransfers(
  client: PoolClient,
  budgetId: string,
  ids: readonly string[],
  state: 'dismissed' | 'outside' | null,
): Promise<number> {
  const unique = [...new Set(ids)];
  const live = await store.liveTransactionIdsInBudget(client, budgetId, unique);
  if (live.size !== unique.length) throw new HttpError(404, 'transaction not found');
  return store.setTransferMarks(client, budgetId, unique, state);
}
