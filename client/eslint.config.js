// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

/** zod lives in shared/ only; everything else imports it via @shared/zod. */
const zodMessage = "Import zod from '@shared/zod' (shared/ owns the one zod instance).";

module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/**', '.expo/**', 'ios/**', 'android/**', 'node_modules/**'] },
  // `bun:test` resolves at runtime (bun), not through node_modules.
  { files: ['**/*.test.{ts,tsx}'], settings: { 'import/core-modules': ['bun:test'] } },
  {
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'zod', message: zodMessage }], patterns: [{ group: ['zod/*'], message: zodMessage }] },
      ],
    },
  },
]);
