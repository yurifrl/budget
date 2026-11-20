/**
 * Request guards for the password and admin-user routes.
 *
 * Origin: a browser always sends Origin on a cross-origin request (and on
 * same-origin non-GET ones). The session cookie is SameSite=Lax on the parent
 * domain, so a sibling subdomain counts as same-site and gets the cookie on a
 * form POST; these routes therefore refuse an Origin that is not one of the
 * app/admin origins (the CORS list). Native apps send no Origin and pass.
 */
import type { Context, MiddlewareHandler } from 'hono';

import { errorResponse } from '../core/validate';
import { authConfig } from './config';

/** The trusted browser origins (exactly the CORS list built in app.ts); default = the app origin. */
export type TrustedOrigins = readonly string[] | undefined;

const originsOf = (trusted: TrustedOrigins): readonly string[] => trusted ?? [authConfig().appOrigin];

export function originGuard(trusted: TrustedOrigins): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin !== undefined && !originsOf(trusted).includes(origin)) {
      return errorResponse(c, 403, 'origin not allowed', 'origin_not_allowed');
    }
    await next();
  };
}

/** JSON bodies only: a cross-site form or text/plain POST would skip the CORS preflight. */
export const requireJsonBody: MiddlewareHandler = async (c, next) => {
  if (!(c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
    return errorResponse(c, 415, 'request body must be application/json', 'unsupported_media_type');
  }
  await next();
};

export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};

/** The client address for rate limiting: CF-Connecting-IP (Cloudflare) first, else the socket. */
export function clientAddress(c: Context): string {
  const cf = c.req.header('CF-Connecting-IP')?.trim();
  if (cf) return cf;
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}
