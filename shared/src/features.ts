/**
 * Features: the things an installation can turn on or off, for everyone or
 * for one person. This list is the only place a feature is created: nothing
 * creates one at runtime, and a key stored in the database that is no longer
 * listed here is ignored.
 *
 * A value is on or off. Resolution order: the person's own override, else the
 * "everyone" value, else `default` below (`resolveFeature`). The API enforces
 * (`isEnabled` in api/src/features); a client only shows or hides.
 *
 * Naming: always "feature", never "flag" (in the client a flag is a
 * transaction colour).
 */
import { z } from './zod';

export interface FeatureDefinition {
  readonly key: string;
  /** Short label the admin groups features under, e.g. "Banks". Reuse an existing one where it fits. */
  readonly group: string;
  /** One sentence shown to the admin: what a person with the feature on may do. */
  readonly description: string;
  /** The value when neither the person nor "everyone" has one. */
  readonly default: boolean;
}

export const FEATURES = [
  {
    key: 'shared-pluggy-key',
    group: 'Banks',
    description: "May connect and sync banks with the installation's shared Pluggy keys.",
    default: false,
  },
] as const satisfies readonly FeatureDefinition[];

export type FeatureKey = (typeof FEATURES)[number]['key'];

/** Every feature's value for one person. */
export type FeatureValues = Record<FeatureKey, boolean>;

export const FEATURE_KEYS = FEATURES.map((f) => f.key) as [FeatureKey, ...FeatureKey[]];

export const featureKeySchema = z.enum(FEATURE_KEYS);

export const isFeatureKey = (value: string): value is FeatureKey => (FEATURE_KEYS as readonly string[]).includes(value);

export function featureDefinition(key: FeatureKey): FeatureDefinition {
  return FEATURES.find((f) => f.key === key)!;
}

/** Where a person's value comes from. */
export type FeatureSource = 'user' | 'everyone' | 'default';

/** Stored values for one feature and one person; null or undefined = none stored. */
export interface FeatureStored {
  everyone?: boolean | null;
  user?: boolean | null;
}

export function featureSource(stored: FeatureStored): FeatureSource {
  if (typeof stored.user === 'boolean') return 'user';
  if (typeof stored.everyone === 'boolean') return 'everyone';
  return 'default';
}

/** The one resolution rule: user override, else the everyone value, else the given default. */
export function resolveFeatureValue(defaultValue: boolean, stored: FeatureStored = {}): boolean {
  if (typeof stored.user === 'boolean') return stored.user;
  if (typeof stored.everyone === 'boolean') return stored.everyone;
  return defaultValue;
}

/** A listed feature's value for one person: `resolveFeatureValue` with the default in code. */
export function resolveFeature(key: FeatureKey, stored: FeatureStored = {}): boolean {
  return resolveFeatureValue(featureDefinition(key).default, stored);
}

/** Every feature at its default in code (what a client assumes before the API answered). */
export function featureDefaults(): FeatureValues {
  return Object.fromEntries(FEATURES.map((f) => [f.key, f.default])) as FeatureValues;
}

/**
 * Values received from the API laid over the defaults: unknown keys are
 * dropped and missing ones fall back to the default, so a client and an API
 * of different versions still agree on every key the client knows.
 */
export function withFeatureDefaults(received: Readonly<Record<string, unknown>> | null | undefined): FeatureValues {
  const values = featureDefaults();
  for (const key of FEATURE_KEYS) {
    const value = received?.[key];
    if (typeof value === 'boolean') values[key] = value;
  }
  return values;
}
