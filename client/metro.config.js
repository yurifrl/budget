// Metro config for consuming ../shared as source (no workspace, no root package.json).
const crypto = require('node:crypto');
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../shared');

const config = getDefaultConfig(projectRoot);

// shared/ lives outside the project root: Metro must watch it to bundle it.
config.watchFolders = [...(config.watchFolders ?? []), sharedRoot];

// `@shared/*` is resolved from tsconfig.json `paths` by Expo's built-in
// tsconfigPaths support. Bare imports inside shared/src (only `zod`) resolve
// hierarchically from the importing file, i.e. shared/node_modules/zod. No
// extra nodeModulesPaths on purpose: a shared/ file importing a client-only
// package (react, expo-*) then fails to bundle instead of silently working.

// Keep Metro's cache per checkout (the default $TMPDIR cache is shared).
const { FileStore } = require('metro-cache');
config.cacheStores = [new FileStore({ root: path.join(projectRoot, '.expo', 'metro-cache') })];

// The expo-constants transform inlines the resolved app config (apiUrl from
// EXPO_PUBLIC_API_URL, version) without keying the cache on it, so an export
// with another EXPO_PUBLIC_API_URL could reuse a stale bundle. Key the cache
// on the resolved public config (carried from syscd-app's metro.config.js).
function configFingerprint() {
  try {
    const { getConfig } = require('@expo/config');
    const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true, isPublicConfig: true });
    // The build number / versionCode change on every evaluation; leave them out.
    const { ios = {}, android = {}, ...rest } = exp;
    const { buildNumber: _b, ...iosRest } = ios;
    const { versionCode: _v, ...androidRest } = android;
    return JSON.stringify({ ...rest, ios: iosRest, android: androidRest });
  } catch {
    return JSON.stringify(Object.entries(process.env).filter(([k]) => k.startsWith('EXPO_PUBLIC_')));
  }
}

config.cacheVersion = crypto.createHash('sha1').update(configFingerprint()).digest('hex').slice(0, 10);

module.exports = config;
