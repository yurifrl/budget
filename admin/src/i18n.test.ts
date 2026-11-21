/// <reference types="bun" />
/**
 * Catalog test (same shape as client/src/i18n.test.ts): every `i18n/index.ts`
 * under src/ plus the shared `common` and `errors` namespaces have matching
 * keys, placeholders and plural shapes in en and pt-BR, and no unused key.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { registry } from '@shared/i18n';
import { checkCatalogs } from '@shared/i18n/check';
import '@shared/i18n/common';
import '@shared/i18n/errors';

const SRC = import.meta.dir;
const catalogIndexes = [...new Bun.Glob('**/i18n/index.ts').scanSync({ cwd: SRC })].sort();
await Promise.all(catalogIndexes.map((file) => import(path.join(SRC, file))));

/** Source text outside i18n/ directories, tests and fixtures: where a key must be mentioned. */
function packageSources(): string {
  const parts: string[] = [];
  for (const file of new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: SRC })) {
    const normalized = file.replaceAll('\\', '/');
    if (/(^|\/)i18n\//.test(normalized) || /\.test\.tsx?$/.test(normalized) || /(^|\/)__fixtures__\//.test(normalized)) continue;
    parts.push(readFileSync(path.join(SRC, file), 'utf8'));
  }
  return parts.join('\n');
}

describe('i18n catalogs (admin)', () => {
  test('registers the admin namespace and the shared ones', () => {
    const names = registry().map((ns) => ns.name);
    expect(names).toContain('admin');
    expect(names).toContain('common');
    expect(names).toContain('errors');
  });

  test('every catalog is sound', () => {
    expect(checkCatalogs(registry(), packageSources())).toEqual([]);
  });
});
