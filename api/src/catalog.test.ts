/**
 * The contracts catalog must stay consumable by the CLI, MCP and the Expo app:
 * no server-only code in its import graph, and it must list exactly the
 * contracts the features actually serve.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { contracts } from './catalog';

describe('contracts catalog', () => {
  test('browser-target bundle contains no hono or pg', async () => {
    const outdir = mkdtempSync(join(tmpdir(), 'catalog-bundle-'));
    try {
      const result = await Bun.build({ entrypoints: [join(import.meta.dir, 'catalog.ts')], target: 'browser', outdir });
      expect(result.success).toBe(true);
      const code = readFileSync(join(outdir, 'catalog.js'), 'utf8');
      expect(code).not.toMatch(/hono/i);
      expect(code).not.toMatch(/node_modules\/pg\b|from "pg"|DATABASE_URL/);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  test('lists exactly the contracts of every feature operation, names unique', async () => {
    const features = await Promise.all([
      import('./budget'),
      import('./categorize/routes'),
      import('./connections'),
      import('./features'),
      import('./jobs'),
      import('./oauth'),
      import('./rates'),
      import('./user'),
    ]);
    const served = features.flatMap((f) => f.operations.map((o) => o.contract));
    expect(new Set(contracts).size).toBe(contracts.length);
    expect(new Set(contracts.map((c) => c.name)).size).toBe(contracts.length);
    expect(new Set(contracts)).toEqual(new Set(served));
  });
});
