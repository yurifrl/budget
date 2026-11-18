/**
 * Declare-once API operations: server half.
 *
 * `implement(contract, handler)` pairs a pure-data contract (see
 * ./operation-contract.ts) with its server handler; `mountOperations` turns a
 * list of those into Hono routes with validated input. The same contracts
 * also drive the MCP tools, CLI commands and (later) the app's RTK Query
 * endpoints, so no endpoint is described twice.
 *
 * Handler return convention:
 *  - a `Response`  -> passed through untouched (custom status/headers);
 *  - `undefined`   -> 204 No Content;
 *  - anything else -> JSON with the contract's `status` (default 200).
 * Failures throw `HttpError` (-> `{ error, code }` via httpOnError).
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from '@shared/zod';

import { HttpError, parseValue } from './validate';
import { inputLocations, type InputSchema, type OperationContract } from '@shared/operation-contract';

export * from '@shared/operation-contract';

export type OperationHandler<I extends InputSchema> = (
  c: Context,
  input: z.output<I>,
) => unknown | Promise<unknown>;

/** A contract plus its server handler. */
export interface Operation<I extends InputSchema = InputSchema> {
  contract: OperationContract<I>;
  handler: OperationHandler<I>;
}

/** Heterogeneous operation lists (feature catalogs) erase the input type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperation = Operation<any>;

export function implement<I extends InputSchema>(
  contract: OperationContract<I>,
  handler: OperationHandler<I>,
): Operation<I> {
  return { contract, handler };
}

async function readBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body must be valid JSON', 'invalid_input');
  }
}

/** Gather path + query + body into the flat input object and validate it. */
async function parseInput<I extends InputSchema>(c: Context, contract: OperationContract<I>): Promise<z.output<I>> {
  const loc = inputLocations(contract);
  const raw: Record<string, unknown> = {};

  const body = loc.body.length > 0 || contract.bodyKey ? await readBody(c) : undefined;
  if (contract.bodyKey) {
    raw[contract.bodyKey] = body;
  } else if (loc.body.length > 0) {
    if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) {
      throw new HttpError(400, 'request body must be a JSON object', 'invalid_input');
    }
    const obj = (body ?? {}) as Record<string, unknown>;
    for (const key of loc.body) if (key in obj) raw[key] = obj[key];
  }
  for (const key of loc.query) {
    const value = c.req.query(key);
    if (value !== undefined) raw[key] = value;
  }
  for (const key of loc.path) raw[key] = c.req.param(key);

  return parseValue(contract.input, raw);
}

/**
 * Response-vs-contract checking (G9). `off` in production (the default; never
 * a production hot path): the bun test preload sets `throw`, so a handler
 * whose result drifts from its contract's `output` fails the test that
 * exercised it (as a 500); local dev may opt into `warn` with
 * API_VALIDATE_OUTPUT (see index.ts).
 */
export type OutputValidation = 'off' | 'warn' | 'throw';
let outputValidation: OutputValidation = 'off';

export function configureOutputValidation(mode: OutputValidation): void {
  outputValidation = mode;
}

export function outputValidationMode(): OutputValidation {
  return outputValidation;
}

/** The JSON body a handler result becomes (null for 204, parsed JSON for a JSON Response, undefined = not JSON). */
async function wireBody(result: unknown): Promise<unknown> {
  if (result instanceof Response) {
    if (!result.ok) return undefined;
    if (result.status === 204) return null;
    if (!(result.headers.get('content-type') ?? '').includes('application/json')) return undefined;
    return result.clone().json();
  }
  return result === undefined ? null : JSON.parse(JSON.stringify(result));
}

/** Validate one handler result against the contract's output schema (no-op when off or undeclared). */
export async function checkOutput(contract: OperationContract, result: unknown): Promise<void> {
  if (outputValidation === 'off' || !contract.output) return;
  const body = await wireBody(result);
  if (body === undefined) return;
  const parsed = contract.output.safeParse(body);
  if (parsed.success) return;
  const detail = parsed.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  const message = `${contract.name}: response does not match its output schema: ${detail}`;
  if (outputValidation === 'throw') throw new Error(message);
  console.warn(message);
}

export interface MountOptions {
  /**
   * Prefix the router is mounted under by the caller (`app.route(basePath, r)`).
   * Operation paths stay public/absolute; they are registered relative to it.
   */
  basePath?: string;
  /** Middleware run, in order, before input parsing on every route (e.g. budgetAccess). */
  use?: readonly MiddlewareHandler[];
}

function relativePath(path: string, basePath: string): string {
  if (!basePath) return path;
  if (path !== basePath && !path.startsWith(`${basePath}/`)) {
    throw new Error(`operation path ${path} is not under basePath ${basePath}`);
  }
  return path.slice(basePath.length) || '/';
}

/** Register every api-exposed operation on `hono`; returns it for chaining. */
export function mountOperations<H extends Hono>(hono: H, ops: readonly AnyOperation[], options: MountOptions = {}): H {
  const middleware = options.use ?? [];
  for (const { contract, handler } of ops) {
    if (!contract.expose.api) continue;
    const route = async (c: Context) => {
      const input = await parseInput(c, contract);
      const result = await handler(c, input);
      await checkOutput(contract, result);
      if (result instanceof Response) return result;
      if (result === undefined) return c.body(null, 204);
      return c.json(result, (contract.status ?? 200) as ContentfulStatusCode);
    };
    const handlers: MiddlewareHandler[] = [...middleware, route as MiddlewareHandler];
    hono.on(contract.method, relativePath(contract.path, options.basePath ?? ''), ...(handlers as [MiddlewareHandler]));
  }
  return hono;
}
