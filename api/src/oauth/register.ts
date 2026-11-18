import { Hono } from 'hono';
import { z } from '@shared/zod';

import type { OAuthConfig } from './config';
import { BodyError, oauthError, readJsonBody } from './http';
import { createClient } from './store';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const APP_SCHEME_ALLOWLIST = new Set(['cursor', 'vscode', 'vscode-insiders', 'windsurf', 'claude']);
const FORBIDDEN_SCHEMES = new Set(['javascript', 'data', 'file', 'about', 'blob', 'vbscript', 'ftp', 'ws', 'wss']);

/** Private-use URI scheme (RFC 8252 section 7.1): reverse-DNS style (has a dot) or allowlisted app scheme. */
function validCustomScheme(scheme: string): boolean {
  if (FORBIDDEN_SCHEMES.has(scheme) || !/^[a-z][a-z0-9+.-]*$/.test(scheme)) return false;
  return scheme.includes('.') || APP_SCHEME_ALLOWLIST.has(scheme);
}

/**
 * https, http on a loopback host, or a private-use custom scheme (native/CLI/desktop
 * clients). No userinfo, no fragment.
 */
export function validRedirectUri(raw: string): boolean {
  if (raw.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash || raw.includes('#')) return false;
  if (u.protocol === 'https:') return u.hostname.length > 0;
  if (u.protocol === 'http:') return LOOPBACK_HOSTS.has(u.hostname);
  return validCustomScheme(u.protocol.slice(0, -1));
}

const nameSchema = z
  .string()
  .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim())
  .pipe(z.string().min(1).max(100));

const bodySchema = z.object({
  client_name: nameSchema.optional(),
  redirect_uris: z.array(z.string()).min(1).max(5),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
  response_types: z.array(z.literal('code')).optional(),
});

/** RFC 7591 dynamic registration, public clients only. */
export function registerRoutes(cfg: OAuthConfig): Hono {
  const app = new Hono();
  app.post('/oauth/register', async (c) => {
    let raw: Record<string, unknown>;
    try {
      raw = await readJsonBody(c);
    } catch (err) {
      return oauthError(c, 'invalid_client_metadata', err instanceof BodyError ? err.message : 'invalid body');
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return oauthError(c, 'invalid_client_metadata', 'invalid client metadata');
    const uris = parsed.data.redirect_uris;
    if (!uris.every(validRedirectUri) || new Set(uris).size !== uris.length) {
      return oauthError(c, 'invalid_redirect_uri', 'redirect_uris must be unique https URLs, http loopback URLs or private-use app scheme URIs, without fragments');
    }
    const name = parsed.data.client_name ?? 'Unnamed application';
    const client = await createClient(name, uris, cfg.registerPerHour);
    if (!client) return oauthError(c, 'temporarily_unavailable', 'registration rate limit reached', 429);
    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_id_issued_at: Math.floor(Date.now() / 1000),
      },
      201,
    );
  });
  return app;
}
