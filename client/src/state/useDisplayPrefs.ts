/**
 * Display prefs from the budgetUi slice, for components: the bound money/date
 * formatter, the Hide Amounts mask and the flag labels. Every component that
 * renders money calls `useMoneyFormat()` from `@/ui/moneyFormat` (React
 * context, provided from the slice by `useStoreMoneyFormat` through
 * shell/StoreMoneyFormatProvider), so a format or mask change re-renders
 * exactly the components that format.
 */

import { useCallback, useMemo } from 'react';

import { useAppDispatch, useAppSelector } from './hooks';

import type { FlagLabels } from '@/domain/flagLabels';
import type { FmtPrefs } from '@/domain/fmtPrefs';
import { moneyFormat, type MoneyFormat } from '@/domain/format';
import { selectFlagLabels, selectFmtPrefs, selectMoneyMasked, setMoneyMasked } from './ui';

/** The formatters bound to the active budget's prefs and the mask, from the store. */
export function useStoreMoneyFormat(): MoneyFormat {
  const prefs = useAppSelector(selectFmtPrefs);
  const masked = useAppSelector(selectMoneyMasked);
  return useMemo(() => moneyFormat(prefs, masked), [prefs, masked]);
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
