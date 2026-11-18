/**
 * Flag labels (Settings > Edit Flags; YNAB parity: six fixed colors, each
 * with an editable label). Types and pure helpers; the live map lives in the
 * budgetUi redux slice (persisted per budget in the settings blob).
 *
 * An empty label means "no label": menus fall back to the capitalized color
 * name (see `displayFlagLabel`).
 */

import type { FlagColor } from './types';

export type FlagLabels = Record<FlagColor, string>;

export const DEFAULT_FLAG_LABELS: FlagLabels = {
  red: '',
  orange: '',
  yellow: '',
  green: '',
  blue: '',
  purple: '',
};

/**
 * @deprecated No-op. Flag labels live in the budgetUi redux slice. Kept only
 * because data/settingsBlob.ts still imports it for the unused
 * `applyBudgetSettings`. Follow-up: delete with that function.
 */
export function setFlagLabels(_next: FlagLabels): void {}

/** "red" -> "Red". Fallback when no user label is set. */
export function defaultFlagLabel(color: FlagColor): string {
  return color.charAt(0).toUpperCase() + color.slice(1);
}

/** User label for a color, or its capitalized name when blank/whitespace. */
export function displayFlagLabel(map: FlagLabels, color: FlagColor): string {
  const label = map[color]?.trim();
  return label ? label : defaultFlagLabel(color);
}
