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

/**
 * `WEB_RELEASE_VERSION` overrides `client/VERSION` for the web export only:
 * the web image ships with the server release, so deploy/Dockerfile.web sets
 * it to `api/VERSION` and the menu shows the server version on web. Native
 * builds (EAS) never set it, so the iOS app keeps its own `client/VERSION`.
 */
function readAppVersion(): string {
  const version = (
    process.env.WEB_RELEASE_VERSION || fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8')
  ).trim();
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
  // App icon: the "Sealed" mark in assets/images. Web favicon: the bare envelope
  // mark (transparent), rendered from admin/public/favicon.svg.
  icon: './assets/images/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'live.syscd.budget',
    icon: {
      light: './assets/images/icon.png',
      dark: './assets/images/icon-dark.png',
      tinted: './assets/images/icon-tinted.png',
    },
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // Languages the app ships (shared/src/i18n LOCALES); lets iOS offer them in per-app language settings.
      CFBundleLocalizations: ['en', 'pt-BR'],
    },
    // ASC only accepts an `X.Y.Z` marketing version.
    version: VERSION.replace(/-\d{2}$/, ''),
    buildNumber: BUILD_NUMBER,
  },
  // Kept configured; not built in this phase.
  android: {
    package: 'live.syscd.budget',
    adaptiveIcon: {
      foregroundImage: './assets/images/adaptive-foreground.png',
      backgroundColor: '#0c0f16',
    },
    predictiveBackGestureEnabled: false,
    // Epoch seconds fit Android's 2^31 versionCode cap until 2036.
    versionCode: Math.floor(NOW.getTime() / 1000),
  },
  web: { output: 'single', favicon: './assets/images/favicon.png' },
  plugins: ['expo-router', 'expo-image', 'expo-localization', 'expo-sharing', 'expo-status-bar', 'expo-web-browser'],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    router: {},
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    connectionsProvider: process.env.EXPO_PUBLIC_CONNECTIONS_PROVIDER ?? 'pluggy',
    // eas.projectId: set once the owner creates the EAS project.
    eas: {
      projectId: "50bed3e7-7524-4497-9b9d-e4fdd6bad820"
    },
  },
});
