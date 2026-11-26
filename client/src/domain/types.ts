/**
 * ynabu shared domain types — models PDD §2.
 *
 * SHARED CONTRACT. Feature agents import from here; do not fork these shapes.
 * All monetary amounts are stored as INTEGER CENTS (e.g. R$1.314,51 -> 131451)
 * to avoid floating-point drift. Use src/domain/format.ts to render.
 */

/** A month key in YYYYMM form, e.g. 202606. */
export type MonthKey = number;

/** Integer cents. Positive = money in / available; negative = spend / debt. */
export type Cents = number;

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** Funding-target cadence (the `category_targets` model, syscd-app-nc5). */
export type TargetKind = "weekly" | "monthly" | "yearly" | "custom";

/** Kind-specific knobs stored in `category_targets.config`. */
export interface CategoryTargetConfig {
  /** How often the amount repeats (default 1). */
  repeatEvery?: number;
  /** custom: unit of `repeatEvery` (default "monthly"). */
  repeatUnit?: "daily" | "weekly" | "monthly" | "yearly";
  /** custom: ISO date (YYYY-MM-DD) the money is needed by. */
  byDate?: string;
  /** weekly: anchor weekday, 0=Sunday..6=Saturday (default 1=Monday). */
  dayOfWeek?: number;
  /** yearly: due month 1-12 (default 12). */
  monthOfYear?: number;
  /** yearly: due day of month 1-31, clamped to the month (default 1). */
  dayOfMonth?: number;
  /** monthly: first month (MonthKey) the target starts. */
  fromMonth?: MonthKey;
}

export interface CategoryTarget {
  categoryId: string;
  kind: TargetKind;
  amountCents: Cents;
  config: CategoryTargetConfig;
  /** MonthKey (YYYYMM) whose need the target skips — "snooze for this month". NULL/absent = active; later months resume. */
  snoozeMonth?: MonthKey | null;
}

// ---------------------------------------------------------------------------
// Categories & groups
// ---------------------------------------------------------------------------

export interface Category {
  id: string;
  groupId: string;
  name: string;
  /**
   * Money assigned to this category, per month. Keyed by MonthKey.
   * Missing month => 0 assigned that month.
   */
  assigned: Record<MonthKey, Cents>;
  /**
   * Sum of transaction activity for this category, per month (negative for spend,
   * positive for inflow/refund). A derived display cache (`recomputeActivity`
   * fills it); nothing may use it for Ready to Assign or Available, which come
   * only from the zero-sum engine (`computeBudgetMonth`).
   */
  activity: Record<MonthKey, Cents>;
  /** Optional funding goal (legacy YNAB goal_* columns mapped at the storage boundary). */
  target?: CategoryTarget;
  /** Freeform per-category note. */
  notes?: string;
  /** Hidden categories are withheld from the plan grid and listed under the Hidden Categories row. */
  hidden?: boolean;
  /** The app's own category (never picked for a transaction). */
  internal?: boolean;
  /** Budget member who owns this category; null/absent = Shared (the default). */
  userId?: string | null;
  /** Bundle this category belongs to (same group); absent = not bundled. */
  bundleId?: string;
}

/** Display-only roll-up of categories inside one category group (docs/category-bundles-design.md). */
export interface Bundle {
  id: string;
  groupId: string;
  name: string;
}

export interface CategoryGroup {
  id: string;
  name: string;
  /**
   * Marks the system-managed "Credit Card Payments" group. One category per
   * credit account; AVAILABLE renders as PAYMENT. See PDD §3.5.
   */
  isCreditCardPayments?: boolean;
  /** The app's own group (its categories are never picked for a transaction). */
  internal?: boolean;
  categoryIds: string[];
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type AccountType =
  | "checking"
  | "savings"
  | "cash"
  | "credit"
  | "tracking";

/** Account types that hold cash (also the YNAB wire types with the same names). */
export const CASH_ACCOUNT_TYPES: ReadonlySet<string> = new Set(["checking", "savings", "cash"]);

/** Left-rail grouping (PDD §4.1). */
export type AccountGroup = "CASH" | "CREDIT" | "CLOSED";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  group: AccountGroup;
  /** Budget accounts (true) feed Ready-to-Assign; tracking accounts (false) do not. */
  onBudget: boolean;
  /** Confirmed-by-bank balance, in cents. */
  clearedBalance: Cents;
  /** Pending / manually-entered balance not yet cleared, in cents. */
  unclearedBalance: Cents;
  /** ISO timestamp of last reconciliation, or null if never reconciled. */
  lastReconciledAt: string | null;
  /** Person (budget member) the account belongs to; null = Shared (the default). */
  userId: string | null;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export type ClearedStatus = "cleared" | "uncleared" | "reconciled";

export type FlagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

/** Recurrence cadence for scheduled transactions (PDD §4.4). */
export type RepeatCadence =
  | "never"
  | "daily"
  | "weekly"
  | "every-other-week"
  | "monthly"
  | "every-other-month"
  | "quarterly"
  | "annually"
  | "yearly";

/** Cadences a repeat rule can use (server: repeat-schedule.ts FREQUENCIES). */
export type RepeatFrequency = Exclude<RepeatCadence, "never" | "daily" | "yearly">;

export interface Transaction {
  id: string;
  accountId: string;
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  payee: string;
  /** The payee's id (a transfer payee's too); null when the row has none. Writes send it when the payee is unchanged or picked. */
  payeeId?: string | null;
  /** null => "this needs a category" (PDD §4.2). */
  categoryId: string | null;
  memo: string;
  /** Money leaving the account, in cents (>= 0). */
  outflow: Cents;
  /** Money entering the account, in cents (>= 0). */
  inflow: Cents;
  cleared: ClearedStatus;
  /** Imported txns start unapproved (PDD §4.6). */
  approved: boolean;
  flag?: FlagColor;
  /** Optional receipt/attachment URL or data ref. */
  attachment?: string;
  repeat: RepeatCadence;
  /** Rule this row belongs to (anchor of the series or materialized occurrence). */
  repeatRuleId: string | null;
  /**
   * True while the row is a materialized future occurrence of a repeat rule
   * (issue syscd-app-pya): visible in the register with a Repeat badge but
   * withheld from budget activity and account balances until its date passes.
   */
  upcoming: boolean;
  /**
   * Set only on a derived upcoming card installment (budget-lubt): installment
   * `number` of `total` of a purchase the bank has not billed yet. Read-only:
   * the server computes it per read (it has no stored row to edit or delete);
   * `upcoming` is true, so it stays out of balances and budget activity.
   */
  installment?: { number: number; total: number };
  /**
   * Split legs (syscd-app-rlt), each owning its own category. Present only on
   * split transactions; the parent then carries categoryId null ("Split").
   */
  splits?: TransactionSplit[];
  /** Server import id (imported rows only); null for manual rows. */
  importId?: string | null;
  /**
   * Match link (syscd-app-42f): both sides of a matched pair store the same
   * linked id; null/absent = unmatched.
   */
  matchedTransactionId?: string | null;
  /**
   * Peer account of a transfer (docs/budget-engine-spec.md section 4): the
   * server's transfer pointer, else the account of the row's transfer payee
   * (never read from the payee text). Set on
   * BOTH mirrored legs of a transfer, each pointing at the other leg's account;
   * transfer legs carry no category unless one side is off-budget (T4).
   * null/absent = not a transfer.
   */
  transferAccountId?: string | null;
  /**
   * Transfer matcher (budget-mit6): this row looks like one leg of a transfer
   * between own accounts. `sure` = one proposed other side (`counterpartId`),
   * `choose` = several possible, `oneSide` = no matching row. Absent = no.
   */
  transferSuggestion?: { confidence: 'sure' | 'choose' | 'oneSide'; candidateCount: number; counterpartId: string | null };
  /**
   * An old per-payee "treat as transfer" rule's row with no linked other side:
   * `waiting` = the other side has not arrived yet (a transfer in flight: no
   * category, no budget effect). `outside` (a transfer to an account outside the
   * budget) is no longer offered or read by the app: the mapping drops it, so
   * such a row is an ordinary one; the engine still takes it as an ordinary
   * uncategorized row if a caller passes it (its money moves Ready to Assign).
   */
  transferPending?: 'waiting' | 'outside';
  /** Who linked this transfer leg (`rule` shows "auto · payee rule"). */
  transferLinkMethod?: 'auto' | 'rule' | 'user';
}

/** One split leg: category + memo + one-way cents amount (syscd-app-rlt). */
export interface TransactionSplit {
  id: string;
  categoryId: string | null;
  memo: string;
  outflow: Cents;
  inflow: Cents;
}

// ---------------------------------------------------------------------------
// Budget (root aggregate)
// ---------------------------------------------------------------------------

export interface Budget {
  id: string;
  name: string;
  /** The month currently in focus, e.g. 202606. */
  currentMonth: MonthKey;
  /** All months that have data, ascending. */
  months: MonthKey[];
  groups: CategoryGroup[];
  categories: Category[];
  /** Category bundles; [] when none. */
  bundles: Bundle[];
  accounts: Account[];
  transactions: Transaction[];
  /** Per-month freeform note, keyed by MonthKey (PDD §3.1). */
  monthNotes?: Record<MonthKey, string>;
}

// ---------------------------------------------------------------------------
// Engine output shapes
// ---------------------------------------------------------------------------

/**
 * Funding pill / progress-bar state (PDD §3.4, bead ynabu-3dn.6). `credit` =
 * overspent only on credit (no cash overspend); drawn with the yellow style.
 */
export type FundingState = "green" | "yellow" | "gray" | "red" | "credit";

export interface TargetFundingResult {
  state: FundingState;
  /** How much the category needs assigned this month to be on-track (cents). */
  neededThisMonth: Cents;
  /** How much has been assigned toward the target this month (cents). */
  fundedSoFar: Cents;
  /** Remaining gap = max(0, needed - funded) (cents). */
  gap: Cents;
  /** Card payment categories only: debt not covered by Available (cents), when > 0. */
  underfunded?: Cents;
}
