/**
 * Repair of a budget's transfer payees: exactly one per account, linked both
 * ways, named after the account, with nothing left on duplicates.
 *
 * What it finds, per live account of one budget:
 *  - zero transfer payees (the account never got one, or it was retired):
 *    adopts a name-only "Transfer : <account>" payee when the account's name is
 *    unambiguous, else creates one;
 *  - several transfer payees (an account rename left the old name behind and
 *    the new name was picked later, R3): keeps one (the account's own pointer,
 *    else the oldest live), moves every transaction, split, scheduled row,
 *    repeat rule and link record of the others onto it, moves their renaming /
 *    "treat as transfer" rules when the kept one has none (a payee holds one
 *    renaming rule: a different second one is dropped and counted), and
 *    deletes the others;
 *  - name-only "Transfer : <account>" payees (no link, as old imports, restores
 *    and the other app write them): folded into the account's payee when its
 *    name is unambiguous; left alone and counted when two accounts share it;
 *  - a payee whose name is not the account's current name, or a pointer that
 *    disagrees with the payee: renamed / re-pointed.
 *
 * This is the ONLY place that merges or deletes payees; ordinary requests
 * (account rename, transfers, imports) never do.
 *
 * `planTransferPayeeRepair` is pure and is the single source of the report;
 * `repairTransferPayees` with `apply: false` only reads (use it in a READ ONLY
 * transaction); with `apply: true` it runs the plan through the same
 * primitives the account lifecycle uses, and a second run reports nothing to
 * do. Run it inside one database transaction.
 */
import type { Queryable } from '../../core/db';
import { TRANSFER_PAYEE_RE, transferPayeeName } from '@shared/domain/transfers';
import * as store from '../store/transfer-payees';
import type { AccountPayeeRow, PayeeFullRow } from '../store/transfer-payees';
import { repairHalfLinkedTransfers, type HalfLinkedReport } from './transfer-link-repair';
import { absorbPayee, createTransferPayee, isTransferPayeeNameFor, pickCanonical, renameTransferPayee } from './transfer-payees';

export interface DroppedRule {
  kind: 'rename_rule' | 'transfer_rule';
  account_id: string;
  /** The payee being folded away and what its rule said. */
  payee_id: string;
  payee_name: string;
  detail: string;
  /** The payee that keeps its own, different rule. */
  kept_payee_id: string;
}

export interface KeptPayee {
  payee_id: string;
  payee_name: string;
  account_id: string;
  /** `will_unlink`: folded into the account's payee but not deleted; `unlinked`: already unlinked by an earlier run. */
  state: 'will_unlink' | 'unlinked';
  reason: 'referenced from another budget';
}

export interface AccountRepairAction {
  account_id: string;
  account_name: string;
  /** The payee kept; null = none exists, one is created. */
  canonical_payee_id: string | null;
  /** The kept payee is a name-only payee that gets linked to the account. */
  adopt: boolean;
  /** Payees folded into the kept one and deleted (or unlinked and kept, see `kept_payees`). */
  extra_payee_ids: string[];
  rename: boolean;
  fix_pointer: boolean;
  /** The kept payee is retired or hidden and gets revived. */
  revive: boolean;
}

export interface TransferPayeeRepairReport {
  budget_id: string;
  applied: boolean;
  accounts_checked: number;
  /** Accounts with no transfer payee at all: one is created or adopted. */
  accounts_without_payee: number;
  /** Accounts with several transfer payees. */
  accounts_with_duplicates: number;
  /** Unlinked "Transfer : <account>" payees folded into / adopted by their account's payee. */
  name_only_payees: number;
  /** Unlinked payees named after a name two or more accounts share: left alone. */
  ambiguous_name_only_payees: number;
  /** Live payees linked to an account that is gone and matching no live account: left alone. */
  orphan_transfer_payees: number;
  payees_renamed: number;
  pointers_fixed: number;
  payees_removed: number;
  transactions_repointed: number;
  rename_rules_moved: number;
  rename_rules_dropped: number;
  /** Every rule that cannot move to the kept payee and is lost (a payee holds one "treat as transfer" rule). */
  dropped_rules: DroppedRule[];
  /**
   * Payees the repair does not delete because rows of ANOTHER budget reference
   * them (a delete would null those rows' payee): kept unlinked. See
   * docs/runbooks/transfer-payee-cross-budget.md.
   */
  kept_payees: KeptPayee[];
  actions: AccountRepairAction[];
  /**
   * Half-linked transfer rows (repeat rules, restores, budget copies, payee-only
   * imports): completed or paired by `apply`; `needs_mirror` and `ambiguous` rows
   * are only listed (see transfer-link-repair.ts).
   */
  half_linked: HalfLinkedReport;
}

export interface RepairInput {
  budgetId: string;
  accounts: readonly AccountPayeeRow[];
  payees: readonly PayeeFullRow[];
  /** Transactions per payee id. */
  transactionCounts: ReadonlyMap<string, number>;
  /** Payee ids that rows of another budget reference. */
  foreignReferenced?: ReadonlySet<string>;
}

const peerNameOf = (name: string): string | undefined => TRANSFER_PAYEE_RE.exec(name)?.[1]?.trim();

/** The repair plan and its counts, from loaded rows; no I/O. */
export function planTransferPayeeRepair(input: RepairInput): TransferPayeeRepairReport {
  const { accounts, payees } = input;
  const liveIds = new Set(accounts.map((a) => a.id));
  const accountsByName = new Map<string, AccountPayeeRow[]>();
  for (const a of accounts) accountsByName.set(a.name, [...(accountsByName.get(a.name) ?? []), a]);
  const linkedTo = (p: PayeeFullRow): string | null =>
    p.transfer_account_id !== null && liveIds.has(p.transfer_account_id) ? p.transfer_account_id : null;

  // Unlinked live payees that read "Transfer : <name>" with one live account of that name.
  const nameOnlyByAccount = new Map<string, PayeeFullRow[]>();
  let ambiguous = 0;
  let orphans = 0;
  for (const p of payees) {
    if (p.deleted || linkedTo(p) !== null) continue;
    const peer = peerNameOf(p.name);
    const matches = peer === undefined ? [] : (accountsByName.get(peer) ?? []);
    if (matches.length === 1) {
      const id = matches[0]!.id;
      nameOnlyByAccount.set(id, [...(nameOnlyByAccount.get(id) ?? []), p]);
    } else if (matches.length > 1 && p.transfer_account_id === null) {
      ambiguous++;
    } else if (p.transfer_account_id !== null) {
      orphans++;
    }
  }

  const report: TransferPayeeRepairReport = {
    budget_id: input.budgetId,
    applied: false,
    accounts_checked: accounts.length,
    accounts_without_payee: 0,
    accounts_with_duplicates: 0,
    name_only_payees: 0,
    ambiguous_name_only_payees: ambiguous,
    orphan_transfer_payees: orphans,
    payees_renamed: 0,
    pointers_fixed: 0,
    payees_removed: 0,
    transactions_repointed: 0,
    rename_rules_moved: 0,
    rename_rules_dropped: 0,
    dropped_rules: [],
    kept_payees: [],
    actions: [],
    half_linked: { items: [], complete_pointers: 0, set_payee: 0, clear_category: 0, paired: 0, needs_mirror: 0, ambiguous: 0, mirrors_created: 0 },
  };

  for (const account of accounts) {
    const linked = payees.filter((p) => linkedTo(p) === account.id);
    const nameOnly = nameOnlyByAccount.get(account.id) ?? [];
    let canonical = pickCanonical(account.transfer_payee_id, linked);
    let adopt = false;
    if ((!canonical || canonical.deleted) && nameOnly.length > 0) {
      canonical = nameOnly[0];
      adopt = true;
    }
    const foreign = input.foreignReferenced ?? new Set<string>();
    // An unlinked payee another budget references is never folded or deleted: it only stays listed.
    for (const p of nameOnly) {
      if (p.id !== canonical?.id && foreign.has(p.id)) {
        report.kept_payees.push({ payee_id: p.id, payee_name: p.name, account_id: account.id, state: 'unlinked', reason: 'referenced from another budget' });
      }
    }
    const extras = [...linked, ...nameOnly].filter((p) => p.id !== canonical?.id && !(foreign.has(p.id) && p.transfer_account_id === null));
    const create = canonical === undefined;
    const extraIds = new Set(extras.map((e) => e.id));
    // A numbered name ("Transfer : X (2)") is right while another payee that stays holds "Transfer : X".
    const baseName = transferPayeeName(account.name);
    const baseHolder = payees.find((p) => p.name === baseName && p.id !== canonical?.id && !extraIds.has(p.id));
    const rename =
      canonical !== undefined &&
      canonical.name !== baseName &&
      !(isTransferPayeeNameFor(canonical.name, account.name) && baseHolder !== undefined);
    const fixPointer = canonical !== undefined && account.transfer_payee_id !== canonical.id;
    const revive = canonical !== undefined && (canonical.deleted || canonical.hidden);
    if (!create && !adopt && !rename && !fixPointer && !revive && extras.length === 0) continue;

    if (linked.length === 0) report.accounts_without_payee++;
    if (linked.length > 1) report.accounts_with_duplicates++;
    report.name_only_payees += nameOnly.length;
    if (rename) report.payees_renamed++;
    if (fixPointer) report.pointers_fixed++;
    for (const e of extras) {
      if (foreign.has(e.id)) {
        report.kept_payees.push({ payee_id: e.id, payee_name: e.name, account_id: account.id, state: 'will_unlink', reason: 'referenced from another budget' });
      }
    }
    report.payees_removed += extras.filter((e) => !foreign.has(e.id)).length;
    let heldTransferRule = canonical?.transfer_rule ?? null;
    const keptId = canonical?.id ?? '';
    for (const extra of extras) {
      report.transactions_repointed += input.transactionCounts.get(extra.id) ?? 0;
      // Renaming rules all move to the kept payee (one rule belongs to one payee per budget: none collide).
      report.rename_rules_moved += extra.rename_rule_count;
      if (extra.transfer_rule !== null) {
        if (heldTransferRule === null) heldTransferRule = extra.transfer_rule;
        else if (heldTransferRule !== extra.transfer_rule) {
          report.dropped_rules.push({
            kind: 'transfer_rule',
            account_id: account.id,
            payee_id: extra.id,
            payee_name: extra.name,
            detail: extra.transfer_rule,
            kept_payee_id: keptId,
          });
        }
      }
    }
    report.actions.push({
      account_id: account.id,
      account_name: account.name,
      canonical_payee_id: canonical?.id ?? null,
      adopt,
      extra_payee_ids: extras.map((e) => e.id),
      rename,
      fix_pointer: fixPointer,
      revive,
    });
  }
  return report;
}

async function loadInput(db: Queryable, budgetId: string): Promise<RepairInput> {
  const [accounts, payees] = await Promise.all([store.listLiveAccounts(db, budgetId), store.listBudgetPayees(db, budgetId)]);
  const candidates = payees.filter((p) => p.transfer_account_id !== null || TRANSFER_PAYEE_RE.test(p.name)).map((p) => p.id);
  return {
    budgetId,
    accounts,
    payees,
    transactionCounts: await store.countTransactionsByPayee(db, candidates),
    foreignReferenced: await store.payeesReferencedFromOtherBudgets(db, budgetId, candidates),
  };
}

/**
 * Report (`apply: false`, reads only) or perform (`apply: true`) the repair of
 * one budget. The report of an apply is the plan it executed; run again it is
 * empty.
 */
export async function repairTransferPayees(
  db: Queryable,
  budgetId: string,
  opts: { apply: boolean; /** Also create the missing other side of one-sided transfer legs (moves the peer account's balance). */ createMirrors?: boolean },
): Promise<TransferPayeeRepairReport> {
  const report = planTransferPayeeRepair(await loadInput(db, budgetId));
  if (!opts.apply) return { ...report, half_linked: await repairHalfLinkedTransfers(db, budgetId, { apply: false }) };
  for (const action of report.actions) {
    if (action.canonical_payee_id === null) {
      const account = (await store.getAccountRow(db, action.account_id))!;
      await createTransferPayee(db, account);
    } else {
      await store.linkPayeeToAccount(db, action.canonical_payee_id, action.account_id);
      await store.setAccountTransferPayee(db, action.account_id, action.canonical_payee_id);
      for (const extraId of action.extra_payee_ids) {
        await absorbPayee(db, budgetId, extraId, action.canonical_payee_id);
      }
    }
    // Names last: the folded payees may have held the account's current name.
    if (action.rename) await renameTransferPayee(db, budgetId, action.account_id);
  }
  // After the payees are right: rows that are only part of a transfer.
  const half_linked = await repairHalfLinkedTransfers(db, budgetId, { apply: true, createMirrors: opts.createMirrors });
  return { ...report, applied: true, half_linked };
}
