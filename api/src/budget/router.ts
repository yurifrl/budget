/**
 * Mounts a budget route file's operations as a Hono router. Every budget-data
 * route sits behind `budgetAccess` (owner-or-admin, cross-owner = 404);
 * `guarded: false` is only for the budgets router, whose handlers scope by
 * owner in SQL themselves.
 */
import { Hono } from 'hono';

import { mountOperations, type AnyOperation } from '../core/operation';
import { budgetAccess } from './ownership';

export function budgetRouter(basePath: string, ops: readonly AnyOperation[], options: { guarded?: boolean } = {}): Hono {
  return mountOperations(new Hono(), ops, {
    basePath,
    use: options.guarded === false ? [] : [budgetAccess],
  });
}
