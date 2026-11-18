import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { useService } from '../di/ServiceContext';
import { Tokens } from '../di/tokens';
import { loadAuthHeaders } from '../storage/sessionToken';

/**
 * Auth headers for requests the app does NOT make through fetch (e.g. an
 * image component fetching a protected URL). Same single source of truth as
 * the RTK base query: web rides the httpOnly session cookie (no header —
 * returns `{}` synchronously), native sends the stored Bearer token.
 *
 * Returns `null` while the native token is still loading, so callers can hold
 * off the request instead of firing it unauthenticated.
 */
export function useAuthHeaders(): Record<string, string> | null {
  const storage = useService(Tokens.Storage);
  const isWeb = Platform.OS === 'web';
  const [headers, setHeaders] = useState<Record<string, string> | null>(isWeb ? {} : null);

  useEffect(() => {
    if (isWeb) return;
    let live = true;
    void loadAuthHeaders(storage).then((h) => live && setHeaders(h));
    return () => {
      live = false;
    };
  }, [isWeb, storage]);

  return headers;
}
