// @ts-check
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** zod lives in shared/ only; everything else imports it via @shared/zod. */
export const noDirectZod = {
  'no-restricted-imports': [
    'error',
    {
      paths: [{ name: 'zod', message: "Import zod from '@shared/zod' (shared/ owns the one zod instance)." }],
      patterns: [{ group: ['zod/*'], message: "Import zod from '@shared/zod' (shared/ owns the one zod instance)." }],
    },
  ],
};

export default defineConfig([
  { ignores: ['node_modules/**', 'dist/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.ts'], rules: noDirectZod },
]);
