/**
 * Mapping layer — assembles YNAB-shaped PostgREST rows (milliunits, signed
 * amounts, payee_id references, goal model, first-of-month date months) into
 * the engine's unchanged `Budget` aggregate (cents, inflow/outflow, payee
 * names, simplified Target). Pure and synchronous so it is trivially
 * unit-testable; the `useBudgetModel` hook feeds it RTK Query results.
 *
 * Activity is DERIVED from transactions via the engine — never read from rows.
 */

import { recomputeActivity } from '../domain/engine';
import { transferPeerAccountId } from '@shared/domain/transfers';
import type {
  Account,
  AccountType,
  Budget,
  Bundle,
  Category,
  CategoryGroup,
  Cents,
  FlagColor,
  MonthKey,
  RepeatCadence,
  CategoryTarget,
  Transaction,
} from '../domain/types';
import type { ImportRow } from '../import/types';
import type {
  AccountRow,
  AssignmentRow,
  BudgetRow,
  BundleRow,
  CategoryRow,
  GroupRow,
  MonthNoteRow,
  PayeeRow,
  TransactionRow,
} from './rows';

// ---------------------------------------------------------------------------
// money / month conversions (the wire boundary: API milliunits ↔ domain cents)
//
// Every amount on the wire, both directions, is integer MILLIUNITS (shared
// `MONEY_UNIT_RULE`). The engine keeps cents in memory; this layer converts
// once, on the way in (milliToCents) and on the way out (centsToMilli).
// ---------------------------------------------------------------------------

/** Domain cents -> wire/storage milliunits. */
export const centsToMilli = (c: Cents): number => c * 10;

/** Storage milliunits -> domain cents (app rounds for display; storage keeps full precision). */
export const milliToCents = (m: number): Cents => Math.round(m / 10);

/** "2026-06-13" -> 202606 (also handles first-of-month dates). */
export function monthKeyFromDate(date: string): MonthKey {
  const [y, m] = date.split('-');
  return Number(y) * 100 + Number(m);
}

/** 202606 -> "2026-06-01" (first-of-month, YNAB month representation). */
export function monthKeyToDate(month: MonthKey): string {
  const y = Math.floor(month / 100);
  const m = month % 100;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

// ---------------------------------------------------------------------------
// account type (YNAB 13-value set <-> the engine's 5-value union)
// ---------------------------------------------------------------------------

const CASH_TYPES = new Set<string>(['checking', 'savings', 'cash']);

/** Map a YNAB account type to the engine's domain `AccountType`. */
export function mapAccountType(row: AccountRow): AccountType {
  if (row.type === 'creditCard' || row.type === 'lineOfCredit') return 'credit';
  if (CASH_TYPES.has(row.type)) return row.type as AccountType;
  // every other YNAB type (otherAsset/loans/debt/etc.) presents as a tracking account
  return 'tracking';
}

// ---------------------------------------------------------------------------
// goal model (YNAB goal_* columns <-> the unified CategoryTarget)
// ---------------------------------------------------------------------------

/**
 * Map a category row's YNAB goal to the unified `CategoryTarget` (cents, the
 * `category_targets` model): weekly NEED (cadence 2) -> weekly, yearly NEED
 * (cadence 13) -> yearly, other NEED/monthly -> monthly, everything else
 * (TBD/yearly/TB/...) -> custom by-date. No goal -> undefined.
 */
export function mapCategoryTarget(row: CategoryRow): CategoryTarget | undefined {
  if (row.goal_type == null || row.goal_target == null) return undefined;
  const amountCents = milliToCents(row.goal_target);
  const isNeedLike = row.goal_type === 'NEED' || row.goal_type === 'MF';
  if (isNeedLike && row.goal_cadence === 2) {
    return { categoryId: row.id, kind: 'weekly', amountCents, config: {} };
  }
  if (isNeedLike && row.goal_cadence === 13) {
    return { categoryId: row.id, kind: 'yearly', amountCents, config: {} };
  }
  if (isNeedLike) {
    return { categoryId: row.id, kind: 'monthly', amountCents, config: {} };
  }
  return {
    categoryId: row.id,
    kind: 'custom',
    amountCents,
    config: { byDate: row.goal_target_date ?? '' },
  };
}

export interface BudgetSource {
  budget: BudgetRow;
  groups: GroupRow[];
  categories: CategoryRow[];
  /** Optional: sources without bundles (older fixtures) map to []. */
  bundles?: BundleRow[];
  accounts: AccountRow[];
  payees: PayeeRow[];
  transactions: TransactionRow[];
  assignments: AssignmentRow[];
  monthNotes: MonthNoteRow[];
  currentMonth: MonthKey;
}

/** Assemble the engine `Budget` aggregate from one budget's rows. */
export function assembleBudget(src: BudgetSource): Budget {
  const payeeName = new Map(src.payees.map((p) => [p.id, p.name]));

  const assignedByCat = new Map<string, Record<MonthKey, Cents>>();
  for (const a of src.assignments) {
    const m = assignedByCat.get(a.category_id) ?? {};
    m[monthKeyFromDate(a.month)] = milliToCents(a.budgeted);
    assignedByCat.set(a.category_id, m);
  }

  const categories: Category[] = src.categories.map((c) => ({
    id: c.id,
    groupId: c.group_id,
    name: c.name,
    assigned: { ...(assignedByCat.get(c.id) ?? {}) },
    activity: {},
    target: mapCategoryTarget(c),
    notes: c.note ?? '',
    hidden: c.hidden || undefined,
    userId: c.user_id ?? null,
    bundleId: c.bundle_id ?? undefined,
  }));

  const bundles: Bundle[] = (src.bundles ?? []).map((b) => ({ id: b.id, groupId: b.group_id, name: b.name }));

  const groups: CategoryGroup[] = src.groups.map((g) => ({
    id: g.id,
    name: g.name,
    isCreditCardPayments: g.is_credit_card_payments || undefined,
    categoryIds: src.categories.filter((c) => c.group_id === g.id).map((c) => c.id),
  }));

  const accounts: Account[] = src.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    type: mapAccountType(a),
    group: a.account_group,
    onBudget: a.on_budget,
    clearedBalance: milliToCents(a.cleared_balance),
    unclearedBalance: milliToCents(a.uncleared_balance),
    lastReconciledAt: a.last_reconciled_at,
    userId: a.user_id,
  }));

  const transactions: Transaction[] = src.transactions.map((t) => {
    const cents = milliToCents(t.amount);
    const payee = t.payee_name ?? (t.payee_id ? payeeName.get(t.payee_id) : undefined) ?? t.import_payee_name ?? '';
    return {
      id: t.id,
      accountId: t.account_id,
      // The API serializes the DATE column through a JS Date ("2026-06-13T03:00:00.000Z");
      // the domain contract is YYYY-MM-DD (see Transaction.date in domain/types).
      date: t.date.slice(0, 10),
      payee,
      categoryId: t.category_id,
      memo: t.memo ?? '',
      outflow: cents < 0 ? -cents : 0,
      inflow: cents > 0 ? cents : 0,
      cleared: t.cleared,
      approved: t.approved,
      flag: (t.flag_color || undefined) as FlagColor | undefined,
      repeat: t.repeat as RepeatCadence,
      repeatRuleId: t.repeat_rule_id ?? null,
      upcoming: t.upcoming,
      importId: t.import_id ?? null,
      matchedTransactionId: t.matched_transaction_id ?? null,
      transferAccountId: t.transfer_account_id ?? transferPeerAccountId(payee, src.accounts, t.account_id) ?? null,
      // Only real splits: the engine treats an empty `splits` array as a split
      // with no legs (the transaction would vanish from every figure).
      splits: t.subtransactions?.length
        ? t.subtransactions.map((s) => {
            const splitCents = milliToCents(s.amount);
            return {
              id: s.id,
              categoryId: s.category_id,
              memo: s.memo ?? '',
              outflow: splitCents < 0 ? -splitCents : 0,
              inflow: splitCents > 0 ? splitCents : 0,
            };
          })
        : undefined,
    };
  });

  const monthNotes: Record<MonthKey, string> = {};
  for (const n of src.monthNotes) monthNotes[monthKeyFromDate(n.month)] = n.note;

  // months = distinct months across assignments + transactions + the focused month
  const monthSet = new Set<MonthKey>();
  for (const a of src.assignments) monthSet.add(monthKeyFromDate(a.month));
  for (const t of src.transactions) monthSet.add(monthKeyFromDate(t.date));
  monthSet.add(src.currentMonth);
  const months = [...monthSet].sort((x, y) => x - y);

  const budget: Budget = {
    id: src.budget.id,
    name: src.budget.name,
    currentMonth: src.currentMonth,
    months,
    groups,
    categories,
    bundles,
    accounts,
    transactions,
    monthNotes,
  };

  // derive activity from transactions via the engine — never read from rows
  const activity = recomputeActivity(budget);
  for (const cat of budget.categories) {
    cat.activity = { ...(activity[cat.id] ?? {}) };
  }
  return budget;
}

// ---------------------------------------------------------------------------
// write mapping: app input -> server wire format
// ---------------------------------------------------------------------------

/** App-facing transaction input (cents, inflow/outflow, payee name); converted to YNAB columns on write. */
export interface TransactionInput {
  accountId: string;
  date: string;
  /** Payee name; upserted to a payee_id on save. Empty => no payee. */
  payee: string;
  categoryId: string | null;
  memo: string;
  outflowCents: Cents;
  inflowCents: Cents;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  approved: boolean;
  flag: string | null;
  repeat: string;
  /** Match link (syscd-app-42f): PATCH-only, never set on create. */
  matchedTransactionId?: string | null;
}

/** App-facing split leg input (syscd-app-rlt); converted to subtransactions wire on write. */
export interface SubTxnInput {
  categoryId: string | null;
  memo: string;
  outflowCents: Cents;
  inflowCents: Cents;
}

/** Map a split leg to the server's subTxnSchema (snake_case, one-way milliunits). */
export function snakeSubTxn(input: SubTxnInput): Record<string, unknown> {
  return {
    category_id: input.categoryId,
    memo: input.memo || null,
    outflow: centsToMilli(input.outflowCents),
    inflow: centsToMilli(input.inflowCents),
  };
}

/** Map a full transaction to the POST body the server expects (server/routes/transactions.ts `TransactionInput`). */
export function snakeTxn(input: TransactionInput): Record<string, unknown> {
  return {
    account_id: input.accountId,
    date: input.date,
    payee: input.payee ?? '',
    category_id: input.categoryId,
    memo: input.memo || null,
    outflow: centsToMilli(input.outflowCents ?? 0),
    inflow: centsToMilli(input.inflowCents ?? 0),
    cleared: input.cleared,
    approved: input.approved,
    flag: input.flag ?? null,
    repeat: input.repeat,
  };
}

/**
 * Wire row for POST /transactions/bulk — mirrors the server's `bulkTxnSchema`
 * (snake_case, one-way amounts in milliunits, optional deterministic dedupe id).
 */
export interface ImportTxnWire {
  date: string;
  payee: string;
  category_id: string | null;
  memo: string;
  outflow: number;
  inflow: number;
  import_id?: string;
  /** Statement payee as sent (after association/rename rules). */
  import_payee_name?: string;
  /** Unmodified statement text, for re-matching in the review flow. */
  import_payee_name_original?: string;
}

/**
 * Map a parsed statement row to the bulk wire shape; Nubank rows carry an
 * exact import_id. `resolvedPayee` overrides the statement text with an
 * associated budget payee's name; `originalPayee` (statement text at parse
 * time) populates the review columns the server stores.
 */
export function snakeImportRow(
  row: ImportRow & { importId?: string | null; resolvedPayee?: string; originalPayee?: string },
): ImportTxnWire {
  const payee = row.resolvedPayee ?? row.payee;
  const wire: ImportTxnWire = {
    date: row.date,
    payee,
    category_id: null,
    memo: row.memo || '',
    outflow: centsToMilli(row.outflowCents),
    inflow: centsToMilli(row.inflowCents),
  };
  if (row.importId) wire.import_id = row.importId;
  if (row.originalPayee) {
    wire.import_payee_name = payee;
    wire.import_payee_name_original = row.originalPayee;
  }
  return wire;
}

/**
 * PATCH mapper: sends only explicitly defined keys.
 *
 * The server's PATCH handler treats every present key as explicit intent
 * (payee '' clears payee_id, outflow 0 zeroes the amount). Routing a
 * partial patch through {@link snakeTxn} would substitute those defaults and
 * silently wipe untouched fields on every single-field edit.
 */
export function snakeTxnPatch(patch: Partial<TransactionInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.accountId !== undefined) out.account_id = patch.accountId;
  if (patch.date !== undefined) out.date = patch.date;
  if (patch.payee !== undefined) out.payee = patch.payee;
  if (patch.categoryId !== undefined) out.category_id = patch.categoryId;
  if (patch.memo !== undefined) out.memo = patch.memo;
  if (patch.outflowCents !== undefined) out.outflow = centsToMilli(patch.outflowCents);
  if (patch.inflowCents !== undefined) out.inflow = centsToMilli(patch.inflowCents);
  if (patch.cleared !== undefined) out.cleared = patch.cleared;
  if (patch.approved !== undefined) out.approved = patch.approved;
  if (patch.flag !== undefined) out.flag = patch.flag;
  if (patch.repeat !== undefined) out.repeat = patch.repeat;
  if (patch.matchedTransactionId !== undefined) out.matched_transaction_id = patch.matchedTransactionId;
  return out;
}

/**
 * Backup restore (phase 5d): the transfer payload is built in domain cents
 * (`transfer/payload.ts`); the wire document is format 2, milliunits.
 */
export interface CentsRestorePayload {
  transactions: readonly { outflow: Cents; inflow: Cents }[];
  assignments: readonly { budgeted: Cents }[];
}

export function restorePayloadToWire<P extends CentsRestorePayload>(payload: P) {
  return {
    ...payload,
    format_version: 2 as const,
    transactions: payload.transactions.map((t) => ({ ...t, outflow: centsToMilli(t.outflow), inflow: centsToMilli(t.inflow) })),
    assignments: payload.assignments.map((a) => ({ ...a, budgeted: centsToMilli(a.budgeted) })),
  };
}
