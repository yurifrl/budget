/**
 * Output (response) schemas of the budget operations: the wire rows the API
 * returns. Transcribed from the client's former hand-written types
 * (`client/src/budget/data/rows.ts`), which now derive from these with
 * `z.infer`. Money is integer milliunits (see `MONEY_UNIT_RULE`); dates and
 * timestamps are strings on the wire.
 *
 * Objects are non-strict: a row may carry more columns than declared (most
 * reads are `SELECT *`); a declared field that is missing or mistyped fails
 * the catalog test and, in tests and dev mode, the handler itself.
 */
import { z } from '../../zod';

import { categorizationModes, matchTypes } from '../../domain/payees';
import { ACCOUNT_TYPES } from './schemas';
import { FREQUENCIES } from './frequencies';

const id = z.string();
const nullableString = z.string().nullable();
/** Integer milliunits. */
const milli = z.number().int();
/** Some bigint/numeric columns arrive as numbers; JSON never carries Date objects. */
const timestamp = z.string();

/** Answer of an operation whose handler returns nothing (HTTP 204). */
export const noContent = z.null().describe('No content (HTTP 204)');

// ---- people -------------------------------------------------------------------

export const personAvatarSchema = z.object({ seed: z.string(), image_version: z.number().nullable() });

/** Who linked a bank / owns a row: the app-wide person reference. */
export const personRefSchema = z.object({
  user_id: id,
  name: nullableString,
  email: nullableString,
  avatar: personAvatarSchema,
});

export const budgetMemberSchema = z.object({
  user_id: id,
  email: nullableString,
  name: nullableString,
  avatar: personAvatarSchema,
  is_owner: z.boolean(),
  is_me: z.boolean(),
  pending: z.boolean(),
});

export const budgetMembersSchema = z.object({ members: z.array(budgetMemberSchema), can_manage: z.boolean() });
export const budgetMembersChangedSchema = z.object({ members: z.array(budgetMemberSchema) });

// ---- budgets ------------------------------------------------------------------

export const dateFormatSchema = z.object({ format: z.string() });

export const currencyFormatSchema = z.object({
  iso_code: z.string(),
  example_format: z.string(),
  decimal_digits: z.number(),
  decimal_separator: z.string(),
  symbol_first: z.boolean(),
  group_separator: z.string(),
  currency_symbol: z.string(),
  display_symbol: z.boolean(),
});

export const budgetRowSchema = z.object({
  id,
  name: z.string(),
  /** Null for active budgets; the archive moment for archived ones. */
  archived_at: timestamp.nullable().optional(),
  /** Selected only by detail reads; the switcher query omits these. */
  date_format: dateFormatSchema.nullable().optional(),
  currency_format: currencyFormatSchema.nullable().optional(),
  last_modified_on: z.string().optional(),
});

/**
 * A budget as `budget_list` returns it: the row plus what a home page needs to
 * split "My budgets" from "Shared with me". These three fields are always
 * present in the list (and only there).
 */
export const budgetListRowSchema = budgetRowSchema.extend({
  /** True when the caller owns the budget ("My budgets"); false = shared with the caller. */
  is_owner: z.boolean(),
  /** The owner (id, display name, email, avatar), for "shared by ...". Null only for a legacy budget nobody has claimed. */
  owner: personRefSchema.nullable(),
  /** People on the budget, owner included: the same set `budget_members_list` returns (placeholders and pending invitees count). 1 = not shared. */
  member_count: z.number().int().nonnegative(),
});

export const freshStartResultSchema = z.object({ archived: budgetRowSchema, created: budgetRowSchema });
export const budgetDeletedSchema = z.object({ deleted: z.boolean() });
export const revisionSchema = z.object({ revision: z.number() });

// ---- plan structure -------------------------------------------------------------

export const groupRowSchema = z.object({
  id,
  name: z.string(),
  sort_order: z.number(),
  is_credit_card_payments: z.boolean(),
  hidden: z.boolean(),
  internal: z.boolean(),
  deleted: z.boolean(),
});

/** YNAB goal type. TB=target balance, TBD=target balance by date, MF=monthly funding, NEED=plan your spending, DEBT=debt payoff. */
export const goalTypeSchema = z.enum(['TB', 'TBD', 'MF', 'NEED', 'DEBT']);

export const categoryRowSchema = z.object({
  id,
  group_id: id,
  name: z.string(),
  sort_order: z.number(),
  note: nullableString,
  hidden: z.boolean(),
  internal: z.boolean(),
  deleted: z.boolean(),
  // YNAB goal model (null goal_type => no goal)
  goal_type: goalTypeSchema.nullable(),
  goal_needs_whole_amount: z.boolean().nullable(),
  goal_day: z.number().nullable(),
  goal_cadence: z.number().nullable(),
  goal_cadence_frequency: z.number().nullable(),
  goal_creation_month: nullableString,
  /** Milliunits. */
  goal_target: milli.nullable(),
  goal_target_date: nullableString,
  goal_snoozed_at: nullableString,
  /** Owning budget member; null = Shared. */
  user_id: id.nullable(),
  /** Bundle the category belongs to (same group); null = not bundled. */
  bundle_id: id.nullable().optional(),
});

export const bundleRowSchema = z.object({ id, group_id: id, name: z.string() });

export const categoryTargetRowSchema = z.object({
  budget_id: id,
  category_id: id,
  kind: z.enum(['weekly', 'monthly', 'yearly', 'custom']),
  /** Milliunits (the table stores whole cents). */
  amount: milli,
  snooze_month: z.number().nullable(),
  config: z.record(z.string(), z.unknown()),
});

/** One category's note for one month. */
export const categoryNoteRowSchema = z.object({ category_id: id, note: z.string() });

export const monthNoteRowSchema = z.object({
  /** First-of-month date, e.g. "2026-06-01". */
  month: z.string(),
  note: z.string(),
});

export const assignmentRowSchema = z.object({
  /** First-of-month date, e.g. "2026-06-01". */
  month: z.string(),
  category_id: id,
  /** Milliunits. */
  budgeted: milli,
});

// ---- payees -------------------------------------------------------------------

export const payeeRowSchema = z.object({
  id,
  name: z.string(),
  transfer_account_id: id.nullable(),
  deleted: z.boolean(),
});

/** GET /payees: the base payee plus visibility, categorization and usage stats. */
export const payeeAdminRowSchema = payeeRowSchema.extend({
  hidden: z.boolean(),
  categorization_mode: z.enum(categorizationModes),
  default_category_id: id.nullable(),
  /** The payee's own renaming rule: statement text matching this resolves to the payee. */
  rename_match_type: z.enum(matchTypes).nullable(),
  rename_condition: nullableString,
  transaction_count: z.number(),
  last_used_date: nullableString,
  /** Majority category of the payee's last 3 categorized transactions; null when none. */
  inferred_category_id: id.nullable(),
  inferred_category_name: nullableString,
  /** "Treat as transfer" rule (budget-mit6); null = off. */
  transfer_rule: z.enum(['auto', 'account', 'never']).nullable(),
  transfer_rule_account_id: id.nullable(),
});

export const payeeSuggestionSchema = z.object({
  payee_id: id,
  categorization_mode: z.enum(categorizationModes),
  category_id: id.nullable(),
});

const clearedSchema = z.enum(['cleared', 'uncleared', 'reconciled']);

/** One row of GET /payees/:id/transactions (date DESC, signed milliunits). */
export const payeeTxnRowSchema = z.object({
  id,
  date: z.string(),
  amount: milli,
  memo: nullableString,
  cleared: clearedSchema,
  account_id: id,
  account_name: z.string(),
  category_id: id.nullable(),
  category_name: nullableString,
  payee_id: id,
});

export const payeeTxnPageSchema = z.object({ rows: z.array(payeeTxnRowSchema), total: z.number() });
export const payeeMergedSchema = z.object({ merged_transactions: z.number(), source_deleted: z.boolean() });

// ---- accounts -----------------------------------------------------------------

export const accountTypeSchema = z.enum(ACCOUNT_TYPES);

export const accountRowSchema = z.object({
  id,
  name: z.string(),
  type: accountTypeSchema,
  account_group: z.enum(['CASH', 'CREDIT', 'CLOSED']),
  on_budget: z.boolean(),
  closed: z.boolean(),
  note: nullableString,
  /** Milliunits. */
  cleared_balance: milli,
  /** Milliunits. */
  uncleared_balance: milli,
  transfer_payee_id: id.nullable(),
  direct_import_linked: z.boolean(),
  direct_import_in_error: z.boolean(),
  /** Bank link (nullable — the link is a property of the account row). */
  connection_id: id.nullable(),
  external_account_id: nullableString,
  institution: nullableString,
  /** Who linked the bank behind `connection_id` (null when unlinked; list reads only). */
  linked_by: personRefSchema.nullable().optional(),
  /** Person (budget member) the account belongs to; null = Shared. */
  user_id: id.nullable(),
  /**
   * ISO 4217 code; null = the budget's currency (G1). Always sent by this API;
   * optional in the schema so rows built by pre-G1 code and fixtures stay valid.
   */
  currency: nullableString.optional(),
  last_reconciled_at: timestamp.nullable(),
  debt_interest_rates: z.record(z.string(), z.number()).nullable(),
  debt_minimum_payments: z.record(z.string(), z.number()).nullable(),
  debt_escrow_amounts: z.record(z.string(), z.number()).nullable(),
  sort_order: z.number(),
  deleted: z.boolean(),
});

// ---- transactions -------------------------------------------------------------

export const flagColorSchema = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple', '']);

export const debtTransactionTypeSchema = z.enum([
  'payment',
  'refund',
  'fee',
  'interest',
  'escrow',
  'balanceAdjustment',
  'credit',
  'charge',
]);

export const subTransactionRowSchema = z.object({
  id,
  transaction_id: id,
  /** Signed milliunits. */
  amount: milli,
  memo: nullableString,
  payee_id: id.nullable(),
  category_id: id.nullable(),
  transfer_account_id: id.nullable(),
  transfer_transaction_id: id.nullable(),
  deleted: z.boolean(),
});

// ---- transfers between own accounts (budget-mit6) ------------------------------

export const transferConfidences = ['sure', 'choose', 'one_side'] as const;
export const transferBases = ['unique', 'ordinal', 'evidence', 'rule', 'ambiguous', 'unmatched', 'refused'] as const;
export const transferViolations = ['card_outflow', 'card_payment_other_bank', 'cash_same_bank'] as const;
export const transferRuleModes = ['off', 'auto', 'account', 'never'] as const;
export const transferNoMatchPolicies = ['outside', 'review'] as const;

/**
 * The register's per-row transfer suggestion: `sure` = one proposed other
 * side, `choose` = several possible, `one_side` = looks like a transfer but no
 * matching row (the other account may not be in this budget).
 */
export const transferRowSuggestionSchema = z.object({
  confidence: z.enum(transferConfidences),
  candidate_count: z.number().int(),
  /** The proposed other side when there is exactly one. */
  counterpart_id: id.nullable(),
});

/** One side of a suggested transfer, as the review list shows it. Amount in signed milliunits. */
export const transferLegSchema = z.object({
  transaction_id: id,
  account_id: id,
  account_name: z.string(),
  date: z.string(),
  amount: milli,
  payee_name: nullableString,
  /** The bank's label for the row (Pluggy category, else operation type); null when none. */
  bank_label: nullableString,
  /** Untouched bank row (not edited since import). */
  untouched: z.boolean(),
});

/** One suggestion: the row it is about and its proposed other side(s), closest date first. */
export const transferSuggestionSchema = z.object({
  /** The row the suggestion is about (the outflow of a pair, or the lone row). */
  id,
  confidence: z.enum(transferConfidences),
  /** Why: `unique` only candidate, `ordinal` paired in date order among repeats, `evidence` bank labels, `rule` payee rule, `ambiguous` several candidates, `unmatched` no candidate, `refused` the pair breaks an account rule (never linked on its own; each candidate's `rule` says which). */
  basis: z.enum(transferBases),
  leg: transferLegSchema,
  candidates: z.array(
    transferLegSchema.extend({
      days_apart: z.number().int(),
      /** Only on `refused` suggestions: the account rule this pairing breaks. `card_outflow`: a card is never the paying side; `card_payment_other_bank`: a checking account paying another bank's card; `cash_same_bank`: checking to checking within one bank. */
      rule: z.enum(transferViolations).optional(),
    }),
  ),
});

export const transferLinkResultSchema = z.object({
  /** Every transaction id now linked (both legs of each pair); pass them to unlink to undo. */
  linked: z.array(id),
  rules_created: z.number().int(),
  /**
   * Counterpart links made although they break an account rule (they are still
   * linked): `card_outflow` a card is never the paying side; `card_payment_other_bank`
   * a checking account paid another bank's card; `cash_same_bank` checking to
   * checking within one bank.
   */
  warnings: z.array(
    z.object({ transaction_id: id, counterpart_id: id, rule: z.enum(transferViolations) }),
  ),
});

export const payeeTransferRuleSchema = z.object({
  payee_id: id,
  mode: z.enum(transferRuleModes),
  account_id: id.nullable(),
  no_match: z.enum(transferNoMatchPolicies),
  wait_days: z.number().int(),
  /** Rows created from this instant on are covered (ISO); null = every row. */
  since: timestamp.nullable(),
  /** Live rows of this payee still uncategorized and unlinked ("Apply to N past rows"). */
  past_rows: z.number().int(),
  /** Rows the last save linked (0 on reads). */
  linked: z.number().int(),
});

export const transactionRowSchema = z.object({
  id,
  account_id: id,
  date: z.string(),
  /** Signed milliunits (outflow negative, inflow positive). */
  amount: milli,
  payee_id: id.nullable(),
  /** Name of `payee_id` (list reads; includes transfer payees, which GET /payees omits). */
  payee_name: nullableString.optional(),
  category_id: id.nullable(),
  memo: nullableString,
  cleared: clearedSchema,
  approved: z.boolean(),
  flag_color: flagColorSchema.nullable(),
  flag_name: nullableString,
  transfer_account_id: id.nullable(),
  transfer_transaction_id: id.nullable(),
  matched_transaction_id: id.nullable(),
  import_id: nullableString,
  import_payee_name: nullableString,
  import_payee_name_original: nullableString,
  debt_transaction_type: debtTransactionTypeSchema.nullable(),
  /** App-side recurrence extra (not a YNAB Transaction field). */
  repeat: z.string(),
  /** Rule this row belongs to (materialized occurrence or attached anchor). */
  repeat_rule_id: id.nullable(),
  /** The occurrence's effective date (may differ from `date` for month-last-day rules). */
  occurrence_date: nullableString,
  /** Split legs; empty when the transaction is not split (list reads only). */
  subtransactions: z.array(subTransactionRowSchema).optional(),
  /** Materialized future occurrence of a repeat rule, or a derived upcoming card installment (see `installment`). */
  upcoming: z.boolean(),
  deleted: z.boolean(),
  /**
   * List reads only, on derived rows: a card installment the bank has not
   * billed yet (installment `number` of `total` of a purchase whose earlier
   * installment was imported). Computed at read time, never stored: `id` is
   * `installment:<source transaction id>:<number>` and is not addressable by
   * any other operation; `upcoming` is true, so it counts in no balance and
   * no budget activity. Absent on stored rows.
   */
  installment: z.object({ number: z.number().int(), total: z.number().int() }).optional(),
  /** List reads only: the transfer matcher thinks this row is one leg of a transfer between own accounts (null = no). */
  transfer_suggestion: transferRowSuggestionSchema.nullable().optional(),
  /**
   * List reads only: a row of a "treat as transfer" payee with no linked other
   * side. `waiting` = its other side has not arrived yet (counts as a transfer:
   * no category, no budget effect); `outside` = a transfer to an account
   * outside the budget (no category asked; moves Ready to Assign like any money
   * leaving or entering the budget). Null otherwise.
   */
  transfer_pending: z.enum(['waiting', 'outside']).nullable().optional(),
  /** List reads only: who linked this transfer leg (`auto` matcher, `rule` payee rule, `user`); null when unknown or not linked. */
  transfer_link_method: z.enum(['auto', 'rule', 'user']).nullable().optional(),
});

/** A split leg on the detail read, with its category's name. */
export const transactionDetailSubSchema = subTransactionRowSchema.extend({ category_name: nullableString });

/** One transaction on the detail read: the register row plus the names of what it points at. */
export const transactionDetailSchema = transactionRowSchema.extend({
  /** `YYYY-MM-DD`. */
  date: z.string(),
  payee_name: nullableString,
  category_name: nullableString,
  account_name: z.string(),
  subtransactions: z.array(transactionDetailSubSchema),
});

/**
 * Sync state of a bank-imported row: `imported` = the bank sync keeps it up to
 * date; `edited` = the person changed it, so the sync leaves it alone (the
 * shadow row is blocked).
 */
export const transactionImportStateSchema = z.enum(['imported', 'edited']);

/** What the bank sent for one imported transaction. */
export const transactionImportSchema = z.object({
  /** Aggregator that imported the row (e.g. `pluggy`). */
  provider: z.string(),
  /** The provider's own id for the transaction (`import_id` is `<provider>:` + this). */
  bank_transaction_id: z.string(),
  /** Bank connection of the row's account; null once the account was unlinked. */
  connection_id: id.nullable(),
  /** Institution name stored on the account; null when unknown or unlinked. */
  bank_name: nullableString,
  state: transactionImportStateSchema,
  /** The engine-owned fields (date, amount, memo, payee) as last written by the sync. */
  last_synced_payload: z.record(z.string(), z.unknown()),
  /** The provider's full transaction object as last received; null for rows not re-synced since it was recorded. */
  raw: z.record(z.string(), z.unknown()).nullable(),
  /** When `raw` was last written (ISO timestamp); null when it never was. */
  raw_received_at: timestamp.nullable(),
  /** Last time the sync changed the shadow row (ISO timestamp). */
  updated_at: timestamp,
});

/** Answer of the transaction detail read: the row and, for bank-imported rows, its import record. */
export const transactionDetailsSchema = z.object({
  transaction: transactionDetailSchema,
  /** Null for a row entered by hand (or from a file import). */
  import: transactionImportSchema.nullable(),
});

export const bulkImportResultSchema = z.object({ imported: z.number(), duplicates: z.number() });

export const repeatRuleRowSchema = z.object({
  id,
  account_id: id,
  payee_id: id.nullable(),
  category_id: id.nullable(),
  memo: nullableString,
  /** Signed milliunits (outflow negative). */
  amount: milli,
  frequency: z.enum(FREQUENCIES),
  next_due_date: z.string(),
  month_last_day: z.boolean(),
  deleted: z.boolean(),
});

export const repeatGenerateResultSchema = z.object({ flipped: z.number(), created: z.number() });

// ---- restore / export ------------------------------------------------------------

export const restoreCountsSchema = z.object({
  groups: z.number(),
  categories: z.number(),
  accounts: z.number(),
  transactions: z.number(),
  assignments: z.number(),
  /** Restored transactions whose category had no match in the budget (register-only restore); 0 otherwise. */
  uncategorized: z.number().optional(),
});

const exportTxn = z.object({
  accountIndex: z.number(),
  date: z.string(),
  payee: z.string(),
  categoryIndex: z.number().nullable(),
  memo: z.string(),
  outflow: milli,
  inflow: milli,
  cleared: clearedSchema,
  flag: z.string(),
  transferPeerIndex: z.number().nullable(),
});

/** GET /budgets/export: the restore document (format 2, milliunits) plus the extra sections. */
export const budgetExportSchema = z.object({
  format_version: z.literal(2),
  budget: z.object({ name: z.string(), archived: z.boolean() }),
  groups: z.array(z.string()),
  categories: z.array(
    z.object({
      groupIndex: z.number(),
      name: z.string(),
      hidden: z.boolean(),
      userId: id.nullable(),
      bundleIndex: z.number().nullable(),
    }),
  ),
  bundles: z.array(z.object({ groupIndex: z.number(), name: z.string() })),
  accounts: z.array(z.object({ name: z.string(), userId: id.nullable(), currency: nullableString })),
  transactions: z.array(exportTxn),
  assignments: z.array(z.object({ categoryIndex: z.number(), month: z.string(), budgeted: milli })),
  payees: z.array(z.string()),
  category_targets: z.array(
    z.object({ categoryIndex: z.number(), kind: z.string(), amount: milli, config: z.unknown() }),
  ),
  category_notes: z.array(z.object({ categoryIndex: z.number(), month: z.string(), note: z.string() })),
  month_notes: z.array(z.object({ month: z.string(), note: z.string() })),
  repeat_rules: z.array(
    z.object({
      accountIndex: z.number(),
      categoryIndex: z.number().nullable(),
      payee: z.string(),
      memo: z.string(),
      amount: milli,
      frequency: z.string(),
      next_due_date: z.string(),
      month_last_day: z.boolean(),
    }),
  ),
  splits: z.array(
    z.object({ transactionIndex: z.number(), amount: milli, memo: z.string(), categoryIndex: z.number().nullable() }),
  ),
});
