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
  return useFeaturesState().values;
}

/**
 * The values plus whether they are the API's answer yet: 'loading' before
 * the first answer, 'failed' when it could not be read (values are then the
 * defaults), 'ready' otherwise. For a screen that must not act on a default
 * it has not confirmed (e.g. sending someone away from a flow).
 */
export function useFeaturesState(): { values: FeatureValues; status: 'loading' | 'ready' | 'failed' } {
  const { data, isError } = useGetMyFeaturesQuery(undefined, MY_FEATURES_REFETCH);
  if (data) return { values: data, status: 'ready' };
  return { values: DEFAULTS, status: isError ? 'failed' : 'loading' };
}
