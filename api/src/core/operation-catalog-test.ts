/**
 * Shared structural assertions for a feature's operation catalog (test helper,
 * not a test file): every feature's `operations.test.ts` calls this so the
 * invariants are written once. Checks, per operation: unique feature-prefixed
 * snake_case name, a description, every `read` is a GET (read-only OAuth
 * tokens may only issue GET/HEAD/OPTIONS) and mutations are not, destructive
 * operations are never MCP-exposed, every input key has exactly one location,
 * and every api-exposed operation is mounted at its method + path.
 */
import { describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';

import { contracts } from '../catalog';
import type { AnyOperation } from './operation';
import { inputLocations } from '@shared/operation-contract';

export function describeOperationCatalog(feature: string, operations: readonly AnyOperation[], router: Hono, mountPrefix: string): void {
  describe(`${feature} operation catalog`, () => {
    test('is non-empty, unique, snake_case, prefixed, described, and present in server/catalog.ts', () => {
      expect(operations.length).toBeGreaterThan(0);
      const names = operations.map((o) => o.contract.name);
      expect(new Set(names).size).toBe(names.length);
      for (const { contract } of operations) {
        expect(contract.name).toMatch(new RegExp(`^${feature}(_[a-z0-9]+)+$`));
        expect(contract.description.length).toBeGreaterThan(20);
        expect(contracts.includes(contract)).toBe(true);
      }
      const all = contracts.map((c) => c.name);
      expect(new Set(all).size).toBe(all.length);
    });

    test('reads are GET, mutations are not; destructive operations are not MCP-exposed', () => {
      for (const { contract } of operations) {
        if (contract.kind === 'read') expect(contract.method, contract.name).toBe('GET');
        else expect(contract.method, contract.name).not.toBe('GET');
        if (contract.kind === 'destructive') expect(contract.expose.mcp, contract.name).toBe(false);
      }
    });

    test('every input key has exactly one location', () => {
      for (const { contract } of operations) {
        const loc = inputLocations(contract);
        const all = [...loc.path, ...loc.query, ...loc.body, ...(contract.bodyKey ? [contract.bodyKey] : [])];
        expect(new Set(all).size, contract.name).toBe(all.length);
        expect([...all].sort(), contract.name).toEqual(Object.keys(contract.input.shape).sort());
      }
    });

    test('every api-exposed operation is mounted at its method + path', () => {
      const mounted = new Set(router.routes.map((r) => `${r.method} ${mountPrefix}${r.path === '/' ? '' : r.path}`));
      for (const { contract } of operations) {
        if (!contract.expose.api) continue;
        expect(mounted.has(`${contract.method} ${contract.path}`), `${contract.method} ${contract.path}`).toBe(true);
      }
    });
  });
}
