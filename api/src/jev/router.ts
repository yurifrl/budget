/**
 * The Jev key routes, mounted at /jev behind requireUser (the caller's own
 * key only: no id to pass, no budget involved).
 */
import type { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';

import { mountOperations } from '../core/operation';
import type { AnyOperation } from '../core/operation';
import { requireUserId } from '../user';

const requireIdentity: MiddlewareHandler = async (c, next) => {
  requireUserId(c);
  await next();
};

export function jevRouter(router: Hono, ops: readonly AnyOperation[]): Hono {
  return mountOperations(router, ops, { basePath: '/jev', use: [requireIdentity] });
}
