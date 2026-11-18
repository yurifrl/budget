/**
 * OAuth 2.1 authorization server for MCP clients and the CLI. We are our own
 * AS (public clients, PKCE S256, rotating refresh tokens); only the human
 * login is delegated to the existing Google flow in server/user. Mount
 * BEFORE the auth gate — these endpoints authenticate themselves.
 */
import { Hono } from 'hono';

import { authorizeRoutes } from './authorize';
import type { OAuthConfig } from './config';
import { metadataRoutes } from './metadata';
import { registerRoutes } from './register';
import { tokenRoutes } from './token';

export type { OAuthConfig } from './config';
export { defaultOAuthTtls } from './config';

export function createOAuthRouter(cfg: OAuthConfig): Hono {
  if (cfg.secret.length < 32) throw new Error('oauth: secret must be at least 32 characters');
  const app = new Hono();
  app.route('/', metadataRoutes(cfg));
  app.route('/', registerRoutes(cfg));
  app.route('/', authorizeRoutes(cfg));
  app.route('/', tokenRoutes(cfg));
  return app;
}

export { default as grantsRoutes, operations } from './grants-routes';
