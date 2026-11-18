import { describe, it, expect } from 'bun:test';

import { nativeSignInUrl, parseAuthCallback, webSignInUrl } from './nativeAuth';

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
