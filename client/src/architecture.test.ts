/**
 * Architecture guards that ESLint's import rules cannot express:
 *
 * 1. No import cycles anywhere under src/ (runtime imports; `import type`
 *    and `export type` lines are erased and cannot form a runtime cycle).
 * 2. The pure domain imports only itself and `@shared/*`.
 *
 * Resolution follows tsconfig's `@/*` -> `src/*`, Metro's platform suffixes
 * (`.native`, `.web`, `.ios`) and `index` files.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dir);
const DOMAIN_DIRS = ['domain'];
const EXTS = ['.ts', '.tsx', '.native.ts', '.native.tsx', '.web.ts', '.web.tsx', '.ios.ts', '.ios.tsx'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const IMPORT_RE = /^\s*(import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

function specifiers(src: string): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = [];
  for (const m of src.matchAll(IMPORT_RE)) out.push({ spec: m[3], typeOnly: Boolean(m[2]) });
  return out;
}

function resolveSpec(from: string, spec: string): string[] {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return [];
  const hits: string[] = [];
  if (existsSync(base) && statSync(base).isFile()) hits.push(base);
  for (const ext of EXTS) if (existsSync(base + ext)) hits.push(base + ext);
  if (hits.length === 0) for (const ext of EXTS) if (existsSync(join(base, 'index' + ext))) hits.push(join(base, 'index' + ext));
  return hits;
}

const files = walk(SRC).filter((f) => !/\.test\.tsx?$/.test(f));
const graph = new Map<string, string[]>();
for (const f of files) {
  const deps = specifiers(readFileSync(f, 'utf8'))
    .filter((s) => !s.typeOnly)
    .flatMap((s) => resolveSpec(f, s.spec));
  graph.set(f, deps);
}

/** Tarjan's strongly connected components; every SCC with >1 node is a cycle. */
function cycles(g: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const on = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const out: string[][] = [];
  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    on.add(v);
    for (const w of g.get(v) ?? []) {
      if (!g.has(w)) continue;
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1 || (g.get(v) ?? []).includes(v)) out.push(scc.map((p) => relative(SRC, p)).sort());
    }
  };
  for (const v of g.keys()) if (!idx.has(v)) strong(v);
  return out;
}

describe('architecture', () => {
  test('no runtime import cycles under src/', () => {
    expect(cycles(graph)).toEqual([]);
  });

  test('the domain imports only itself and @shared/*', () => {
    const bad: string[] = [];
    for (const dir of DOMAIN_DIRS) {
      const root = join(SRC, dir);
      for (const f of walk(root)) {
        for (const { spec } of specifiers(readFileSync(f, 'utf8'))) {
          if (spec.startsWith('@shared/') || spec === 'bun:test') continue;
          const inside = spec.startsWith('.') && resolve(dirname(f), spec).startsWith(root);
          if (!inside) bad.push(`${relative(SRC, f)} -> ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
