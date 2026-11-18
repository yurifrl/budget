/**
 * Hide Amounts mask — module-scoped boolean store in front of the money
 * formatters (SHARED CONTRACT with `ui/useMoneyMask` and `bits`' MoneyInput).
 *
 * Every display path funnels through `domain/format.ts` (formatMoney /
 * formatAmount), so masking at the source covers all screens with zero
 * call-site rewrites. The shell bridges the store into React via
 * `ui/stores` (`useMoneyMask`), so a banner click re-renders the tree. Editors: MoneyInput
 * consults `isMoneyMaskHidden()` and drops commits (YNAB parity: "changes
 * will not be saved").
 */

type Listener = () => void;

/** Placeholder shown instead of any amount while the mask is on. */
export const MONEY_MASK_TEXT = '••••••';

let hidden = false;
const listeners = new Set<Listener>();

/** True while the privacy mask is on. */
export function isMoneyMaskHidden(): boolean {
  return hidden;
}

/** Toggle the mask; notify every subscribed surface (panel, shell). */
export function setMoneyMaskHidden(next: boolean): void {
  if (next === hidden) return;
  hidden = next;
  for (const listener of listeners) listener();
}

/** Subscribe to mask changes; returns the unsubscribe function. */
export function subscribeMoneyMask(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
