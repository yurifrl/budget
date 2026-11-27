/**
 * Builds the full HTTP app: middleware, auth routes, feature mounts. Pure —
 * no env access, no side effects, no server startup — so entrypoints
 * (index.ts) and tests can both consume it.
 *
 * Registration order preserves URL behavior exactly:
 *  - `/health` responds before the auth gate (public liveness probe).
 *  - Pre-gate: auth routes + the two agent-client sinks that do their own
 *    auth (channel config, connections webhook).
 *  - `authMiddleware` + `requireUser` gate everything mounted after them.
 *  - Post-gate: features, budget (its routers carry their own prefixes),
 *    rates, connections routes, jobs admin.
 */
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';

import budget from './budget';
import categorize from './categorize/router';
import connections, { webhook as connectionsWebhook } from './connections';
import { featuresRoutes } from './features';
import jev from './jev';
import { contracts } from './catalog';
import { createMcpRouter } from './mcp/index';
import { createOAuthRouter, grantsRoutes, type OAuthConfig } from './oauth';
import jobs from './jobs';
import rates from './rates';
import { authMiddleware, mountAuthRoutes } from './user/authz';
import { accessPrincipal, adminUsersRoutes, authDisabled, passwordChangeRoutes, profileRoutes, requireUser } from './user';
import { httpOnError, errorResponse } from './core/validate';

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

interface BuildAppParams {
  /** First CORS origin; the fixed local-dev origins are always included. */
  appOrigin: string;
  /** Extra CORS origins (the admin SPA); read from ADMIN_ORIGIN in the entrypoint. */
  adminOrigins?: string[];
  /** Release version (root VERSION file) reported by the public /health probe. */
  version: string;
  /** OAuth authorization-server config; omitted = AS not mounted. */
  oauth?: OAuthConfig;
  /** Issuer origin for the /mcp 401 challenge; omitted = /mcp not mounted. */
  mcpIssuer?: string;
}

export function buildApp({ appOrigin, adminOrigins = [], version, oauth, mcpIssuer }: BuildAppParams): Hono {
  const app = new Hono();

  // Browser origins allowed to call the API with credentials (CORS): the app,
  // the admin SPA and the fixed local-dev origins.
  const devOrigins = [
    'http://localhost:8081',
    'http://localhost:8082',
    'http://localhost:19006',
    'http://localhost:8091', // budget web dev server (task web)
    'http://localhost:3100',
    'http://localhost:5174', // admin SPA dev server (task admin)
    'http://localhost:5191', // admin SPA dev server (task run)
  ];
  const corsOrigins = [appOrigin, ...adminOrigins, ...devOrigins];
  // The password and admin-user routes also refuse any other Origin (CSRF
  // guard). The localhost dev origins count there only when the app itself
  // runs on localhost (local dev); a deployment trusts its app and admin
  // origins alone.
  const trustedOrigins = LOCAL_ORIGIN.test(appOrigin) ? corsOrigins : [appOrigin, ...adminOrigins];

  app.use(
    cors({
      origin: corsOrigins,
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
      // Retry-After: the web app reads it on a 429 (password sign-in throttle).
      exposeHeaders: ['WWW-Authenticate', 'Retry-After'],
      credentials: true,
    }),
  );

  // Response compression. The register/plan payloads are megabytes of JSON
  // (a full transaction list is ~4 MB) and clients reach this API over a
  // tunnel at a few hundred KB/s: uncompressed bytes cost the user seconds on
  // every load and every refetch. `/mcp` is excluded because it streams SSE.
  const compressResponses = compress();
  app.use('*', (c, next) => (c.req.path.startsWith('/mcp') ? next() : compressResponses(c, next)));

  // Simple healthcheck (public, pre-gate) — carries the release version so
  // the app's /stats page can show which API build it is talking to.
  app.get('/health', (c) => c.json({ ok: true, version }));

  // Agent (hermes) client routes
  mountAuthRoutes(app, { trustedOrigins });

  // OAuth authorization server (discovery, registration, consent, tokens):
  // pre-gate, each endpoint authenticates itself.
  if (oauth) app.route('/', createOAuthRouter(oauth));

  // MCP endpoint (Streamable HTTP): pre-gate, does its own OAuth-access-token
  // check; tools execute by dispatching back into this app with the bearer.
  if (mcpIssuer) {
    app.route(
      '/',
      createMcpRouter({
        contracts,
        dispatch: (req) => Promise.resolve(app.fetch(req)),
        resourceMetadataUrl: `${mcpIssuer}/.well-known/oauth-protected-resource`,
        authenticate: accessPrincipal,
        authDisabled,
      }),
    );
  }

  // Connections webhook sink (agents POST status updates; route does its own
  // adapter secret check)
  app.route('/connections', connectionsWebhook);

  // Everything below requires a valid, allow-listed session.
  app.use('*', authMiddleware);
  // Identity seam (D-05): after the gate, every principal resolves to a
  // DB-authoritative user row; roles/status are read per request.
  app.use('*', requireUser);

  // Profile + avatars (/me, /users/:id/avatar)
  app.route('/', profileRoutes);

  // Change password (first-party session) and admin user management.
  app.route('/', passwordChangeRoutes({ trustedOrigins }));
  app.route('/', adminUsersRoutes({ trustedOrigins }));

  // Features: the caller's own values (/features) and the admin toggles (/admin/features).
  app.route('/', featuresRoutes({ trustedOrigins }));

  // Connected apps (OAuth grants of the caller)
  app.route('/', grantsRoutes);

  // Budget routes
  app.route('/', budget);

  // Categorize page routes (/categorize/..., behind budgetAccess)
  app.route('/categorize', categorize);

  // Rates routes
  app.route('/rates', rates);

  // Connections routes
  app.route('/connections', connections);

  // The caller's own Jev key (/jev/key, user-scoped)
  app.route('/jev', jev);

  // Jobs admin routes (requireAdmin is applied by the router itself)
  app.route('/jobs', jobs);

  app.onError(httpOnError);

  // 404 handler
  app.notFound((c) => {
    return errorResponse(c, 404, 'not found');
  });

  return app;
}
