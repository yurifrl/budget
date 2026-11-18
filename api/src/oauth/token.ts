import { Hono } from 'hono';

import { issueAccessToken, verifyAccessToken } from '../user';
import type { OAuthConfig } from './config';
import { pkceMatches } from './crypto';
import { BodyError, oauthError, readParams } from './http';
import { getClient, issueRefreshToken, redeemCode, revokeByRefreshToken, revokeGrant, rotateRefreshToken } from './store';

export function tokenRoutes(cfg: OAuthConfig): Hono {
  const app = new Hono();

  const respond = async (
    c: Parameters<typeof oauthError>[0],
    t: { email: string; scope: string; clientId: string; grantId: string; refreshToken: string },
  ) => {
    const accessToken = await issueAccessToken(
      cfg.secret,
      { email: t.email, scope: t.scope, clientId: t.clientId, grantId: t.grantId, audience: cfg.resource },
      cfg.accessTtlSeconds,
    );
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: cfg.accessTtlSeconds,
      refresh_token: t.refreshToken,
      scope: t.scope,
    });
  };

  app.post('/oauth/token', async (c) => {
    let p: Record<string, string>;
    try {
      p = await readParams(c);
    } catch (err) {
      return oauthError(c, 'invalid_request', err instanceof BodyError ? err.message : 'bad request');
    }
    const client = await getClient(p.client_id ?? '');
    if (!client) return oauthError(c, 'invalid_client', 'unknown client', 401);
    if (p.resource !== undefined && p.resource !== cfg.resource) return oauthError(c, 'invalid_target', 'unknown resource');

    if (p.grant_type === 'authorization_code') {
      if (!p.code || !p.code_verifier || !p.redirect_uri) {
        return oauthError(c, 'invalid_request', 'code, redirect_uri and code_verifier are required');
      }
      const grant = await redeemCode(p.code);
      if (!grant) return oauthError(c, 'invalid_grant', 'invalid, expired or already used code');
      // The code is spent regardless; any mismatch also kills its grant.
      if (grant.clientId !== client.clientId || grant.redirectUri !== p.redirect_uri || !pkceMatches(p.code_verifier, grant.codeChallenge)) {
        await revokeGrant(grant.grantId);
        return oauthError(c, 'invalid_grant', 'code verification failed');
      }
      const refreshToken = await issueRefreshToken(grant.grantId);
      return respond(c, { email: grant.email, scope: grant.scope, clientId: grant.clientId, grantId: grant.grantId, refreshToken });
    }

    if (p.grant_type === 'refresh_token') {
      if (!p.refresh_token) return oauthError(c, 'invalid_request', 'refresh_token is required');
      const rotated = await rotateRefreshToken(p.refresh_token, client.clientId);
      if (!rotated) return oauthError(c, 'invalid_grant', 'invalid or revoked refresh token');
      return respond(c, rotated);
    }

    return oauthError(c, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  });

  /** RFC 7009. Always 200 for well-formed requests; never discloses token validity. */
  app.post('/oauth/revoke', async (c) => {
    let p: Record<string, string>;
    try {
      p = await readParams(c);
    } catch (err) {
      return oauthError(c, 'invalid_request', err instanceof BodyError ? err.message : 'bad request');
    }
    c.header('Cache-Control', 'no-store');
    if (!p.token) return oauthError(c, 'invalid_request', 'token is required');
    const clientId = p.client_id || null;
    // An access token revokes its whole grant (and so its refresh tokens too).
    const access = await verifyAccessToken(cfg.secret, p.token, cfg.resource);
    if (access) {
      if (clientId === null || clientId === access.clientId) await revokeGrant(access.grantId);
    } else {
      await revokeByRefreshToken(p.token, clientId);
    }
    return c.body(null, 200);
  });

  return app;
}
