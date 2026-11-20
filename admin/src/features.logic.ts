/** Pure view logic of the feature toggles (Features page and the Users page). */
import type { AdminFeature, FeatureUserOverride, FeatureValue } from '@shared/contracts/features';
import { featureSource, resolveFeatureValue, type FeatureSource } from '@shared/features';

import { relativeTime } from './users.logic';

export const onOff = (value: boolean): string => (value ? 'on' : 'off');

export interface ToggleState {
  /** The value that applies. */
  value: boolean;
  /** Where it comes from. */
  source: FeatureSource;
  /** The stored row behind it at this level (the everyone value, or the user's override); null = nothing stored here. */
  stored: FeatureValue | null;
  /** "overridden" / "inherited: everyone is on" / "default"... */
  label: string;
}

/** The "everyone" switch of a feature: its stored value, else the default in code. */
export function everyoneState(feature: Pick<AdminFeature, 'default' | 'everyone'>): ToggleState {
  const stored = feature.everyone;
  return {
    value: resolveFeatureValue(feature.default, { everyone: stored?.value }),
    source: stored ? 'everyone' : 'default',
    stored,
    label: stored ? `set for everyone: ${onOff(stored.value)}` : `not set: the default (${onOff(feature.default)}) applies`,
  };
}

export const overrideOf = (feature: Pick<AdminFeature, 'overrides'>, userId: string): FeatureUserOverride | null =>
  feature.overrides.find((o) => o.user_id === userId) ?? null;

/** One user's switch of a feature: their override, else what they inherit. */
export function userState(feature: Pick<AdminFeature, 'default' | 'everyone' | 'overrides'>, userId: string): ToggleState {
  const override = overrideOf(feature, userId);
  const stored = { everyone: feature.everyone?.value, user: override?.value };
  const source = featureSource(stored);
  const value = resolveFeatureValue(feature.default, stored);
  const label =
    source === 'user' ? 'overridden' : source === 'everyone' ? `inherited: everyone is ${onOff(value)}` : `inherited: default is ${onOff(value)}`;
  return { value, source, stored: override, label };
}

/** "by ana@x.test, 3 hours ago" for a stored value; "" when nothing is stored. */
export function changedLabel(stored: FeatureValue | null, now: number): string {
  if (!stored) return '';
  const who = stored.changed_by ? (stored.changed_by.email ?? stored.changed_by.name ?? 'a user without e-mail') : 'a deleted user';
  return `by ${who}, ${relativeTime(stored.changed_at, now)}`;
}

/** Does the filter text match the feature (its key, group or description)? Every word must match; empty = all. */
export function matchesFeature(feature: Pick<AdminFeature, 'key' | 'group' | 'description'>, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${feature.key} ${feature.group} ${feature.description}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

export interface FeatureGroup<F> {
  group: string;
  features: F[];
}

/**
 * The features matching the filter, under their group headings. Groups come
 * in the order the code list first names them, features in list order; a
 * group with no match is left out.
 */
export function groupFeatures<F extends Pick<AdminFeature, 'key' | 'group' | 'description'>>(features: readonly F[], q = ''): FeatureGroup<F>[] {
  const groups: FeatureGroup<F>[] = [];
  for (const f of features) {
    if (!matchesFeature(f, q)) continue;
    let g = groups.find((x) => x.group === f.group);
    if (!g) groups.push((g = { group: f.group, features: [] }));
    g.features.push(f);
  }
  return groups;
}

/** "3 of 8 shown" under a filter; "8 features" without one. */
export function shownLabel(shown: number, total: number, q: string): string {
  if (!q.trim()) return `${total} feature${total === 1 ? '' : 's'}`;
  return `${shown} of ${total} shown`;
}

/** What the dropdown button of one user says: how many features are on for them and how many of those values are their own override. */
export function userSummary(features: readonly AdminFeature[], userId: string): { on: number; overridden: number; label: string } {
  const states = features.map((f) => userState(f, userId));
  const on = states.filter((s) => s.value).length;
  const overridden = states.filter((s) => s.source === 'user').length;
  return { on, overridden, label: `${on} of ${features.length} on${overridden ? `, ${overridden} overridden` : ''}` };
}

/** "3 users overridden" / "1 user overridden" / "no overrides". */
export function overridesLabel(feature: Pick<AdminFeature, 'overrides'>): string {
  const n = feature.overrides.length;
  return n === 0 ? 'no overrides' : `${n} user${n === 1 ? '' : 's'} overridden`;
}

/** The feature key in a hash path (`/features/<key>`); null on the list (`/features`). */
export function featureKeyFromPath(path: string): string | null {
  const key = /^\/features\/([^/]+)/.exec(path)?.[1];
  return key ? decodeURIComponent(key) : null;
}

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
export interface Placement {
  left: number;
  width: number;
  maxHeight: number;
  /** Exactly one of top / bottom is set (distance from that viewport edge). */
  top?: number;
  bottom?: number;
}

const POPOVER_WIDTH = 620;
const POPOVER_MAX_HEIGHT = 520;
const POPOVER_MIN_HEIGHT = 260;
const GAP = 4;
const EDGE = 8;

/**
 * Where the dropdown opens (fixed position): right-aligned to its button,
 * kept inside the viewport; below the button, or above it when there is not
 * enough room below and more above.
 */
export function popoverPlacement(button: Box, viewport: { width: number; height: number }): Placement {
  const width = Math.min(POPOVER_WIDTH, viewport.width - 2 * EDGE);
  const left = Math.max(EDGE, Math.min(button.right - width, viewport.width - width - EDGE));
  const below = viewport.height - button.bottom - GAP - EDGE;
  const above = button.top - GAP - EDGE;
  if (below < POPOVER_MIN_HEIGHT && above > below) {
    return { left, width, bottom: viewport.height - button.top + GAP, maxHeight: Math.min(POPOVER_MAX_HEIGHT, above) };
  }
  return { left, width, top: button.bottom + GAP, maxHeight: Math.min(POPOVER_MAX_HEIGHT, below) };
}
