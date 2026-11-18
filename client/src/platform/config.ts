import Constants from 'expo-constants';

/** Resolved application configuration, sourced from Expo config `extra`. */
export interface AppConfig {
  apiUrl: string;
  /** Registered bank-connections provider name (server adapter registry key). */
  connectionsProvider: string;
}

type RawExtra = {
  apiUrl?: string;
  connectionsProvider?: string;
};

/** API base URL when nothing is configured: local API in dev, the hosted API in release builds. */
const DEV_API_URL = 'http://localhost:3100';
const PROD_API_URL = 'https://budget-api.syscd.live';
const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : true;

/**
 * Read configuration from Expo config (`expo-constants`).
 *
 * The API base URL comes from `expo.extra.apiUrl` (see app.config.ts),
 * which is populated from `EXPO_PUBLIC_API_URL` at build time. Unset, it
 * defaults to `http://localhost:3100` in dev and
 * `https://budget-api.syscd.live` in release builds.
 */
export function loadConfig(): AppConfig {
  const extra = (Constants.expoConfig?.extra ?? {}) as RawExtra;
  return {
    apiUrl:
      extra.apiUrl || process.env.EXPO_PUBLIC_API_URL || (isDev ? DEV_API_URL : PROD_API_URL),
    connectionsProvider:
      extra.connectionsProvider ||
      process.env.EXPO_PUBLIC_CONNECTIONS_PROVIDER ||
      'pluggy',
  };
}
