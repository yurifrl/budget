// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

/** zod lives in shared/ only; everything else imports it via @shared/zod. */
const zodMessage = "Import zod from '@shared/zod' (shared/ owns the one zod instance).";
const zodPaths = [{ name: 'zod', message: zodMessage }];
const zodPatterns = [{ group: ['zod/*'], message: zodMessage }];

/**
 * Layering (client/src):
 *
 *   app → store → {auth, profile, budget} → shell → ui → platform
 *
 * - `app/` is routes + the composition root; it may import anything.
 * - `store/` builds the static store from the features' slices. Features may
 *   import only `store/hooks.ts` (the typed hooks; RootState is type-only).
 * - Features (`auth`, `profile`, `budget`) import another feature only through
 *   its public barrel (`<feature>/index.ts`).
 * - `shell/` (settings menu host) knows no feature; `ui/` knows no feature or
 *   shell; `platform/` imports nothing from the app.
 * - Nothing imports the API package (`../api`).
 */
const SRC = './src';
const FEATURES = ['auth', 'profile', 'budget'];

const layerMessage = (target, from) =>
  `Layering: ${target}/ may not import ${from}/ (app → store → auth/profile/budget → shell → ui → platform).`;

/** Zones forbidding `target` to import from each of `froms`. */
function forbid(target, froms) {
  return froms.map((from) => {
    const zone = { target: `${SRC}/${target}`, from: `${SRC}/${from}`, message: layerMessage(target, from) };
    // Only features get the store/hooks.ts and feature-barrel allowances.
    if (FEATURES.includes(target) && from === 'store') zone.except = ['hooks.ts'];
    if (FEATURES.includes(target) && FEATURES.includes(from)) zone.except = ['index.ts', 'index.tsx'];
    if (zone.except) zone.message += ` Allowed: ${from}/${zone.except.join(', ')}.`;
    return zone;
  });
}

const apiZone = {
  target: '.',
  from: '../api',
  message: 'client/ never imports the API package. Share code through ../shared (@shared/*).',
};

const layerZones = [
  apiZone,
  ...forbid('store', ['app']),
  ...FEATURES.flatMap((f) => forbid(f, ['app', 'store', ...FEATURES.filter((o) => o !== f)])),
  ...forbid('shell', ['app', 'store', ...FEATURES]),
  ...forbid('ui', ['app', 'store', ...FEATURES, 'shell']),
  ...forbid('platform', ['app', 'store', ...FEATURES, 'shell', 'ui']),
];

/**
 * budget/domain is pure: no React Native / Expo / React, and no imports from
 * the rest of the client (only itself and @shared). No exceptions.
 */
const DOMAIN = `${SRC}/budget/domain`;
const domainForbidden = [
  'budget/data',
  'budget/state',
  'budget/model',
  'budget/import',
  'budget/transfer',
  'budget/ui',
  'budget/screens',
  'ui',
  'platform',
];
const domainZones = () =>
  domainForbidden
    .map((from) => ({
      target: DOMAIN,
      from: `${SRC}/${from}`,
      message: `budget/domain must stay pure: it may not import ${from}/ (imports only itself and @shared).`,
    }));

const reactNativeMessage = 'budget/domain must stay pure: no react-native, expo or React imports.';

module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/**', '.expo/**', 'ios/**', 'android/**', 'node_modules/**'] },
  // `bun:test` resolves at runtime (bun), not through node_modules.
  { files: ['**/*.test.{ts,tsx}'], settings: { 'import/core-modules': ['bun:test'] } },
  {
    rules: {
      'no-restricted-imports': ['error', { paths: zodPaths, patterns: zodPatterns }],
      'import/no-restricted-paths': ['error', { zones: layerZones }],
    },
  },
  {
    files: ['src/budget/domain/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...zodPaths, { name: 'react', message: reactNativeMessage }],
          patterns: [
            ...zodPatterns,
            { group: ['react-native', 'react-native/*', 'react-native-*', 'expo', 'expo-*', '@expo/*', 'react-dom'], message: reactNativeMessage },
          ],
        },
      ],
      'import/no-restricted-paths': ['error', { zones: [...layerZones, ...domainZones()] }],
    },
  },
  // Same as syscd-app: eslint-plugin-react-hooks v7 (via eslint-config-expo
  // 58) ships experimental compiler rules that reject canonical RN patterns
  // this code relies on (Animated `useRef(new Value()).current`, latest-ref
  // writes in render, mount-time refresh effects). Re-enable once the code
  // migrates to the react-compiler idiom.
  {
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
    },
  },
  // Temporary (phase 5a, removed when domain/ moves to src/domain in 5e):
  // the avatar types' one definition is in budget/domain, and the one theme
  // uses domain types.
  {
    files: ['src/ui/avatar/types.ts', 'src/ui/theme.ts', 'src/ui/moneyFormat.tsx'],
    rules: {
      'import/no-restricted-paths': [
        'error',
        { zones: layerZones.map((z) => (z.target === `${SRC}/ui` && z.from === `${SRC}/budget` ? { ...z, except: ['domain/avatar.ts', 'domain/types.ts', 'domain/format.ts'] } : z)) },
      ],
    },
  },
]);
