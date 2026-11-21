// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

import i18nManifest from '../shared/eslint/i18n-manifest.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  // i18n: `budget-i18n/no-untranslated-string` as an error on the union of the
  // file sets listed in i18n-enforced/*.json (docs/i18n.md). Nobody edits this.
  ...i18nManifest.i18nConfigs(path.join(here, 'i18n-enforced')),
]);
