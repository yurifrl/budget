/**
 * Guard: budget route files hold no SQL. SQL lives in budget/store/*.ts (or
 * budget/domain); a route parses, authorises, calls the store and shapes the
 * response. Fails on a `.query(` call or an SQL statement inside a string or
 * template literal in any non-test file under budget/routes/.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, 'routes');
const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const SQL_STATEMENT = /\b(SELECT\s[\s\S]*?\bFROM|INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[\w."]+\s+SET|WITH\s+\w+\s+AS\s*\()/i;
const QUERY_CALL = /\.query\s*[<(]/;

describe('budget routes contain no SQL', () => {
  test('there are route files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const f of files) {
    test(f, () => {
      const src = stripComments(readFileSync(join(dir, f), 'utf8'));
      expect(QUERY_CALL.test(src), `${f} calls .query(); move it to budget/store`).toBe(false);
      const literals = src.match(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g) ?? [];
      const hit = literals.find((l) => SQL_STATEMENT.test(l));
      expect(hit, `${f} contains an SQL string; move it to budget/store`).toBeUndefined();
    });
  }
});
