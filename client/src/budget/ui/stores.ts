/**
 * React bridges for the module-scoped domain stores (money mask, fmt prefs,
 * flag labels). Each consumer subscribes directly via useSyncExternalStore,
 * so every hook renders itself on change — no shell cascade needed.
 *
 * Snapshot getters must be passed to useSyncExternalStore itself: React
 * Compiler caches plain function-call results, so a bare `getFmtPrefs()`
 * return would stay pinned to the first render's value.
 */

import { useSyncExternalStore } from 'react';

import {
  getFlagLabels,
  subscribeFlagLabels,
  type FlagLabels,
} from '../domain/flagLabels';
import {
  getFmtPrefs,
  subscribeFmtPrefs,
  type FmtPrefs,
} from '../domain/fmtPrefs';
import {
  isMoneyMaskHidden,
  setMoneyMaskHidden,
  subscribeMoneyMask,
} from '../domain/moneyMask';

/** Subscribe shell rendering to the mask; exposes [hidden, setHidden]. */
export function useMoneyMask(): [boolean, (next: boolean) => void] {
  const hidden = useSyncExternalStore(subscribeMoneyMask, isMoneyMaskHidden, isMoneyMaskHidden);
  return [hidden, setMoneyMaskHidden];
}

/** Read the current fmt prefs object (stable between changes). */
export function useFmtPrefs(): FmtPrefs {
  return useSyncExternalStore(subscribeFmtPrefs, getFmtPrefs, getFmtPrefs);
}

/** Read the current flag-labels map (stable between changes). */
export function useFlagLabels(): FlagLabels {
  return useSyncExternalStore(subscribeFlagLabels, getFlagLabels, getFlagLabels);
}
