/**
 * Display prefs from the budgetUi slice, for components: the bound money/date
 * formatter, the Hide Amounts mask and the flag labels. Every component that
 * renders money calls `useMoneyFormat()` (React context, provided from the
 * slice by `StoreMoneyFormatProvider` at the composition root), so a format
 * or mask change re-renders exactly the components that format.
 */

import { useCallback, useMemo, type ReactNode } from 'react';

import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { MoneyFormatProvider, useMoneyFormat } from '@/ui/moneyFormat';

import type { FlagLabels } from '../domain/flagLabels';
import type { FmtPrefs } from '../domain/fmtPrefs';
import { moneyFormat, type MoneyFormat } from '../domain/format';
import { selectFlagLabels, selectFmtPrefs, selectMoneyMasked, setMoneyMasked } from '../state/ui';

export { useMoneyFormat };

/** The formatters bound to the active budget's prefs and the mask, from the store. */
export function useStoreMoneyFormat(): MoneyFormat {
  const prefs = useAppSelector(selectFmtPrefs);
  const masked = useAppSelector(selectMoneyMasked);
  return useMemo(() => moneyFormat(prefs, masked), [prefs, masked]);
}

/** Provides `useMoneyFormat()` from the store (mounted inside the redux Provider). */
export function StoreMoneyFormatProvider({ children }: { children: ReactNode }) {
  return <MoneyFormatProvider value={useStoreMoneyFormat()}>{children}</MoneyFormatProvider>;
}

/** The active budget's format prefs. */
export function useFmtPrefs(): FmtPrefs {
  return useAppSelector(selectFmtPrefs);
}

/** Hide Amounts: [hidden, setHidden]. */
export function useMoneyMask(): [boolean, (next: boolean) => void] {
  const hidden = useAppSelector(selectMoneyMasked);
  const dispatch = useAppDispatch();
  const set = useCallback((next: boolean) => dispatch(setMoneyMasked(next)), [dispatch]);
  return [hidden, set];
}

/** The active budget's flag labels. */
export function useFlagLabels(): FlagLabels {
  return useAppSelector(selectFlagLabels);
}
