// Metro config for consuming ../shared as source (no workspace, no root package.json).
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

module.exports = config;
