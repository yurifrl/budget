/**
 * May "Connect a bank" open the widget right now (rules: connectGate in
 * pluggyKeys.logic.ts)? Reads the user's own key status and the
 * 'shared-pluggy-key' feature.
 */

import { useGetConnectionCredentialsQuery } from '@/budget/data/api';
import { loadConfig } from '@/platform/config';
import { useFeaturesState } from '@/state/useFeatures';
import { connectGate, SHARED_KEY_FEATURE, type ConnectGate } from './pluggyKeys.logic';

export function useConnectGate(): ConnectGate {
  const credentials = useGetConnectionCredentialsQuery({ provider: loadConfig().connectionsProvider });
  const features = useFeaturesState();
  return connectGate({
    credentials: credentials.data,
    credentialsLoading: credentials.isLoading,
    sharedKey: { allowed: features.values[SHARED_KEY_FEATURE], status: features.status },
  });
}
