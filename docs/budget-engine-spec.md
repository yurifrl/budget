# Budget engine spec: zero-sum with YNAB card semantics

> Copied from syscd-app `docs/` (phase 5a). Paths: syscd `modules/budget/domain/*` is `client/src/domain/*` here (`zeroSum.ts` is the canonical engine; see `docs/architecture.md`).

Status: target behaviour for the engine rebuild (epic `syscd-app-33px`). This
document is the source of truth; where existing code or tests disagree, they
are wrong. All amounts are integer cents. "Card" = on-budget account with
`group === "CREDIT"`; "cash account" = any other on-budget account.

Each rule is tagged: **[YNAB]** verified against YNAB help articles (links at
the end), **[ASSUMED]** believed YNAB behaviour not verified, **[OURS]** our
design where YNAB has no equivalent.

## 1. Ready to Assign (RTA)

- R1 [YNAB] RTA is cash with no job: cash that entered the budget minus money
  held in envelopes. Card debt never increases RTA.
- R2 [YNAB] Assigning to any category, including a card payment category,
  lowers RTA by that amount; un-assigning raises it.
- R3 [YNAB] Assignments in months after the viewed month lower the viewed
  month's RTA immediately.
- R4 [OURS] Uncategorized, non-transfer transactions on cash accounts hit RTA
  in the month they occur: inflows raise it (income, starting balance,
  reconciliation adjustment), outflows lower it.
- R5 [OURS] Uncategorized transactions on a card have no budget effect at all:
  an outflow is debt with no cash behind it (starting balance, interest,
  uncategorized purchase), an inflow only lowers the debt (statement credit).
  [YNAB] confirms both ends: starting card debt and interest move no money; a
  card inflow sent to RTA changes neither RTA nor the payment Available.

## 2. Spending categories, per month

For category `c` in month `m`:

- `carryover` = previous month's end Available, floored at 0.
- `start = carryover + assigned(m)` (assigned may be negative).
- `cashNet` = signed net of its transactions on cash accounts in `m`.
- `cardNet[k]` = signed net of its transactions on card `k` in `m`.
- `available = start + cashNet + Σ cardNet`.

- S1 [YNAB] Funded card spending moves to that card's payment category. If
  `available >= 0`, every card's net spend `-cardNet[k]` is funded.
- S2 [YNAB] If `available < 0`: `overspend = -available`,
  `cardSpend = Σ_k max(0, -cardNet[k])` (cards with net spend only),
  `creditOverspend = min(overspend, cardSpend)`,
  `cashOverspend = overspend - creditOverspend`.
  Cash takes the Available first. Funded card spending =
  `cardSpend - creditOverspend`, split per S7. A card with a net refund in
  the month (`cardNet[k] > 0`) always has `funded[k] = -cardNet[k]` (S6),
  overspent or not. Example: $100 Available, $150 card purchase →
  $100 moves, $50 credit overspending.
- S3 [YNAB] The computation is on the month's end state, so money added to an
  overspent category later in the same month flows on to the payment category.
- S4 [YNAB] Month rollover: `cashOverspend` is subtracted from the next
  month's RTA and the category carries 0. `creditOverspend` is NOT subtracted
  from RTA; the category carries 0 and the debt stays unfunded.
- S5 [YNAB] A category with any `cashOverspend` shows as cash-overspent (red);
  with only `creditOverspend` as credit-overspent (yellow).
- S6 [ASSUMED] A refund on a card categorized to a spending category nets
  against that month's card spending (`cardNet`); a month with net positive
  `cardNet[k]` moves that amount back OUT of the payment category.
- S7 [OURS] Several cards in one overspent category: `creditOverspend` is
  split across cards in proportion to each card's net spend; leftover cents go
  to the card with the largest net spend (ties: lowest account id).

## 3. Card payment categories

One per card, in the group flagged `isCreditCardPayments`, linked to the card
via `cardAccountForCategory` (name match, or the only card).

- P1 [YNAB] It is a carried envelope, never derived from the card balance:
  `available(m) = max(0, available(m−1)) + assigned(m) + funded(m) − payments(m)`.
  Assignments may be negative (money moved out).
- P2 [YNAB] A payment is a transfer from a cash account to the card, with no
  category. It lowers Available by the amount. [ASSUMED] A transfer from the
  card to a cash account (cash advance, refund of an overpayment) raises it.
- P3 [YNAB] Starting debt gets nothing automatically: Available stays 0 until
  the user assigns.
- P4 [YNAB] `underfunded = max(0, debt − max(0, available))` where
  `debt = max(0, −card ledger balance as of the end of the viewed month)`
  (transactions dated after the viewed month do not count). A negative
  Available is overspending (P5), not extra underfunding.
- P5 [ASSUMED] Paying more than Available leaves it negative (red, cash
  overspending): subtracted from next month's RTA, then carries 0.
- P6 [YNAB] Card-to-card balance transfers move nothing between payment
  categories.
- P8 [OURS] The link is one-to-one. Each card resolves to at most one payment
  category: the payment-group category whose name equals the card's name;
  failing that, and only when exactly one card and exactly one payment-group
  category are left unlinked, those two pair up. A payment-group category
  with no card behaves as an ordinary spending category (it appears in
  `categories`, its assignments lower RTA, it carries normally). A card with
  no payment category still gets a payment envelope, reported in `payments`
  under the key `card:<accountId>` with `assigned` 0, so funded spending and
  payments are conserved. I1 and I2 must hold in every one of these cases.
- L7 [OURS] A transaction with `splits` undefined OR an empty array is a
  plain (non-split) transaction.
- P7 [YNAB, approximated] A card's funded spending moves to its payment
  category only to the extent it creates debt. Per card per month on the
  month's end state: `F` = Σ over categories of funded spending on the card
  (S1/S2/S7); `B` = the card's ledger balance at the end of the month (L1);
  `paid` = net paid to the card from cash accounts this month (P2). Payments
  settle the month's spending last, so the balance the spending is measured
  against is `B − paid`. If `F > 0`: `funded = min(F, max(0, paid − B))`
  and the remainder `F − funded` is spending absorbed by a positive balance:
  it moves nothing, and the money it freed (it was already spent, no new debt
  exists) returns to RTA in that month, so I1 holds. If `F <= 0` (net refunds)
  `funded = F` (S6), unchanged. Worked example: cash 1000, overpay the card
  100 (card +100, payment Available −100, P5, swept from next month's RTA);
  next month assign 200 to Mercado, spend 150 on the card: balance −50, so
  only 50 moves (`funded` 50, payment Available 50 = debt, underfunded 0);
  Mercado Available 50; the other 100 returns to RTA (RTA 900 − 200 + 100 =
  800). I1: 900 = 800 + 50 + 50. Approximation: intra-month ordering is
  ignored; within a month all non-payment activity counts before payments
  (a card +100 that spends 150 and is paid 150 in the same month is treated
  as spend first). Credit-overspent parts (S2) are never funded, so they
  never consume the positive balance.

## 4. Transfers

- T1 A transfer is a transaction with `transferAccountId` set (new optional
  field on `Transaction`); the mapping layer will also set it from the legacy
  `Transfer : <account>` payee convention.
- T2 Cash ↔ cash, both on-budget: no budget effect.
- T3 Cash ↔ card: P2.
- T4 To/from an off-budget account: treated as a normal transaction
  (categorized → category activity; uncategorized → R4).

## 4b. Ledger, months, splits [OURS]

- L1 The engine computes every account balance from the ledger (sum of
  non-upcoming transactions). `clearedBalance` / `unclearedBalance` are not
  read by the budget math; `debt = max(0, −ledger sum of the card)`. Opening
  money must exist as a Starting Balance transaction. There is no implicit
  "opening cash" term.
- L2 `upcoming: true` transactions are excluded from every rule.
- L3 The first ledger month is the earliest month with a non-upcoming
  transaction or an assignment. For any earlier month, RTA and every figure
  are 0. Months with no data between or after active months carry forward.
- L4 Split legs count individually toward their own category (or as
  uncategorized, R4/R5); the parent's own category is ignored. S1/S2 apply to
  the category's month totals, not per leg or per transaction.
- L5 `CategoryMonth.activity` = cash net + card net of the category's legs in
  the month.
- L6 A reconciliation adjustment is an ordinary uncategorized transaction:
  on a cash account it moves RTA (R4), on a card it has no budget effect (R5).

Open for the rewire phase (not engine tests): person filter, payment rows in
group/bundle roll-ups and export, pill colour when credit-overspent and
underfunded both apply, UI label for uncategorized card inflows, auto-assign
on payment categories, cards without a payment category, non-card CREDIT
accounts, fate of `recomputeActivity`, pairing bank-imported card payments.

## 5. Invariants (must hold for every budget, every month `m` with no
transactions or assignments after `m`)

- I1 `Σ cash account balances = RTA(m) + Σ spending.available +
  Σ spending.creditOverspend + Σ payment.available`, with negative
  `available` values kept as they are (adding `creditOverspend` is what
  cancels the credit part). G1 step 3: 900 + (−50) + 50 + 100 = 1000.
- I2 For each card: `underfunded = max(0, debt − max(0, payment.available))`.
- I3 Moving X between two categories in the same month leaves RTA and
  `Σ available` unchanged, except that money landing in a credit-overspent
  category shifts on to the payment category (sum still unchanged).

## 6. Golden scenarios

G1 Worked example (checking 1.000,00 via Starting Balance, card 0):

| Step | RTA | Mercado | Card payment | Checking | Card |
|---|---|---|---|---|---|
| Assign 100 to Mercado | 900 | 100 | 0 | 1000 | 0 |
| Card purchase 70 in Mercado | 900 | 30 | 70 | 1000 | −70 |
| Card purchase 80 in Mercado | 900 | −50 credit | 100 | 1000 | −150 |
| Next month (rollover) | 900 | 0 | 100, underfunded 50 | 1000 | −150 |
| Assign 50 to card payment | 850 | 0 | 150 | 1000 | −150 |
| Pay the card 150 (transfer) | 850 | 0 | 0 | 850 | 0 |

G2 Fresh start with debt: checking 6.731,69, card starting balance
−12.137,96, nothing assigned → RTA 6.731,69; payment Available 0;
underfunded 12.137,96. Assign 6.731,69 to the payment category → RTA 0;
Available 6.731,69; underfunded 5.406,27.

G3 Cash overspend: 1.000 cash, assign 100, debit purchase 150 → category −50
cash; RTA 900 this month, 850 next month; category 0 next month.

G4 Mixed: Available 100, cash purchase 120, card purchase 50 → available −70;
creditOverspend 50, cashOverspend 20, funded 0. Next month RTA drops by 20
only.

G5 Cover in month: G1 step 3, then assign 50 more to Mercado in the same
month → Mercado 0, payment 150, RTA 850.

G6 Regression (the bug that triggered this): R$ 50 assigned, R$ 90 card
purchase → next month RTA is NOT reduced by 40; payment Available is 50;
underfunded 40.

G7 Regression: assignments to the payment category made in earlier months
still count in later months' Available (P1).

G8 Statement credit: uncategorized card inflow 30 with debt 100, payment
Available 100 → RTA unchanged, Available 100, debt 70, underfunded 0.

## 7. Engine API (new module `modules/budget/domain/zeroSum.ts`)

```ts
export interface CategoryMonth {
  assigned: Cents; activity: Cents; carryover: Cents; available: Cents;
  cashOverspend: Cents; creditOverspend: Cents; // both >= 0
}
export interface PaymentMonth {
  accountId: string;
  assigned: Cents;   // this month
  funded: Cents;     // moved in this month (negative if net refunds)
  payments: Cents;   // net paid to the card this month (>= 0 normally)
  available: Cents;  // cumulative, P1
  debt: Cents;       // max(0, -working balance)
  underfunded: Cents;
}
export interface BudgetMonth {
  month: MonthKey;
  readyToAssign: Cents;
  /** Spending categories only, keyed by category id. */
  categories: Record<string, CategoryMonth>;
  /** Card payment categories, keyed by category id. */
  payments: Record<string, PaymentMonth>;
}
export function computeBudgetMonth(budget: Budget, month: MonthKey): BudgetMonth;
```

The engine derives everything from `budget.transactions`, `category.assigned`
and account balances. It must not read `category.activity` or
`category.paymentAvailable` (both go away in the rewire).

## Sources

- https://support.ynab.com/overspending-in-ynab-a-guide-ryWoxEyi
- https://support.ynab.com/en_us/credit-card-overspending-an-overview-HkMGpSbJs
- https://support.ynab.com/handling-credit-cards-overview-ry7cNub1s
- https://support.ynab.com/credit-card-rewards-and-statement-credits-a-guide-ryoRzYY0q
