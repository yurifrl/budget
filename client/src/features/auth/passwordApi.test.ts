import { describe, expect, it } from 'bun:test';

import { passwordChange, passwordComplete, passwordLogin } from './passwordApi';
import type { KVStore } from '@/platform/storage/types';

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const memory = (): KVStore & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T,>(k: string, d: T) => (data.has(k) ? (data.get(k) as T) : d),
    set: async (k: string, v: unknown) => void data.set(k, v),
    remove: async (k: string) => void data.delete(k),
  } as unknown as KVStore & { data: Map<string, unknown> };
};

describe('passwordLogin', () => {
  it('posts the contract path with the session mode, JSON body, cookie credentials', async () => {
    const { f, calls } = fakeFetch(200, { status: 'signed_in', email: 'a@b.c', token: 't' });
    const r = await passwordLogin('http://api/', { email: 'a@b.c', password: 'pw', native: true }, f);
    expect(r).toEqual({ ok: true, data: { status: 'signed_in', email: 'a@b.c', token: 't' } });
    expect(calls[0]!.url).toBe('http://api/auth/password/login');
    expect(calls[0]!.init.credentials).toBe('include');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: 'a@b.c', password: 'pw', session: 'token' });
    // The password is only ever in the body.
    expect(calls[0]!.url).not.toContain('pw');
  });
  it('web asks for the cookie', async () => {
    const { f, calls } = fakeFetch(200, { status: 'signed_in', email: 'a@b.c' });
    await passwordLogin('http://api', { email: 'a@b.c', password: 'pw', native: false }, f);
    expect(JSON.parse(String(calls[0]!.init.body)).session).toBe('cookie');
  });
  it('returns the change step for a temp password', async () => {
    const { f } = fakeFetch(200, { status: 'password_change_required', email: 'a@b.c', change_token: 'c', expires_in: 600 });
    const r = await passwordLogin('http://api', { email: 'a@b.c', password: 'tmp', native: false }, f);
    expect(r.ok && r.data.status).toBe('password_change_required');
  });
  it('reduces a 429 to code + Retry-After seconds', async () => {
    const { f } = fakeFetch(429, { error: 'x', code: 'too_many_attempts' }, { 'Retry-After': '120' });
    const r = await passwordLogin('http://api', { email: 'a@b.c', password: 'x', native: false }, f);
    expect(r).toEqual({ ok: false, failure: { status: 429, code: 'too_many_attempts', retryAfter: 120 } });
  });
  it('network errors and unparseable answers are failures', async () => {
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await passwordLogin('http://api', { email: 'a', password: 'b', native: false }, down)).toEqual({
      ok: false,
      failure: { status: 0, code: null, retryAfter: null },
    });
    const { f } = fakeFetch(200, { nope: true });
    const r = await passwordLogin('http://api', { email: 'a', password: 'b', native: false }, f);
    expect(r.ok).toBe(false);
  });
});

describe('passwordComplete', () => {
  it('sends the change token and new password in the body', async () => {
    const { f, calls } = fakeFetch(200, { status: 'signed_in', email: 'a@b.c' });
    const r = await passwordComplete('http://api', { changeToken: 'ct', newPassword: 'np', native: false }, f);
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe('http://api/auth/password/complete');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ change_token: 'ct', new_password: 'np', session: 'cookie' });
  });
});

describe('passwordChange', () => {
  it('stores the replacement token a Bearer caller gets, and sends the old one', async () => {
    const storage = memory();
    await storage.set('auth.sessionToken', 'old');
    const { f, calls } = fakeFetch(200, { ok: true, token: 'new' });
    const r = await passwordChange('http://api', storage, { current: 'c', next: 'n' }, f);
    expect(r.ok).toBe(true);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer old');
    expect(storage.data.get('auth.sessionToken')).toBe('new');
  });
  it('a failing token save is a failure, not a throw', async () => {
    const storage = memory();
    storage.set = async () => {
      throw new Error('disk');
    };
    const r = await passwordChange('http://api', storage, { current: 'c', next: 'n' }, fakeFetch(200, { ok: true, token: 'new' }).f);
    expect(r.ok).toBe(false);
  });
  it('leaves storage alone for a cookie caller and on failure', async () => {
    const storage = memory();
    await passwordChange('http://api', storage, { current: 'c', next: 'n' }, fakeFetch(200, { ok: true }).f);
    expect(storage.data.size).toBe(0);
    const r = await passwordChange('http://api', storage, { current: 'c', next: 'n' }, fakeFetch(401, { error: 'x', code: 'invalid_credentials' }).f);
    expect(r).toEqual({ ok: false, failure: { status: 401, code: 'invalid_credentials', retryAfter: null } });
  });
});
