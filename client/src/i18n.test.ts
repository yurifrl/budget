/**
 * Catalog test: every namespace (`**\/i18n/index.ts` under src/, plus the shared
 * `common` and `errors`) has the same keys, placeholders and plural shape in en
 * and pt-BR, no empty values, no unexplained identical pt-BR text, and no key
 * that no source file mentions. Rules: shared/src/i18n/check.ts, docs/i18n.md.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { registry } from '@shared/i18n';
import { checkCatalogs } from '@shared/i18n/check';
import '@shared/i18n/common';
import '@shared/i18n/errors';

const SRC = path.join(import.meta.dir);
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

describe('i18n catalogs (client)', () => {
  test('finds the namespaces it expects', () => {
    const names = registry().map((ns) => ns.name);
    expect(names).toContain('common');
    expect(names).toContain('errors');
    expect(names).toContain('settings');
    // One namespace per i18n/index.ts under src/ (plus the two shared ones).
    expect(names.length).toBeGreaterThanOrEqual(catalogIndexes.length + 2);
  });

  test('every catalog is sound', () => {
    expect(checkCatalogs(registry(), packageSources())).toEqual([]);
  });
});
