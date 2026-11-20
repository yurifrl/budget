/**
 * The signed-in person's features (`shared/src/features.ts`), for components:
 * `const { 'shared-pluggy-key': canUseSharedKey } = useFeatures()`.
 *
 * The values come evaluated from the API (GET /features: own override, else
 * the everyone value, else the default) and are refetched when the app
 * regains focus. Until the first answer, and if the request fails, every
 * feature is at its default in code. This only decides what to show or hide:
 * the API enforces each feature itself.
 *
 * "Feature" here is never a transaction colour flag (those are `flagLabels`).
 */
import { featureDefaults, type FeatureValues } from '@shared/features';

import { MY_FEATURES_REFETCH, useGetMyFeaturesQuery } from '@/profile/api';

const DEFAULTS: FeatureValues = featureDefaults();

export function useFeatures(): FeatureValues {
  const { data } = useGetMyFeaturesQuery(undefined, MY_FEATURES_REFETCH);
  return data ?? DEFAULTS;
}
