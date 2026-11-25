/**
 * Applying ONE renaming rule to past transactions, on purpose (budget-ou8p). A rule added, changed or removed never moves a
 * stored row by itself (docs/decisions.md, "Rules apply going forward"); this is the one way a rule reaches the past.
 *
 * The rows: bank-imported, live, in open accounts, whose stored bank text this rule WINS (the same matching order an import
 * uses), that nobody has edited, that are not transfers already and not reconciled. The preview and the apply run the very same
 * selection (`planRuleApply`); the apply runs it inside its transaction with the rows locked, so it changes exactly the rows a
 * preview taken at that moment counts.
 */
import type { Queryable } from '../../core/db';
import { HttpError } from '../../core/validate';
import { bankKey } from './bank-key';
import { pairViolation, type TransferSide } from './transfer-matcher';
import { loadRenameRules, matchingRule, planImportedPayee, upsertPayee } from './transactions';
import { findPayeeRowByName } from '../store/transfer-payees';
import * as store from '../store/rename-apply';
import { clearTransferHints, setTransferHint } from '../store/transfers';
import type { LoadedRenameRule } from '../store/rename-rules';

export interface PlannedChange {
  row: store.ApplyRow;
  /** The payee id the row ends up with; null with `createName` set: the payee is created by the apply. */
  payeeId: string | null;
  createName: string | null;
  /** The hint the row ends up with. */
  hintAccountId: string | null;
}

export interface SkippedCounts {
  edited: number;
  transfer: number;
  reconciled: number;
  bank_rules: number;
  /** Synced rows whose real bank text is not known (stored before the text was recorded, and the stored provider object does not say). */
  unknown_text: number;
}

export interface RuleApplyPlan {
  rule: LoadedRenameRule;
  changes: PlannedChange[];
  skipped: SkippedCounts;
}

/** The synced row's shadow still says what the row is: nobody changed date, amount, memo or payee since the last sync. */
function shadowAgrees(row: store.ApplyRow): boolean {
  if (!row.has_shadow) return true;
  if (row.shadow_blocked) return false;
  const s = row.shadow_payload;
  if (!s) return false;
  return s.date === row.date && s.amount === Number(row.amount) && (s.memo ?? '') === (row.memo ?? '') && (s.payee ?? '') === (row.payee_name ?? '');
}

/**
 * Which rows would change, and how. Reads only (the payee a row would get may not exist yet: `createName`). `lock`: lock the
 * candidate rows (the apply).
 */
export async function planRuleApply(db: Queryable, budgetId: string, ruleId: string, lock = false): Promise<RuleApplyPlan> {
  const rules = await loadRenameRules(db, budgetId);
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) throw new HttpError(404, 'rule not found');
  const rows = await store.listApplyRows(db, budgetId, lock);
  const skipped: SkippedCounts = { edited: 0, transfer: 0, reconciled: 0, bank_rules: 0, unknown_text: 0 };
  const changes: PlannedChange[] = [];
  // What the rule makes of one text (read only), once per text.
  const decisions = new Map<string, { name: string | null; existingId: string | null }>();
  let sides: Map<string, TransferSide> | null = null;

  // Counting, in this order and only for rows the rule is the winner for (or, for unknown_text, could not be checked for):
  // reconciled, then transfer, then edited, then unknown_text, then bank_rules. "Edited" is ONE judgement for every row: it is not
  // provably as imported (the matcher's `untouched_ledger`: payee null, or the import text, or what the last sync wrote, or, for a
  // statement row, a payee a rule of that payee assigns for the text; for a synced row also an unblocked shadow that still equals
  // the row; a payee chosen in an import screen is the person's). A statement row whose rule has since been removed no longer
  // proves it, so it counts here: conservative, never the other way.
  for (const row of rows) {
    const text = row.bank_text;
    // The text this row's rule decision is made on is the REAL bank text, never the import name of a synced row.
    if (text !== null && matchingRule(rules, text)?.id !== rule.id) continue;
    if (text !== null && row.cleared === 'reconciled') {
      skipped.reconciled += 1;
      continue;
    }
    if (text !== null && row.transfer) {
      skipped.transfer += 1;
      continue;
    }
    if (row.chosen || !row.untouched_ledger || !shadowAgrees(row)) {
      if (text !== null) skipped.edited += 1;
      continue;
    }
    if (text === null) {
      if (row.cleared !== 'reconciled' && !row.transfer) skipped.unknown_text += 1;
      continue;
    }

    let payeeId: string | null;
    let createName: string | null = null;
    let hint: string | null = row.hint_account_id;
    if (!rule.transfer_account_id) {
      // An ordinary payee: assigned, whole. A hint of an earlier reading of the text no longer applies (as a sync refresh drops it).
      payeeId = rule.payee_id;
      hint = null;
    } else {
      // A rule of an account's transfer payee: as an import does, the row stays an ordinary uncategorized row of the text,
      // with a hint for the matcher. Never a transfer payee, never a mirror.
      let decision = decisions.get(text);
      if (!decision) {
        const plan = await planImportedPayee(db, budgetId, text, rules);
        const name = plan.ordinaryName === null ? null : plan.ordinaryName.trim();
        const found = name ? await findPayeeRowByName(db, budgetId, name) : undefined;
        decision = { name, existingId: found && !found.deleted && found.transfer_account_id === null ? found.id : null };
        decisions.set(text, decision);
      }
      payeeId = decision.name === null ? row.payee_id : decision.existingId;
      createName = decision.name !== null && decision.existingId === null ? decision.name : null;
      const account = rule.transfer_account_id;
      if (account !== row.account_id && !row.category_id) {
        // The matcher's bank rules decide whether this row may ever pair with that account: when they refuse, it is left alone.
        sides ??= await sidesOf(db, budgetId);
        const own = sides.get(row.account_id);
        const other = sides.get(account);
        const violation = own && other ? (row.amount < 0 ? pairViolation(own, other) : pairViolation(other, own)) : null;
        if (violation) {
          skipped.bank_rules += 1;
          continue;
        }
        hint = account;
      }
    }

    const samePayee = createName === null && payeeId === row.payee_id;
    if (samePayee && hint === row.hint_account_id) continue;
    changes.push({ row, payeeId, createName, hintAccountId: hint });
  }
  return { rule, changes, skipped };
}

async function sidesOf(db: Queryable, budgetId: string): Promise<Map<string, TransferSide>> {
  const out = new Map<string, TransferSide>();
  for (const a of await store.listAccountSides(db, budgetId)) out.set(a.id, { accountKind: a.kind, checking: a.checking, bank: bankKey(a.institution), connectionId: a.connection_id });
  return out;
}

export interface AppliedRow {
  transaction_id: string;
  previous_payee_id: string | null;
  payee_id: string | null;
  previous_hint_account_id: string | null;
  hint_account_id: string | null;
}

/** Write a plan, in the caller's transaction, and record it (the record is what revert reads). */
export async function writeRuleApply(db: Queryable, budgetId: string, plan: RuleApplyPlan, userId: string | null): Promise<{ applyId: string; rows: AppliedRow[] }> {
  const created = new Map<string, string | null>();
  const applied: AppliedRow[] = [];
  const payeeWrites: { id: string; payeeId: string | null }[] = [];
  for (const change of plan.changes) {
    let payeeId = change.payeeId;
    if (change.createName !== null) {
      if (!created.has(change.createName)) created.set(change.createName, await upsertPayee(db, budgetId, change.createName));
      payeeId = created.get(change.createName) ?? null;
    }
    if (payeeId !== change.row.payee_id) payeeWrites.push({ id: change.row.id, payeeId });
    applied.push({
      transaction_id: change.row.id,
      previous_payee_id: change.row.payee_id,
      payee_id: payeeId,
      previous_hint_account_id: change.row.hint_account_id,
      hint_account_id: change.hintAccountId,
    });
  }
  await store.setRowPayees(db, budgetId, payeeWrites);
  await writeHints(db, budgetId, applied.map((a) => ({ id: a.transaction_id, hint: a.hint_account_id, previous: a.previous_hint_account_id })));
  const applyId = await store.insertApply(db, budgetId, plan.rule.id, userId);
  await store.insertApplyRows(db, budgetId, applyId, applied);
  return { applyId, rows: applied };
}

async function writeHints(db: Queryable, budgetId: string, rows: { id: string; hint: string | null; previous: string | null }[]): Promise<void> {
  const cleared = rows.filter((r) => r.hint === null && r.previous !== null).map((r) => r.id);
  await clearTransferHints(db, budgetId, cleared);
  for (const r of rows) if (r.hint !== null && r.hint !== r.previous) await setTransferHint(db, budgetId, r.id, r.hint);
}

export interface RevertResult {
  reverted: number;
  skipped: { transaction_id: string; reason: 'changed_since' | 'payee_gone' | 'not_found' }[];
}

/**
 * Put back what ONE recorded apply changed. Only the apply's own record is read (the client sends nothing but the id), and a row
 * is restored only while it is still exactly what the apply left (same payee and hint, a synced row's shadow unblocked and still
 * saying that payee), still live in an open account, not reconciled, linked or a transfer. The payee put back is an ordinary,
 * live one, the hint a live open account: anything else is left alone and reported. A second revert restores nothing.
 */
export async function revertRuleApply(db: Queryable, budgetId: string, applyId: string): Promise<RevertResult> {
  const apply = await store.lockApply(db, budgetId, applyId);
  if (!apply) throw new HttpError(404, 'apply not found');
  const rows = await store.listApplyRecordRows(db, budgetId, applyId);
  const current = new Map((await store.lockRows(db, budgetId, rows.map((r) => r.transaction_id))).map((r) => [r.id, r]));
  const payees = await store.livePayeeIds(db, budgetId, rows.map((r) => r.previous_payee_id).filter((x): x is string => x !== null));
  const accounts = await store.liveAccountIds(db, budgetId, rows.map((r) => r.previous_hint_account_id).filter((x): x is string => x !== null));
  const skipped: RevertResult['skipped'] = [];
  const restore: store.AppliedRowRecord[] = [];
  for (const r of rows) {
    const now = current.get(r.transaction_id);
    if (!now) skipped.push({ transaction_id: r.transaction_id, reason: 'not_found' });
    else if (
      now.frozen ||
      now.payee_id !== r.payee_id ||
      now.hint_account_id !== r.hint_account_id ||
      (now.has_shadow && (now.shadow_blocked || (now.shadow_payee ?? '') !== (now.payee_name ?? '')))
    ) {
      skipped.push({ transaction_id: r.transaction_id, reason: 'changed_since' });
    } else if (r.previous_payee_id !== null && !payees.has(r.previous_payee_id)) skipped.push({ transaction_id: r.transaction_id, reason: 'payee_gone' });
    else restore.push(r);
  }
  await store.setRowPayees(db, budgetId, restore.filter((r) => r.previous_payee_id !== r.payee_id).map((r) => ({ id: r.transaction_id, payeeId: r.previous_payee_id })));
  await writeHints(
    db,
    budgetId,
    restore.map((r) => {
      const own = current.get(r.transaction_id)!.account_id;
      const back = r.previous_hint_account_id !== null && r.previous_hint_account_id !== own && accounts.has(r.previous_hint_account_id) ? r.previous_hint_account_id : null;
      return { id: r.transaction_id, hint: back, previous: r.hint_account_id };
    }),
  );
  await store.markApplyReverted(db, budgetId, applyId);
  return { reverted: restore.length, skipped };
}
