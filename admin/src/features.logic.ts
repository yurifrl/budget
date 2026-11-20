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

/** How many of the features are on for this user, and how many of those values are their own override. */
export function userSummary(features: readonly AdminFeature[], userId: string): { on: number; overridden: number; label: string } {
  const states = features.map((f) => userState(f, userId));
  const on = states.filter((s) => s.value).length;
  const overridden = states.filter((s) => s.source === 'user').length;
  return { on, overridden, label: `${on} on${overridden ? `, ${overridden} overridden` : ''}` };
}

/** The feature shown on the Features page for a hash path (`/features/<key>`); the first one when the key is missing or unknown. */
export function pickFeature<F extends Pick<AdminFeature, 'key'>>(features: readonly F[], path: string): F | null {
  const key = /^\/features\/([^/]+)/.exec(path)?.[1];
  return features.find((f) => f.key === (key ? decodeURIComponent(key) : '')) ?? features[0] ?? null;
}
