import { inputLocations, type HttpMethod, type OperationContract } from '@shared/operation-contract';

// ---------------------------------------------------------------------------
// createApiClient — token + fetch injected, no env access. Used by the CLI and
// MCP tools to execute operations THROUGH the HTTP API (never the DB), so
// ownership and validation stay in one place.
// ---------------------------------------------------------------------------

/** Non-2xx API response. `message` is the server's `{ error }` text when present. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Bearer token sent on every request (omit for unauthenticated calls). */
  token?: string;
  /** Defaults to global fetch; pass `(req) => app.fetch(req)` for in-process calls. */
  fetch?: (input: Request) => Promise<Response>;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface ApiClient {
  request<T = unknown>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
  get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T>;
  delete<T = unknown>(path: string, query?: Record<string, QueryValue>, body?: unknown): Promise<T>;
  /** Execute an operation contract: input is routed to path/query/body per the contract. */
  call<T = unknown>(contract: OperationContract, input?: Record<string, unknown>): Promise<T>;
}

function errorMessage(status: number, statusText: string, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error;
  return `${status} ${statusText}`.trim();
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? ((req: Request) => fetch(req));
  const base = options.baseUrl.replace(/\/+$/, '');

  async function request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const hasBody = opts.body !== undefined;
    if (hasBody) headers['Content-Type'] = 'application/json';
    const res = await doFetch(
      new Request(url, { method, headers, body: hasBody ? JSON.stringify(opts.body) : undefined }),
    );
    const text = await res.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) throw new ApiError(res.status, errorMessage(res.status, res.statusText, parsed), parsed);
    return parsed as T;
  }

  return {
    request,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body, query) => request('POST', path, { body, query }),
    put: (path, body, query) => request('PUT', path, { body, query }),
    patch: (path, body, query) => request('PATCH', path, { body, query }),
    delete: (path, query, body) => request('DELETE', path, { query, body }),
    call(contract, input = {}) {
      const loc = inputLocations(contract);
      let path = contract.path;
      for (const key of loc.path) {
        const value = input[key];
        if (value === undefined || value === null) throw new Error(`${contract.name}: missing path param ${key}`);
        path = path.replace(`:${key}`, encodeURIComponent(String(value)));
      }
      const query: Record<string, QueryValue> = {};
      for (const key of loc.query) query[key] = input[key] as QueryValue;
      let body: unknown;
      if (contract.bodyKey) {
        body = input[contract.bodyKey];
      } else if (loc.body.length > 0) {
        const obj: Record<string, unknown> = {};
        for (const key of loc.body) if (input[key] !== undefined) obj[key] = input[key];
        body = obj;
      }
      return request(contract.method, path, { query, body });
    },
  };
}
