import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { helloGet, type HelloOutput } from '@shared/contracts/hello';
import { inputLocations, type OperationContract } from '@shared/operation-contract';
import type { z } from '@shared/zod';

type Handler<C extends OperationContract> = (input: z.output<C['input']>) => unknown | Promise<unknown>;

/**
 * Minimal phase-0 stand-in for syscd's `implement()`: mount one contract as a
 * Hono route, gathering input from path/query/body and validating it with the
 * contract's zod schema (from shared/'s zod instance).
 */
function mount<C extends OperationContract>(app: Hono, contract: C, handler: Handler<C>): void {
  const honoPath = contract.path;
  app.on(contract.method, honoPath, async (c) => {
    const loc = inputLocations(contract);
    const raw: Record<string, unknown> = {};
    for (const k of loc.path) raw[k] = c.req.param(k);
    for (const k of loc.query) {
      const v = c.req.query(k);
      if (v !== undefined) raw[k] = v;
    }
    if (contract.method !== 'GET' && loc.body.length > 0) Object.assign(raw, await c.req.json());
    const parsed = contract.input.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const result = await handler(parsed.data as z.output<C['input']>);
    return c.json(result as object, contract.status ?? 200);
  });
}

export function createApp(): Hono {
  const app = new Hono();
  app.use('*', cors());
  mount(app, helloGet, ({ name }): HelloOutput => ({ message: `Hello, ${name ?? 'world'}!` }));
  return app;
}
