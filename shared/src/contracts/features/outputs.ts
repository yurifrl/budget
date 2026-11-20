/** Response row schemas of the features contracts. */
import { z } from '../../zod';

/**
 * The caller's own evaluated features: every key the API knows, on or off
 * (user override, else the everyone value, else the default in code). A
 * client reads it through `withFeatureDefaults` (`shared/src/features.ts`).
 */
export const myFeaturesSchema = z.object({ features: z.record(z.string(), z.boolean()) });
export type MyFeatures = z.infer<typeof myFeaturesSchema>;

/** Who changed a value; null once that user row is gone. */
export const featureChangedBySchema = z.object({ id: z.string(), email: z.string().nullable(), name: z.string().nullable() });

/** A stored value with who set it and when (ISO timestamp). */
export const featureValueSchema = z.object({
  value: z.boolean(),
  changed_by: featureChangedBySchema.nullable(),
  changed_at: z.string(),
});
export type FeatureValue = z.infer<typeof featureValueSchema>;

/** One person's override of a feature. */
export const featureUserOverrideSchema = featureValueSchema.extend({ user_id: z.string() });
export type FeatureUserOverride = z.infer<typeof featureUserOverrideSchema>;

/** A feature from the list in code plus what is stored for it. */
export const adminFeatureSchema = z.object({
  key: z.string(),
  /** Short label the admin groups features under. */
  group: z.string(),
  description: z.string(),
  /** The default in code. */
  default: z.boolean(),
  /** The value for everyone; null = none stored (the default applies). */
  everyone: featureValueSchema.nullable(),
  /** Per-user overrides; a user not listed inherits the everyone value or the default. */
  overrides: z.array(featureUserOverrideSchema),
});
export type AdminFeature = z.infer<typeof adminFeatureSchema>;
