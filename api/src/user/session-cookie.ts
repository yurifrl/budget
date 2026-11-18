/**
 * The API session as a browser cookie: one helper so every sign-in provider
 * (Google, Cloudflare Access) sets `budget_session` with identical attributes.
 */
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';

import { issueSession, type SessionIdp } from './auth';
import { authConfig } from './config';

export const sessionTtlSeconds = (): number => authConfig().sessionTtlDays * 86400;

/**
 * A fresh stateless session token for `email` (native apps send it as Bearer).
 * `idp` marks a Cloudflare Access sign-in (see `isAllowed` in ./config).
 */
export const mintSessionToken = (email: string, idp?: SessionIdp): Promise<string> =>
  issueSession(authConfig().sessionSecret, email, sessionTtlSeconds(), idp);

export async function setSessionCookie(c: Context, email: string, idp?: SessionIdp): Promise<void> {
  const cfg = authConfig();
  setCookie(c, cfg.cookieName, await mintSessionToken(email, idp), {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    domain: cfg.cookieDomain,
    path: '/',
    maxAge: sessionTtlSeconds(),
  });
}
