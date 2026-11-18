// https://docs.expo.dev/guides/using-eslint/
/* global __dirname */
const { readdirSync } = require('node:fs');
const path = require('node:path');
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

/** zod lives in shared/ only; everything else imports it via @shared/zod. */
const zodMessage = "Import zod from '@shared/zod' (shared/ owns the one zod instance).";
const zodPaths = [{ name: 'zod', message: zodMessage }];
const zodPatterns = [{ group: ['zod/*'], message: zodMessage }];

/**
 * Layering (client/src), see docs/architecture.md:
 *
 *   app → shell → features → {state, data} → ui → domain
 *                                    ↘ platform ↙
 *
 * - `app/` is routes + the composition root; it may import anything. Route
 *   stubs import feature barrels.
 * - `shell/` (responsive layout, rail, settings menu host, runtime) may import
 *   features only through their barrels.
 * - `features/<x>/` may import another feature only through its barrel
 *   (`features/<y>/index.ts`), and of the shell only its contexts
 *   (`shell/context.ts`, `shell/menuNav.ts`).
 * - `state/` (store, budgetUi slice, plan-edit history, store-backed hooks)
 *   and the data layer (`budget/data/`, `profile/{api,model}.ts`, and the
 *   re-export shims `budget/{domain,state,import}` kept for data/)
 *   know no feature, shell or app.
 * - `ui/` (theme, primitives, pickers, avatar) imports only `domain/` and
 *   `platform/`; `platform/` imports nothing from the app.
 * - `domain/` imports only itself and `@shared/*`, and no React/RN/Expo.
 * - Nothing imports the API package (`../api`). Cycles: src/architecture.test.ts.
 */
const SRC = './src';
const FEATURES = readdirSync(path.join(__dirname, 'src/features'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const zone = (target, from, message, except) => ({
  target: `${SRC}/${target}`,
  from: `${SRC}/${from}`,
  message,
  ...(except ? { except } : {}),
});
const below = (target, froms, why) =>
  froms.map((from) => zone(target, from, `Layering: ${target}/ may not import ${from}/ (${why}).`));

const DATA = ['budget', 'profile'];
const layerZones = [
  { target: '.', from: '../api', message: 'client/ never imports the API package. Share code through ../shared (@shared/*).' },
  ...below('shell', ['app'], 'only routes import the shell'),
  ...FEATURES.flatMap((f) => [
    ...below(`features/${f}`, ['app'], 'features never import routes'),
    zone(`features/${f}`, 'shell', 'Layering: a feature may import only the shell contexts (shell/context.ts, shell/menuNav.ts).', [
      'context.ts',
      'menuNav.ts',
    ]),
    ...FEATURES.filter((o) => o !== f).map((o) =>
      zone(`features/${f}`, `features/${o}`, `Features import each other only through the barrel: '@/features/${o}'.`, ['index.ts']),
    ),
  ]),
  ...FEATURES.map((f) => zone('shell', `features/${f}`, `The shell imports features only through the barrel: '@/features/${f}'.`, ['index.ts'])),
  ...below('state', ['app', 'shell', 'features', 'ui'], 'state sits below features and knows no UI'),
  ...DATA.flatMap((d) => below(d, ['app', 'shell', 'features', 'ui'], 'the data layer knows no feature or UI')),
  ...below('ui', ['app', 'shell', 'features', 'state', ...DATA], 'ui imports only domain and platform'),
  ...below('platform', ['app', 'shell', 'features', 'state', ...DATA, 'ui', 'domain'], 'platform imports nothing from the app'),
];

/** domain/ is pure: only itself and @shared. */
const domainZones = ['app', 'shell', 'features', 'state', 'ui', 'platform', ...DATA].map((from) =>
  zone('domain', from, `domain/ must stay pure: it may not import ${from}/ (imports only itself and @shared).`),
);
const reactNativeMessage = 'domain/ must stay pure: no react-native, expo or React imports.';

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
    files: ['src/domain/**/*.{ts,tsx}'],
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
      'import/no-restricted-paths': ['error', { zones: [...layerZones, ...domainZones] }],
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
]);
