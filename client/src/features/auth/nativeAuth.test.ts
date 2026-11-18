import { describe, it, expect } from 'bun:test';

import { exchangeAccessCode, nativeSignInUrl, parseAuthCallback, webSignInUrl } from './nativeAuth';

describe('parseAuthCallback', () => {
  it('parses a success redirect from the query string', () => {
    expect(parseAuthCallback('syscdapp://login?code=abc123&state=nonce.ticket')).toEqual({
      kind: 'success',
      code: 'abc123',
      state: 'nonce.ticket',
    });
  });

  it('parses a success redirect from the hash fragment', () => {
    expect(parseAuthCallback('exp://10.0.0.1:8081#code=abc&state=s')).toEqual({
      kind: 'success',
      code: 'abc',
      state: 's',
    });
  });

  it('parses an error redirect', () => {
    expect(parseAuthCallback('syscdapp://login?error=cancelled')).toEqual({
      kind: 'error',
      error: 'cancelled',
    });
  });

  it('reports missing code or state as an error', () => {
    expect(parseAuthCallback('syscdapp://login?code=abc')).toEqual({ kind: 'error', error: 'missing code or state in redirect' });
    expect(parseAuthCallback('syscdapp://login?state=s')).toEqual({ kind: 'error', error: 'missing code or state in redirect' });
    expect(parseAuthCallback('syscdapp://login')).toEqual({ kind: 'error', error: 'missing code or state in redirect' });
  });

  it('tolerates unparseable URLs', () => {
    expect(parseAuthCallback('not a url')).toEqual({ kind: 'error', error: 'invalid redirect' });
  });
});

describe('nativeSignInUrl', () => {
  it('joins the API base without double slashes', () => {
    expect(nativeSignInUrl('http://localhost:3000/')).toBe('http://localhost:3000/auth/google/native');
    expect(nativeSignInUrl('https://api.syscd.live')).toBe('https://api.syscd.live/auth/google/native');
  });
});

describe('webSignInUrl', () => {
  it('joins the API base without double slashes', () => {
    expect(webSignInUrl('http://localhost:3000/')).toBe('http://localhost:3000/auth/google');
    expect(webSignInUrl('https://api.syscd.live')).toBe('https://api.syscd.live/auth/google');
  });
});

describe('exchangeAccessCode', () => {
  const realFetch = globalThis.fetch;
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  it('POSTs the code as JSON and returns the token', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    await withFetch(
      (async (url: string, init?: RequestInit) => {
        seen = { url, init };
        return new Response(JSON.stringify({ token: 'tok', email: 'a@b.com' }), { status: 200 });
      }) as unknown as typeof fetch,
      async () => {
        expect(await exchangeAccessCode('https://api.test/', 'c0de')).toEqual({ token: 'tok' });
      },
    );
    expect(seen!.url).toBe('https://api.test/auth/exchange');
    expect(seen!.init?.method).toBe('POST');
    expect(seen!.init?.body).toBe(JSON.stringify({ code: 'c0de' }));
  });

  it('surfaces the API error or the network failure', async () => {
    await withFetch(
      (async () => new Response(JSON.stringify({ error: 'sign-in expired, try again' }), { status: 400 })) as unknown as typeof fetch,
      async () => expect(await exchangeAccessCode('https://api.test', 'x')).toEqual({ error: 'sign-in expired, try again' }),
    );
    await withFetch(
      (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
      async () => expect(await exchangeAccessCode('https://api.test', 'x')).toEqual({ error: 'offline' }),
    );
  });
});
