/**
 * OAuth for the CLI: login (dynamic registration + authorization code + PKCE
 * S256 over a loopback redirect), logout (revoke + forget), and
 * `getAccessToken` (the credential-store read used by every API call, and by
 * the stdio MCP entrypoint).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { CredentialStore, normalizeApiUrl, type StoredCredentials } from './credentials';

export type FetchLike = (input: Request) => Promise<Response>;

/** Refresh when the access token has less than this left. */
const REFRESH_SKEW_MS = 60_000;

export class AuthError extends Error {
  constructor(
    public readonly code: 'invalid_grant' | 'login_failed' | 'login_timeout',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface Endpoints {
  issuer?: string;
  authorization: string;
  token: string;
  registration: string;
  revocation: string;
}

/** RFC 8414 discovery, falling back to the conventional paths when absent. */
export async function discover(apiUrl: string, doFetch: FetchLike): Promise<Endpoints> {
  const base = normalizeApiUrl(apiUrl);
  const fallback: Endpoints = {
    authorization: `${base}/oauth/authorize`,
    token: `${base}/oauth/token`,
    registration: `${base}/oauth/register`,
    revocation: `${base}/oauth/revoke`,
  };
  const res = await doFetch(
    new Request(`${base}/.well-known/oauth-authorization-server`, {
      headers: { Accept: 'application/json' },
    }),
  );
  if (!res.ok) return fallback;
  const doc = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!doc) return fallback;
  const str = (k: string, d: string) => (typeof doc[k] === 'string' ? (doc[k] as string) : d);
  return {
    issuer: typeof doc.issuer === 'string' ? doc.issuer : undefined,
    authorization: str('authorization_endpoint', fallback.authorization),
    token: str('token_endpoint', fallback.token),
    registration: str('registration_endpoint', fallback.registration),
    revocation: str('revocation_endpoint', fallback.revocation),
  };
}

async function postForm(doFetch: FetchLike, url: string, params: Record<string, string>): Promise<Response> {
  return doFetch(
    new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
    }),
  );
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function readOAuthError(res: Response): Promise<{ error: string; description: string }> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    error_description?: string;
  } | null;
  return {
    error: body?.error ?? `http_${res.status}`,
    description: body?.error_description ?? res.statusText,
  };
}

export interface TokenDeps {
  apiUrl: string;
  configDir: string;
  fetch?: FetchLike;
  now?: () => number;
}

/**
 * A valid access token for `apiUrl`, refreshing first when the stored one is
 * expired or about to be. Returns undefined when not logged in (callers then
 * go unauthenticated, which works against an auth-disabled dev server).
 *
 * The rotated refresh token is persisted atomically BEFORE the new access
 * token is returned, under a cross-process lock; on `invalid_grant` the
 * credentials are cleared and an AuthError tells the user to log in again.
 */
export async function getAccessToken(deps: TokenDeps): Promise<string | undefined> {
  const store = new CredentialStore(deps.configDir);
  const now = deps.now ?? Date.now;
  const fresh = (c: StoredCredentials) => c.expires_at - REFRESH_SKEW_MS > now();
  const first = store.get(deps.apiUrl);
  if (!first) return undefined;
  if (fresh(first)) return first.access_token;

  const doFetch = deps.fetch ?? ((r: Request) => fetch(r));
  return store.withLock(async () => {
    // Another process may have refreshed while we waited for the lock.
    const creds = store.get(deps.apiUrl);
    if (!creds) return undefined;
    if (fresh(creds)) return creds.access_token;

    const endpoints = await discover(deps.apiUrl, doFetch);
    const res = await postForm(doFetch, endpoints.token, {
      grant_type: 'refresh_token',
      refresh_token: creds.refresh_token,
      client_id: creds.client_id,
    });
    if (!res.ok) {
      const err = await readOAuthError(res);
      if (err.error === 'invalid_grant') {
        store.delete(deps.apiUrl);
        throw new AuthError(
          'invalid_grant',
          'Your session expired or was revoked. Run `budget login` to sign in again.',
        );
      }
      throw new Error(`token refresh failed: ${err.error}${err.description ? ` (${err.description})` : ''}`);
    }
    const tok = (await res.json()) as TokenResponse;
    const next: StoredCredentials = {
      client_id: creds.client_id,
      access_token: tok.access_token,
      expires_at: now() + (tok.expires_in ?? 3600) * 1000,
      refresh_token: tok.refresh_token ?? creds.refresh_token,
      scope: tok.scope ?? creds.scope,
    };
    store.save(deps.apiUrl, next); // persist the rotated token before use
    return next.access_token;
  });
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

export interface LoginDeps extends TokenDeps {
  /** Show the user the authorization URL (always called, even if a browser opens). */
  announce: (url: string) => void;
  /** Best-effort browser launch; failures are ignored. */
  openBrowser?: (url: string) => void;
  scope?: string;
  timeoutMs?: number;
  clientName?: string;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

function listenLoopback(
  handler: (url: URL) => { status: number; body: string },
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const out = handler(new URL(req.url ?? '/', 'http://127.0.0.1'));
      res.writeHead(out.status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(out.body);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port });
      else reject(new Error('could not bind a loopback port'));
    });
  });
}

const page = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Budget</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h3>${msg}</h3><p>You can close this tab.</p></body>`;

export async function login(deps: LoginDeps): Promise<{ scope?: string; expires_at: number }> {
  const doFetch = deps.fetch ?? ((r: Request) => fetch(r));
  const now = deps.now ?? Date.now;
  const endpoints = await discover(deps.apiUrl, doFetch);

  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  let settle!: (r: { code: string } | { error: string }) => void;
  const callback = new Promise<{ code: string } | { error: string }>((resolve) => (settle = resolve));
  let done = false;
  const { server, port } = await listenLoopback((url) => {
    if (url.pathname !== '/callback') return { status: 404, body: page('Not found') };
    if (done) return { status: 400, body: page('Already handled') };
    if (url.searchParams.get('state') !== state) {
      // Not our request: ignore, keep waiting (a stray local request must not abort login).
      return { status: 400, body: page('State mismatch') };
    }
    const iss = url.searchParams.get('iss');
    if (iss && endpoints.issuer && iss !== endpoints.issuer) return { status: 400, body: page('Issuer mismatch') };
    done = true;
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error) {
      settle({ error: url.searchParams.get('error_description') || error });
      return { status: 200, body: page('Login was not completed') };
    }
    if (!code) {
      settle({ error: 'callback carried no code' });
      return { status: 400, body: page('Missing code') };
    }
    settle({ code });
    return { status: 200, body: page('Signed in to Budget') };
  });

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const scope = deps.scope ?? 'read write';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reg = await doFetch(
      new Request(endpoints.registration, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_name: deps.clientName ?? 'Budget CLI',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      }),
    );
    if (!reg.ok) {
      const err = await readOAuthError(reg);
      throw new AuthError(
        'login_failed',
        `client registration failed: ${err.error}${err.description ? ` (${err.description})` : ''}`,
      );
    }
    const clientId = ((await reg.json()) as { client_id: string }).client_id;

    const authUrl = new URL(endpoints.authorization);
    authUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    deps.announce(authUrl.toString());
    try {
      deps.openBrowser?.(authUrl.toString());
    } catch {
      // headless: the printed URL is the fallback
    }

    const timeout = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ error: '__timeout' }), deps.timeoutMs ?? 300_000);
    });
    const result = await Promise.race([callback, timeout]);
    if ('error' in result) {
      if (result.error === '__timeout')
        throw new AuthError('login_timeout', 'Timed out waiting for the browser sign-in.');
      throw new AuthError('login_failed', `authorization failed: ${result.error}`);
    }

    const res = await postForm(doFetch, endpoints.token, {
      grant_type: 'authorization_code',
      code: result.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (!res.ok) {
      const err = await readOAuthError(res);
      throw new AuthError(
        'login_failed',
        `token exchange failed: ${err.error}${err.description ? ` (${err.description})` : ''}`,
      );
    }
    const tok = (await res.json()) as TokenResponse;
    if (!tok.access_token || !tok.refresh_token) throw new AuthError('login_failed', 'token response was incomplete');
    const creds: StoredCredentials = {
      client_id: clientId,
      access_token: tok.access_token,
      expires_at: now() + (tok.expires_in ?? 3600) * 1000,
      refresh_token: tok.refresh_token,
      scope: tok.scope,
    };
    new CredentialStore(deps.configDir).save(deps.apiUrl, creds);
    return { scope: tok.scope, expires_at: creds.expires_at };
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

/** Revoke the grant (best effort) and delete local credentials. */
export async function logout(deps: TokenDeps): Promise<{ was_logged_in: boolean; revoked: boolean }> {
  const store = new CredentialStore(deps.configDir);
  const creds = store.get(deps.apiUrl);
  if (!creds) return { was_logged_in: false, revoked: false };
  const doFetch = deps.fetch ?? ((r: Request) => fetch(r));
  let revoked = false;
  try {
    const endpoints = await discover(deps.apiUrl, doFetch);
    const res = await postForm(doFetch, endpoints.revocation, {
      token: creds.refresh_token,
      client_id: creds.client_id,
    });
    revoked = res.ok;
  } catch {
    // offline: still forget locally
  }
  store.delete(deps.apiUrl);
  return { was_logged_in: true, revoked };
}
