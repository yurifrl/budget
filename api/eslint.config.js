// @ts-check
import fs from 'node:fs';
import { defineConfig } from 'eslint/config';
import importPlugin from 'eslint-plugin-import';
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

// Feature trees: every directory under src/ except the shared core/.
const features = fs
  .readdirSync('./src')
  .filter((f) => fs.statSync(`./src/${f}`).isDirectory() && f !== 'core');

/**
 * What `feature` may import from `other` (paths relative to src/<other>):
 * the public barrel only, plus the documented seams.
 *
 * - connections -> budget/domain: the sync balance-write path (sync.ts).
 * - Workflow seam: Temporal bundles ONE workflow file (jobs/workflows/index.ts)
 *   in a sandbox that cannot load a feature barrel (pg, hono), so jobs
 *   re-exports each feature's pure `workflows.ts`, and that file imports the
 *   shared plumbing `jobs/workflows/tracked.ts`.
 */
function allowedFrom(feature, other) {
  if (feature === 'connections' && other === 'budget') return ['domain', 'index.ts'];
  if (feature === 'jobs' && other === 'connections') return ['index.ts', 'workflows.ts'];
  if (feature === 'connections' && other === 'jobs') return ['index.ts', 'workflows/tracked.ts'];
  return ['index.ts'];
}

export default defineConfig([
  { ignores: ['node_modules/**', 'dist/**'] },
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  ...tseslint.configs.recommended,
  { files: ['**/*.ts'], rules: noDirectZod },
  // The copied server code was linted with eslint-config-expo, which is looser
  // than typescript-eslint's recommended set: keep these as warnings/off so
  // the move stays a move (phase 5 tightens them).
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['off', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': { typescript: { project: './tsconfig.json' }, node: true },
      // `bun:test` resolves at runtime (bun), not through node_modules.
      'import/core-modules': ['bun:test'],
    },
  },
  // core/ is cross-cutting infrastructure: it may never import a feature.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: features.map((feature) => ({
            target: './src/core',
            from: `./src/${feature}`,
            message: 'core/ must not import from features. Dependencies flow features -> core only.',
          })),
        },
      ],
    },
  },
  // A feature imports core/*, its own internals, and another feature's public
  // barrel only. Entrypoints (src/*.ts, the composition root app.ts) are exempt.
  {
    files: features.map((f) => `src/${f}/**/*.ts`),
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: features.flatMap((feature) =>
            features
              .filter((other) => other !== feature)
              .map((other) => ({
                target: `./src/${feature}`,
                from: `./src/${other}`,
                except: allowedFrom(feature, other),
                message: 'Features may only import another feature via its public barrel (src/<name>/index.ts), never its internals.',
              })),
          ),
        },
      ],
    },
  },
]);
