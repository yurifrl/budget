/**
 * Database row shapes (snake_case) returned by PostgREST.
 *
 * These mirror the YNAB-v1-compatible schema (migration 0004): monetary
 * amounts are MILLIUNITS (1/1000 unit), transaction amounts are signed
 * (outflow negative), payees are referenced by `payee_id`, categories carry
 * the YNAB goal model, and months are first-of-month `date` strings. The
 * mapping layer (`mapping.ts`) converts these to the engine's cents/
 * inflow-outflow/payee-name domain; the api layer converts on write.
 */

import type { LinkedByJson } from './connections';
import type { CategorizationMode, MatchType } from '@shared/domain/payees';
import type { RepeatFrequency } from '../domain/types';

/** YNAB DateFormat — `{ format: "MM/DD/YYYY" }`. */
export interface DateFormat {
  format: string;
}

/** YNAB CurrencyFormat. */
export interface CurrencyFormat {
  iso_code: string;
  example_format: string;
  decimal_digits: number;
  decimal_separator: string;
  symbol_first: boolean;
  group_separator: string;
  currency_symbol: string;
  display_symbol: boolean;
}

export interface BudgetRow {
  id: string;
  name: string;
  /** Null for active budgets; the archive moment for archived ones. */
  archived_at?: string | null;
  /** Selected only by detail reads; the switcher query omits these. */
  date_format?: DateFormat | null;
  currency_format?: CurrencyFormat | null;
  last_modified_on?: string;
}

export interface GroupRow {
  id: string;
  name: string;
  sort_order: number;
  is_credit_card_payments: boolean;
  hidden: boolean;
  internal: boolean;
  deleted: boolean;
}

/** YNAB goal type. TB=target balance, TBD=target balance by date, MF=monthly funding, NEED=plan your spending, DEBT=debt payoff. */
export type GoalType = 'TB' | 'TBD' | 'MF' | 'NEED' | 'DEBT';

export interface CategoryRow {
  id: string;
  group_id: string;
  name: string;
  sort_order: number;
  note: string | null;
  hidden: boolean;
  internal: boolean;
  deleted: boolean;
  // YNAB goal model (null goal_type => no goal)
  goal_type: GoalType | null;
  goal_needs_whole_amount: boolean | null;
  goal_day: number | null;
  goal_cadence: number | null;
  goal_cadence_frequency: number | null;
  goal_creation_month: string | null;
  /** Milliunits. */
  goal_target: number | null;
  goal_target_date: string | null;
  goal_snoozed_at: string | null;
  /** Owning budget member; null = Shared. */
  user_id: string | null;
  /** Bundle the category belongs to (same group); null = not bundled. */
  bundle_id?: string | null;
}

export interface BundleRow {
  id: string;
  group_id: string;
  name: string;
}

export interface PayeeRow {
  id: string;
  name: string;
  transfer_account_id: string | null;
  deleted: boolean;
}

/**
 * Row returned by GET /payees (syscd-app-7pa): the base payee plus the
 * management fields — visibility flag, categorization mode/default, and
 * live transaction-usage stats.
 */
export interface PayeeAdminRow {
  id: string;
  name: string;
  transfer_account_id: string | null;
  deleted: boolean;
  hidden: boolean;
  categorization_mode: CategorizationMode;
  default_category_id: string | null;
  /** The payee's own renaming rule: statement text matching this resolves to the payee. */
  rename_match_type: MatchType | null;
  rename_condition: string | null;
  transaction_count: number;
  last_used_date: string | null;
  /** Majority category of the payee's last 3 categorized transactions; null when none (syscd-app-7pa). */
  inferred_category_id: string | null;
  inferred_category_name: string | null;
}

/** YNAB AccountType. */
export type AccountTypeRow =
  | 'checking'
  | 'savings'
  | 'cash'
  | 'creditCard'
  | 'lineOfCredit'
  | 'otherAsset'
  | 'otherLiability'
  | 'mortgage'
  | 'autoLoan'
  | 'studentLoan'
  | 'personalLoan'
  | 'medicalDebt'
  | 'otherDebt';

export interface AccountRow {
  id: string;
  name: string;
  type: AccountTypeRow;
  account_group: 'CASH' | 'CREDIT' | 'CLOSED';
  on_budget: boolean;
  closed: boolean;
  note: string | null;
  /** Milliunits. */
  cleared_balance: number;
  /** Milliunits. */
  uncleared_balance: number;
  transfer_payee_id: string | null;
  direct_import_linked: boolean;
  direct_import_in_error: boolean;
  /** Bank link (nullable — the link is a property of the account row). */
  connection_id: string | null;
  external_account_id: string | null;
  institution: string | null;
  /** Who linked the bank behind `connection_id` (null when unlinked). */
  linked_by?: LinkedByJson | null;
  /** Person (budget member) the account belongs to; null = Shared. */
  user_id: string | null;
  last_reconciled_at: string | null;
  debt_interest_rates: Record<string, number> | null;
  debt_minimum_payments: Record<string, number> | null;
  debt_escrow_amounts: Record<string, number> | null;
  sort_order: number;
  deleted: boolean;
}

export type FlagColorRow = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | '';

export type DebtTransactionType =
  | 'payment'
  | 'refund'
  | 'fee'
  | 'interest'
  | 'escrow'
  | 'balanceAdjustment'
  | 'credit'
  | 'charge';

export interface TransactionRow {
  id: string;
  account_id: string;
  date: string;
  /** Signed milliunits (outflow negative, inflow positive). */
  amount: number;
  payee_id: string | null;
  /** Name of `payee_id` straight from GET /transactions — includes transfer payees, which GET /payees omits. */
  payee_name?: string | null;
  category_id: string | null;
  memo: string | null;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  approved: boolean;
  flag_color: FlagColorRow | null;
  flag_name: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  matched_transaction_id: string | null;
  import_id: string | null;
  import_payee_name: string | null;
  import_payee_name_original: string | null;
  debt_transaction_type: DebtTransactionType | null;
  /** App-side recurrence extra (not a YNAB Transaction field). */
  repeat: string;
  /** Rule this row belongs to (materialized occurrence or attached anchor). */
  repeat_rule_id: string | null;
  /** The occurrence's effective date (may differ from `date` for month-last-day rules). */
  occurrence_date: string | null;
  /** Split legs (syscd-app-rlt); empty when the transaction is not split. */
  subtransactions?: SubTransactionRow[];
  /** Materialized future occurrence of a repeat rule (syscd-app-pya). */
  upcoming: boolean;
  deleted: boolean;
}

export interface RepeatRuleRow {
  id: string;
  account_id: string;
  payee_id: string | null;
  category_id: string | null;
  memo: string | null;
  /** Signed milliunits (outflow negative). */
  amount: number;
  frequency: RepeatFrequency;
  next_due_date: string;
  month_last_day: boolean;
  deleted: boolean;
}

/** Indicative USD→BRL exchange rate from the /rates/usd-brl endpoint. */
export interface UsdBrlRateRow {
  rate: number;
  source: string;
  as_of: string;
}

export interface SubTransactionRow {
  id: string;
  transaction_id: string;
  amount: number;
  memo: string | null;
  payee_id: string | null;
  category_id: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  deleted: boolean;
}

export type ScheduledFrequency =
  | 'never'
  | 'daily'
  | 'weekly'
  | 'everyOtherWeek'
  | 'twiceAMonth'
  | 'every4Weeks'
  | 'monthly'
  | 'everyOtherMonth'
  | 'every3Months'
  | 'every4Months'
  | 'twiceAYear'
  | 'yearly'
  | 'everyOtherYear';

export interface ScheduledTransactionRow {
  id: string;
  account_id: string;
  date_first: string;
  date_next: string;
  frequency: ScheduledFrequency;
  amount: number;
  memo: string | null;
  flag_color: FlagColorRow | null;
  flag_name: string | null;
  payee_id: string | null;
  category_id: string | null;
  transfer_account_id: string | null;
  deleted: boolean;
}

export interface PayeeLocationRow {
  id: string;
  payee_id: string;
  latitude: string;
  longitude: string;
  deleted: boolean;
}

export interface AssignmentRow {
  /** First-of-month date, e.g. "2026-06-01". */
  month: string;
  category_id: string;
  /** Milliunits. */
  budgeted: number;
}

export interface MonthNoteRow {
  /** First-of-month date, e.g. "2026-06-01". */
  month: string;
  note: string;
}
