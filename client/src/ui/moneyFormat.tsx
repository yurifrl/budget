/**
 * The bound money/date formatter as React context, so UI primitives
 * (MoneyInput, AmountPill, dropdowns...) can format without knowing the store.
 * The composition root provides the value from the budgetUi slice
 * (`StoreMoneyFormatProvider`); without a provider the default pt-BR format
 * applies. A change of prefs or of the Hide Amounts mask changes the value,
 * so every consumer re-renders.
 */
import { createContext, useContext, type ReactNode } from 'react';

import { DEFAULT_MONEY_FORMAT, type MoneyFormat } from '@/domain/format';

const MoneyFormatContext = createContext<MoneyFormat>(DEFAULT_MONEY_FORMAT);

export function MoneyFormatProvider({ value, children }: { value: MoneyFormat; children: ReactNode }) {
  return <MoneyFormatContext.Provider value={value}>{children}</MoneyFormatContext.Provider>;
}

/** The formatters bound to the active budget's prefs and the mask. */
export function useMoneyFormat(): MoneyFormat {
  return useContext(MoneyFormatContext);
}
