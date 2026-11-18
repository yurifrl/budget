// @ts-check
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const msg = "zod is imported only by src/zod.ts; everything else imports it from there (one zod instance).";

export default defineConfig([
  { ignores: ['node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'zod', message: msg }], patterns: [{ group: ['zod/*'], message: msg }] },
      ],
    },
  },
  // shared/ is pure: no node:*, hono, pg, react.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'zod', message: msg }],
          patterns: [
            { group: ['zod/*'], message: msg },
            { group: ['node:*', 'hono', 'hono/*', 'pg', 'react', 'react-native'], message: 'shared/ is pure TypeScript: zod only.' },
          ],
        },
      ],
    },
  },
  { files: ['src/zod.ts'], rules: { 'no-restricted-imports': 'off' } },
]);
