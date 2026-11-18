/**
 * Flag labels — module-scoped store behind the Settings panel's Edit Flags
 * sub-view (YNAB parity: six fixed colors, each with an editable label).
 *
 * An empty label means "no label": menus fall back to the capitalized color
 * name (see `displayFlagLabel`). Same store recipe as `fmtPrefs` — plain
 * module state; consumers bridge it into React via `ui/stores`
 * (useSyncExternalStore), and the panel persists it per budget through the
 * KV store (key: `budget.settings.<budgetId>`, one blob for all panel
 * settings).
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

let labels: FlagLabels = DEFAULT_FLAG_LABELS;
const listeners = new Set<() => void>();

export function getFlagLabels(): FlagLabels {
  return labels;
}

export function setFlagLabel(color: FlagColor, label: string): void {
  labels = { ...labels, [color]: label };
  for (const listener of listeners) listener();
}

/** Replace the whole map at once (KV hydration from the Settings panel). */
export function setFlagLabels(next: FlagLabels): void {
  labels = { ...next };
  for (const listener of listeners) listener();
}

/** useSyncExternalStore-compatible subscribe; returns the unsubscribe fn. */
export function subscribeFlagLabels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** "red" -> "Red". Fallback when no user label is set. */
export function defaultFlagLabel(color: FlagColor): string {
  return color.charAt(0).toUpperCase() + color.slice(1);
}

/** User label for a color, or its capitalized name when blank/whitespace. */
export function displayFlagLabel(map: FlagLabels, color: FlagColor): string {
  const label = map[color]?.trim();
  return label ? label : defaultFlagLabel(color);
}
