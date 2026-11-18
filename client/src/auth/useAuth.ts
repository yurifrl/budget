import { useCallback, useEffect, useState } from 'react';

import type { KVStore } from '@/platform/storage/types';
import { clearSessionToken, loadAuthHeaders } from '@/platform/storage/sessionToken';

export type AuthStatus = 'loading' | 'in' | 'out' | 'unreachable';

/**
 * `/auth/me` answers 200 (signed in) or 401 (no/invalid/expired session, or an
 * email no longer on the allowlist). 403 is never sent by the server but a
 * gateway may; it means "not allowed", so the gate shows sign-in. Anything
 * else (5xx during a deploy, 429, unexpected codes) says nothing about the
 * session, so it is treated like an unreachable API: keep the token, retry.
 */
export function classifyAuth(httpStatus: number): Exclude<AuthStatus, 'loading'> {
  if (httpStatus === 200) return 'in';
  if (httpStatus === 401 || httpStatus === 403) return 'out';
  return 'unreachable';
}

/**
 * Only a 401 proves the stored token itself is invalid. A 403 is a policy
 * answer (possibly from a proxy) that may not be about the token, so the
 * token is kept and the user simply sees the sign-in gate.
 */
export function shouldClearToken(httpStatus: number): boolean {
  return httpStatus === 401;
}

/**
 * A probe that never got an HTTP response (connection refused, DNS failure)
 * is an unreachable API, not a signed-out session — dev runs with auth
 * disabled, so 'out' would render a Google gate the server could never
 * satisfy (no Google client configured). Callers treat 'unreachable' by
 * retrying; the stored token is kept either way.
 */
export function classifyProbe(
  result: { readonly ok: true; readonly status: number } | { readonly ok: false },
): Exclude<AuthStatus, 'loading'> {
  return result.ok ? classifyAuth(result.status) : 'unreachable';
}

/**
 * Probe the API session: cookie on web (`credentials: 'include'`), stored
 * Bearer token on native. The stored token wins when present — a 401 means it
 * is stale, so it is dropped and the user is signed out. 5xx/429 keep it. No HTTP response at
 * all leaves the token intact and surfaces 'unreachable'.
 */
export function useAuth(apiUrl: string, storage?: KVStore) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [authHeaders, setAuthHeaders] = useState<Record<string, string>>({});

  // `silent` retries (the unreachable poll) must not flash the spinner.
  const refresh = useCallback((silent = false) => {
    if (!silent) setStatus('loading');
    const base = apiUrl.replace(/\/+$/, '');
    let loadedHeaders: Record<string, string> = {};
    let cancelled = false;
    const probe = (async () => {
      const headers = storage ? await loadAuthHeaders(storage) : {};
      loadedHeaders = headers;
      setAuthHeaders(headers);
      return fetch(`${base}/auth/me`, { credentials: 'include', headers });
    })();
    probe
      .then((res) => {
        if (cancelled) return;
        const next = classifyProbe({ ok: true, status: res.status });
        setStatus(next);
        if (shouldClearToken(res.status) && loadedHeaders.Authorization && storage) {
          void clearSessionToken(storage);
        }
      })
      .catch(() => {
        if (!cancelled) setStatus(classifyProbe({ ok: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, storage]);

  useEffect(() => refresh(), [refresh]);

  return { status, authHeaders, refresh } as const;
}
