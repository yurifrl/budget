/**
 * Wire row shapes (snake_case) returned by the budget API, derived from the
 * operations' output schemas in `@shared/contracts/budget` (phase 5c, G9):
 * the contract is the single definition; these are its `z.infer` types under
 * the names the app already uses.
 *
 * They mirror the YNAB-v1-compatible schema (migration 0004): amounts are
 * integer MILLIUNITS (1/1000 unit) both ways on the wire, transaction amounts
 * are signed (outflow negative), payees are referenced by `payee_id`,
 * categories carry the YNAB goal model, and months are first-of-month `date`
 * strings. The mapping layer (`mapping.ts`) converts these to the engine's
 * cents/inflow-outflow/payee-name domain; the api layer converts on write.
 *
 * The YNAB-only shapes the API never returned (scheduled transactions, payee
 * locations) were dropped with the hand-written file: nothing used them.
 */
import type { z } from '@shared/zod';
import type {
  accountRowSchema,
  accountTypeSchema,
  assignmentRowSchema,
  budgetListRowSchema,
  budgetRowSchema,
  bundleRowSchema,
  categoryRowSchema,
  currencyFormatSchema,
  dateFormatSchema,
  debtTransactionTypeSchema,
  flagColorSchema,
  goalTypeSchema,
  groupRowSchema,
  monthNoteRowSchema,
  payeeAdminRowSchema,
  payeeRowSchema,
  repeatRuleRowSchema,
  subTransactionRowSchema,
  transactionRowSchema,
} from '@shared/contracts/budget';
import type { ratesUsdBrl } from '@shared/contracts/rates/rates';
import type { OperationOutput } from '@shared/operation-contract';

/** YNAB DateFormat — `{ format: "MM/DD/YYYY" }`. */
export type DateFormat = z.infer<typeof dateFormatSchema>;
/** YNAB CurrencyFormat. */
export type CurrencyFormat = z.infer<typeof currencyFormatSchema>;
export type BudgetRow = z.infer<typeof budgetRowSchema>;
/** GET /budgets row: the budget plus `is_owner`, `owner` and `member_count` (home page, owner-only actions). */
export type BudgetListRow = z.infer<typeof budgetListRowSchema>;
export type GroupRow = z.infer<typeof groupRowSchema>;
/** YNAB goal type. TB=target balance, TBD=target balance by date, MF=monthly funding, NEED=plan your spending, DEBT=debt payoff. */
export type GoalType = z.infer<typeof goalTypeSchema>;
export type CategoryRow = z.infer<typeof categoryRowSchema>;
export type BundleRow = z.infer<typeof bundleRowSchema>;
export type PayeeRow = z.infer<typeof payeeRowSchema>;
/** GET /payees: the base payee plus visibility, categorization mode/default and usage stats. */
export type PayeeAdminRow = z.infer<typeof payeeAdminRowSchema>;
/** YNAB AccountType. */
export type AccountTypeRow = z.infer<typeof accountTypeSchema>;
export type AccountRow = z.infer<typeof accountRowSchema>;
export type FlagColorRow = z.infer<typeof flagColorSchema>;
export type DebtTransactionType = z.infer<typeof debtTransactionTypeSchema>;
export type TransactionRow = z.infer<typeof transactionRowSchema>;
export type SubTransactionRow = z.infer<typeof subTransactionRowSchema>;
export type RepeatRuleRow = z.infer<typeof repeatRuleRowSchema>;
export type AssignmentRow = z.infer<typeof assignmentRowSchema>;
export type MonthNoteRow = z.infer<typeof monthNoteRowSchema>;
/** Indicative USD→BRL exchange rate (GET /rates/usd-brl). */
export type UsdBrlRateRow = OperationOutput<typeof ratesUsdBrl>;
