/**
 * Credit card payment categories (docs/budget-engine-spec.md section 3): the
 * link from a payment category to the card it pays. The amounts live in the
 * zero-sum engine (`computeBudgetMonth().payments`), never here.
 *
 * PURE.
 */

import type { Account, Budget, Category } from "./types";

/** A card, exactly as the engine sees it: an on-budget account in the CREDIT group. */
export const isCardAccount = (a: Pick<Account, "onBudget" | "group">): boolean => a.onBudget && a.group === "CREDIT";

/** Key of the payment envelope of a card that has no payment category (spec P8). */
export const cardEnvelopeKey = (accountId: string): string => `card:${accountId}`;

/** Ids of the categories in groups flagged `isCreditCardPayments`. */
function paymentGroupCategoryIds(budget: Budget): Set<string> {
  const inPaymentGroup = new Set(budget.groups.filter((g) => g.isCreditCardPayments).flatMap((g) => g.categoryIds));
  return new Set(budget.categories.filter((c) => inPaymentGroup.has(c.id)).map((c) => c.id));
}

/**
 * The one place the card link is resolved (spec P8). One-to-one: each card
 * gets at most one payment-group category, the one named like the card; then,
 * if exactly one card and exactly one payment-group category are left, they
 * pair. Returns payment category id -> card. Payment-group categories absent
 * from the map are ordinary spending categories; cards absent from its values
 * get an envelope under `cardEnvelopeKey`.
 *
 * `categories` overrides `budget.categories` (callers probing a renamed copy).
 */
export function resolveCardLinks(budget: Budget, categories: readonly Category[] = budget.categories): Map<string, Account> {
  const groupIds = paymentGroupCategoryIds(budget);
  const candidates = categories.filter((c) => groupIds.has(c.id));
  const links = new Map<string, Account>();
  const unlinkedCards: Account[] = [];
  for (const card of budget.accounts.filter(isCardAccount)) {
    const match = candidates.find((c) => !links.has(c.id) && c.name === card.name);
    if (match) links.set(match.id, card);
    else unlinkedCards.push(card);
  }
  const unlinked = candidates.filter((c) => !links.has(c.id));
  if (unlinkedCards.length === 1 && unlinked.length === 1) links.set(unlinked[0].id, unlinkedCards[0]);
  return links;
}

/** The card a payment category pays, or undefined (it is then a spending category). */
export function cardAccountForCategory(budget: Budget, category: Category): Account | undefined {
  return resolveCardLinks(
    budget,
    budget.categories.map((c) => (c.id === category.id ? category : c)),
  ).get(category.id);
}
