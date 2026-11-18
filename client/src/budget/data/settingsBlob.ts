/**
 * Per-budget Settings panel blob — one KVStore key holding everything the
 * Settings panel writes (SHARED CONTRACT between the shell and the panel):
 *
 *   key: `budget.settings.<budgetId>`
 *   { fmt?: Partial<FmtPrefs>, flagLabels?: Partial<Record<FlagColor,string>>,
 *     display?: { progressBars?, hiddenCategories? } }
 *
 * The shell loads it on every budget switch and rehydrates the domain stores
 * (money format, flag labels) plus the RTK display toggles — so prefs apply
 * even if the panel is never opened after a switch. The panel merges writes
 * on each change. All fields optional for forward compatibility.
 */

import type { KVStore } from '@/platform/storage/types';

import { setFlagLabels, DEFAULT_FLAG_LABELS } from '../domain/flagLabels';
import { setFmtPrefs, type FmtPrefs } from '../domain/fmtPrefs';
import type { FlagColor } from '../domain/types';
import { setShowClosedAccounts, setShowHiddenCategories, setShowProgressBars } from '../state/ui';

/** Minimal dispatch type so this data helper doesn't depend on the full hook typing. */
type DispatchLite = (action: { type: string; payload?: unknown }) => void;

export interface BudgetDisplaySettings {
  progressBars?: boolean;
  hiddenCategories?: boolean;
  /** Whether the rail shows the CLOSED accounts group (off = YNAB default). */
  closedAccounts?: boolean;
  /** The Plan's solo "Planning with someone? Add people" prompt was dismissed. */
  peoplePromptDismissed?: boolean;
}

export interface BudgetSettingsBlob {
  fmt?: Partial<FmtPrefs>;
  flagLabels?: Partial<Record<FlagColor, string>>;
  display?: BudgetDisplaySettings;
}

export function budgetSettingsKey(budgetId: string): string {
  return `budget.settings.${budgetId}`;
}

export function loadBudgetSettings(storage: KVStore, budgetId: string): Promise<BudgetSettingsBlob> {
  return storage.get<BudgetSettingsBlob>(budgetSettingsKey(budgetId), {});
}

/**
 * Sectioned-merge write (SHARED CONTRACT — one definition so every writer
 * persists identically): loads the blob FRESH, then merges each section
 * key-wise — a one-field fmt patch must not drop the other fmt keys, same
 * semantics as the old in-memory blob spread in the deleted SettingsPanel.
 */
export async function saveBudgetSettingsPatch(
  storage: KVStore,
  budgetId: string,
  patch: BudgetSettingsBlob,
): Promise<void> {
  const prev = await loadBudgetSettings(storage, budgetId);
  const next: BudgetSettingsBlob = {
    ...prev,
    ...(patch.fmt ? { fmt: { ...prev.fmt, ...patch.fmt } } : null),
    ...(patch.flagLabels ? { flagLabels: { ...prev.flagLabels, ...patch.flagLabels } } : null),
    ...(patch.display ? { display: { ...prev.display, ...patch.display } } : null),
  };
  await storage.set(budgetSettingsKey(budgetId), next);
}

/**
 * Rehydrate the module stores from a loaded blob (SHARED CONTRACT — one
 * definition so the shell and the panel always apply it identically):
 * domain stores are patched when present, the RTK display toggles fall back
 * to their defaults (true) when the blob predates the field.
 */
export function applyBudgetSettings(blob: BudgetSettingsBlob, dispatch: DispatchLite): void {
  if (blob.fmt) setFmtPrefs(blob.fmt);
  if (blob.flagLabels) setFlagLabels({ ...DEFAULT_FLAG_LABELS, ...blob.flagLabels });
  dispatch(setShowProgressBars(blob.display?.progressBars ?? true));
  dispatch(setShowHiddenCategories(blob.display?.hiddenCategories ?? true));
  dispatch(setShowClosedAccounts(blob.display?.closedAccounts ?? false));
}
