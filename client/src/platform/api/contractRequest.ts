/**
 * Turn an operation CONTRACT (server/<feature>/contracts) plus its flat input
 * into an {@link ApiQuery}. The method, path template and the placement of each
 * input key (path / query / body / bodyKey) all come from the contract, so the
 * app never restates them. Contracts are zod-only: this file may import them
 * without pulling hono or pg into the Expo bundle.
 */

import type { z } from '@shared/zod';

import { inputLocations, type InputSchema, type OperationContract } from '@shared/operation-contract';

import type { ApiQuery } from './baseQuery';

export function contractRequest<I extends InputSchema>(
  contract: OperationContract<I>,
  input: z.input<I>,
): ApiQuery {
  const values = input as Record<string, unknown>;
  const loc = inputLocations(contract as OperationContract);

  const url = contract.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const value = values[name];
    if (value === undefined || value === null) throw new Error(`${contract.name}: missing path param "${name}"`);
    return encodeURIComponent(String(value));
  });

  const request: ApiQuery = { url, method: contract.method };

  if (loc.query.length > 0) {
    const params: NonNullable<ApiQuery['params']> = {};
    for (const key of loc.query) {
      const value = values[key];
      if (value !== undefined && value !== null) params[key] = value as string | number | boolean;
    }
    request.params = params;
  }

  if (contract.bodyKey) {
    // The body IS this key's value; `null` is a legitimate JSON body (clear).
    const value = values[contract.bodyKey];
    if (value !== undefined) request.body = value;
  } else if (loc.body.length > 0) {
    const body: Record<string, unknown> = {};
    for (const key of loc.body) {
      if (values[key] !== undefined) body[key] = values[key];
    }
    // A body with no values (e.g. a DELETE whose only body key is an omitted optional) sends nothing.
    if (Object.keys(body).length > 0) request.body = body;
  }
  return request;
}
