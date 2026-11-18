/**
 * Mounts connections operations under /connections. Every one is user-scoped:
 * the identity is resolved first (401 before any input validation, the order
 * the hand-written routes had) and handlers scope their queries by it, so a
 * foreign connection id is indistinguishable from an unknown one (404).
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';

import { mountOperations, type AnyOperation } from '../core/operation';
import { requireUserId } from '../user';

const requireIdentity: MiddlewareHandler = async (c, next) => {
  requireUserId(c);
  await next();
};

export function connectionsRouter(router: Hono, ops: readonly AnyOperation[]): Hono {
  return mountOperations(router, ops, { basePath: '/connections', use: [requireIdentity] });
}
