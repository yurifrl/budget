import fs from 'node:fs';
import path from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// expo evaluates the config as CommonJS, so `__dirname` is defined at
// runtime; bun-types doesn't declare node globals for it.
declare const __dirname: string;

/**
 * App release version: `client/VERSION`, `YYYY.MM.DD` with an optional
 * two-digit same-day suffix (`-01`, `-02`, …). Carried from syscd-app's
 * app.config.ts. The pattern is inlined because expo's config loader has no
 * `.ts` require hook. App Store Connect needs a three-integer marketing
 * version, so the suffix is stripped for `ios.version`; the build number keeps
 * every build unique.
 */
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}(-\d{2})?$/;

function readAppVersion(): string {
  const version = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
  if (!VERSION_PATTERN.test(version))
    throw new Error(`VERSION must be YYYY.MM.DD[-NN] (e.g. 2026.11.07 or 2026.11.07-01), got "${version}"`);
  return version;
}

const VERSION = readAppVersion();

// `toISOString()` is always UTC: `2026-10-18T21:30:45.123Z`.
const NOW = new Date();
const [UTC_DATE, UTC_TIME] = NOW.toISOString().split('T') as [string, string];

/**
 * iOS build number (CFBundleVersion): the UTC timestamp of the build request,
 * `YYYYMMDDHHMMSS`, unique and strictly increasing.
 */
const BUILD_NUMBER = UTC_DATE.replaceAll('-', '') + UTC_TIME.slice(0, 8).replaceAll(':', '');

/**
 * API base URL: `EXPO_PUBLIC_API_URL` when set (shell/.env for dev, an EAS env
 * var for builds). Unset, `platform/config.ts` falls back to
 * `http://localhost:3100` in dev and `https://budget-api.syscd.live` in
 * release builds.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Budget',
  slug: 'budget',
  scheme: 'budgetapp',
  owner: 'yurifrl',
  version: VERSION,
  orientation: 'portrait',
  // App icon and web favicon: syscd-app's assets/images (icon.png, favicon.png).
  icon: './assets/images/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'live.syscd.budget',
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
    // ASC only accepts an `X.Y.Z` marketing version.
    version: VERSION.replace(/-\d{2}$/, ''),
    buildNumber: BUILD_NUMBER,
  },
  // Kept configured; not built in this phase.
  android: {
    package: 'live.syscd.budget',
    predictiveBackGestureEnabled: false,
    // Epoch seconds fit Android's 2^31 versionCode cap until 2036.
    versionCode: Math.floor(NOW.getTime() / 1000),
  },
  web: { output: 'single', favicon: './assets/images/favicon.png' },
  plugins: ['expo-router', 'expo-image', 'expo-sharing', 'expo-status-bar', 'expo-web-browser'],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    router: {},
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    connectionsProvider: process.env.EXPO_PUBLIC_CONNECTIONS_PROVIDER ?? 'pluggy',
    // eas.projectId: set once the owner creates the EAS project.
  },
});
