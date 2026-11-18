/**
 * Turn an operation CONTRACT plus its flat input into a request description
 * ({@link ContractRequest}). The method, path template and the placement of
 * each input key (path / query / body / bodyKey) all come from the contract,
 * so no client restates them. Used by the app's RTK Query slices and the
 * admin SPA (the API places inputs with the same `inputLocations`).
 */
import type { z } from './zod';

import { inputLocations, type InputSchema, type OperationContract, type OutputSchema } from './operation-contract';

/** HTTP request built from a contract (structurally the app's `ApiQuery`). */
export interface ContractRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Values are stringified by the caller; `undefined` entries are omitted. */
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export function contractRequest<I extends InputSchema, O extends OutputSchema>(
  contract: OperationContract<I, O>,
  input: z.input<I>,
): ContractRequest {
  const values = input as Record<string, unknown>;
  const loc = inputLocations(contract as unknown as OperationContract);

  const url = contract.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const value = values[name];
    if (value === undefined || value === null) throw new Error(`${contract.name}: missing path param "${name}"`);
    return encodeURIComponent(String(value));
  });

  const request: ContractRequest = { url, method: contract.method };

  if (loc.query.length > 0) {
    const params: NonNullable<ContractRequest['params']> = {};
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
