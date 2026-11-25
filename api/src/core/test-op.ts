/**
 * Test helper (not a test file): call an operation by contract name against an
 * in-process Hono app, placing each input key where the contract says (path,
 * query, body or bodyKey) — the same placement the clients' contractRequest
 * uses, so a test exercises the real wire shape.
 */
import type { Hono } from 'hono';

import { inputLocations, type OperationContract } from '@shared/operation-contract';

export interface OpResult {
  status: number;
  headers: Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export function makeOpCaller(app: Hono, contracts: readonly OperationContract[]) {
  const byName = new Map<string, OperationContract>(contracts.map((c) => [c.name, c]));
  return async function op(name: string, input: Record<string, unknown>): Promise<OpResult> {
    const c = byName.get(name);
    if (!c) throw new Error(`unknown operation ${name}`);
    const loc = inputLocations(c);
    let path = c.path;
    for (const p of loc.path) path = path.replace(`:${p}`, encodeURIComponent(String(input[p])));
    const qs = new URLSearchParams();
    for (const q of loc.query) if (input[q] !== undefined && input[q] !== null) qs.set(q, String(input[q]));
    const body = c.bodyKey
      ? input[c.bodyKey]
      : loc.body.length > 0
        ? Object.fromEntries(loc.body.filter((k) => k in input).map((k) => [k, input[k]]))
        : undefined;
    const res = await app.request(`http://test${path}${qs.size ? `?${qs}` : ''}`, {
      method: c.method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined || c.method === 'GET' ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };
}
