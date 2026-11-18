/**
 * Operation CONTRACT — the pure-data half of a declare-once API operation.
 *
 * A contract says everything about an endpoint that is not server code: its
 * name, description, zod input schema, zod output (response) schema, HTTP
 * method + path template, where each input key travels (path / query / body),
 * a kind, and which surfaces expose it. It imports zod ONLY, so the Expo app can import contracts (to generate
 * RTK Query endpoints) without bundling hono or pg. The server HANDLER is
 * attached separately by `implement()` in ./operation.ts.
 */
import type { z } from './zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** read: no side effects. write: reversible mutation. destructive: deletes/wipes. */
export type OperationKind = 'read' | 'write' | 'destructive';

export interface OperationExpose {
  /** Mount as an HTTP route. */
  api: boolean;
  /** Generate a CLI command. */
  cli: boolean;
  /** Generate an MCP tool. */
  mcp: boolean;
}

/** One flat input object — every key is a path param, query param or body field. */
export type InputSchema = z.ZodObject<z.ZodRawShape>;

/** Any zod schema describing a JSON response body. */
export type OutputSchema = z.ZodType;

export interface OperationContract<I extends InputSchema = InputSchema, O extends OutputSchema = OutputSchema> {
  /** snake_case, feature-prefixed (budget_transactions_list). */
  name: string;
  description: string;
  input: I;
  /**
   * Response body schema (2xx JSON, after serialization: dates are strings).
   * A handler that returns nothing (204) declares `z.null()`. Optional while
   * contracts are being described; the client derives its wire types from it,
   * tests validate every handler result against it, and MCP exposes it as the
   * tool's outputSchema when it is an object.
   */
  output?: O;
  method: HttpMethod;
  /** Public path template, e.g. `/transactions/:id`. */
  path: string;
  /**
   * Input keys sent in the query string. Default: GET -> every non-path key;
   * other methods -> none (the rest goes to the JSON body).
   */
  query?: ReadonlyArray<Extract<keyof z.output<I>, string>>;
  /**
   * When set, the JSON body IS this input key's value (instead of an object
   * of body keys) — for endpoints whose body is `null` or an array.
   */
  bodyKey?: Extract<keyof z.output<I>, string>;
  kind: OperationKind;
  expose: OperationExpose;
  /** Success status of a JSON response. Default 200 (a handler returning nothing is 204). */
  status?: 200 | 201;
}

/** Declare an operation contract (identity helper that keeps the literal types). */
export function defineOperation<I extends InputSchema, O extends OutputSchema = OutputSchema>(
  contract: OperationContract<I, O>,
): OperationContract<I, O> {
  return contract;
}

/** The response body type of a contract with an output schema. */
export type OperationOutput<C> = C extends OperationContract<InputSchema, infer O> ? z.output<O> : never;

/** `:name` segments of a path template. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
}

export interface InputLocations {
  path: string[];
  query: string[];
  /** Body object keys (empty when `bodyKey` is set). */
  body: string[];
}

/** Resolve where every input key travels for a contract. */
export function inputLocations(contract: OperationContract): InputLocations {
  const path = pathParamNames(contract.path);
  const keys = Object.keys(contract.input.shape).filter((k) => !path.includes(k));
  const bodyKey = contract.bodyKey;
  const rest = keys.filter((k) => k !== bodyKey);
  const query = contract.query ? [...contract.query] : contract.method === 'GET' ? rest : [];
  const body = rest.filter((k) => !query.includes(k));
  return { path, query, body: contract.method === 'GET' ? [] : body };
}

/** Common expose presets. */
export const EXPOSE_ALL: OperationExpose = { api: true, cli: true, mcp: true };
/** API + CLI only — destructive, bulk or UI-internal operations. */
export const EXPOSE_NO_MCP: OperationExpose = { api: true, cli: true, mcp: false };

function isContract(v: unknown): v is OperationContract {
  return typeof v === 'object' && v !== null && 'input' in v && 'method' in v && 'path' in v && 'expose' in v;
}

/**
 * Gather every contract exported from the given contract modules
 * (`import * as x from './x'`) — feature `contracts/index.ts` barrels use it so
 * a new contract file/export is picked up without a second list to maintain.
 */
export function collectContracts(...modules: Array<Record<string, unknown>>): readonly OperationContract[] {
  return modules.flatMap((m) => Object.values(m).filter(isContract));
}
