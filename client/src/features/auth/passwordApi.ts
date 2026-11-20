/**
 * The three password requests, built from the shared contracts with
 * `contractRequest` and sent with plain fetch, not RTK Query: an RTK mutation
 * keeps its argument in the store (and its cache key), which would put the
 * password in redux. Nothing here logs; failures are reduced to
 * {@link PasswordFailure}. Web rides the session cookie (`credentials:
 * 'include'`); native asks for `session: 'token'` and stores the token.
 */
import { contractRequest } from '@shared/contract-request';
import {
  authPasswordChange,
  authPasswordComplete,
  authPasswordLogin,
  passwordChangeResultSchema,
  passwordLoginResultSchema,
  passwordSignedInSchema,
} from '@shared/contracts/user';
import type { PasswordLoginResult, SessionDelivery } from '@shared/contracts/user';

import { loadAuthHeaders, saveSessionToken } from '@/platform/storage/sessionToken';
import type { KVStore } from '@/platform/storage/types';
import { parseRetryAfter, SESSION_NOT_SAVED, type PasswordFailure } from './password.logic';

export type PasswordResult<T> = { ok: true; data: T } | { ok: false; failure: PasswordFailure };

type Fetch = typeof fetch;
type Request = ReturnType<typeof contractRequest>;

async function send<T>(
  apiUrl: string,
  req: Request,
  headers: Record<string, string>,
  parse: (body: unknown) => T | null,
  doFetch: Fetch,
): Promise<PasswordResult<T>> {
  let res: Response;
  try {
    res = await doFetch(`${apiUrl.replace(/\/+$/, '')}${req.url}`, {
      method: req.method ?? 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(req.body),
    });
  } catch {
    return { ok: false, failure: { status: 0, code: null, retryAfter: null } };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const data = parse(body);
    if (data !== null) return { ok: true, data };
    return { ok: false, failure: { status: res.status, code: null, retryAfter: null } };
  }
  const code = typeof (body as { code?: unknown } | null)?.code === 'string' ? (body as { code: string }).code : null;
  return { ok: false, failure: { status: res.status, code, retryAfter: parseRetryAfter(res.headers.get('Retry-After')) } };
}

/** `native` = hold the session as a token (Bearer) instead of the web cookie. */
const delivery = (native: boolean): SessionDelivery => (native ? 'token' : 'cookie');

export function passwordLogin(
  apiUrl: string,
  input: { email: string; password: string; native: boolean },
  doFetch: Fetch = fetch,
): Promise<PasswordResult<PasswordLoginResult>> {
  const req = contractRequest(authPasswordLogin, { email: input.email, password: input.password, session: delivery(input.native) });
  return send(apiUrl, req, {}, (b) => {
    const parsed = passwordLoginResultSchema.safeParse(b);
    return parsed.success ? parsed.data : null;
  }, doFetch);
}

export function passwordComplete(
  apiUrl: string,
  input: { changeToken: string; newPassword: string; native: boolean },
  doFetch: Fetch = fetch,
) {
  const req = contractRequest(authPasswordComplete, {
    change_token: input.changeToken,
    new_password: input.newPassword,
    session: delivery(input.native),
  });
  return send(apiUrl, req, {}, (b) => {
    const parsed = passwordSignedInSchema.safeParse(b);
    return parsed.success ? parsed.data : null;
  }, doFetch);
}

/**
 * Change the signed-in person's password. A Bearer (native) caller gets a
 * replacement token, which is stored before this resolves: the old one stops
 * working with the change.
 */
export async function passwordChange(
  apiUrl: string,
  storage: KVStore,
  input: { current: string; next: string },
  doFetch: Fetch = fetch,
): Promise<PasswordResult<null>> {
  const req = contractRequest(authPasswordChange, { current_password: input.current, new_password: input.next });
  const result = await send(apiUrl, req, await loadAuthHeaders(storage), (b) => {
    const parsed = passwordChangeResultSchema.safeParse(b);
    return parsed.success ? parsed.data : null;
  }, doFetch);
  if (!result.ok) return result;
  if (result.data.token) {
    try {
      await saveSessionToken(storage, result.data.token);
    } catch {
      return { ok: false, failure: SESSION_NOT_SAVED };
    }
  }
  return { ok: true, data: null };
}
