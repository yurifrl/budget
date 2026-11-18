/**
 * Server entrypoint: env parsing, boot sequence, background tick wiring, and
 * the HTTP listener. All app construction lives in app.ts; feature internals
 * behind their barrels. File path unchanged — `npm run server` targets it.
 */
import { serve } from '@hono/node-server';

import { buildApp } from './app';
import { parseIntEnv } from './core/interval';
import { readAppVersion } from './core/version';
import { startBudgetRepeatTick } from './budget';
import { assertAuthEnv, authConfigFromEnv } from './auth-env';
import { configurePluggyEnv } from './connections';
import { apiBaseUrl, authDisabled, configureAuth, DEV_EMAIL, oauthResourceUrl } from './user';
import { defaultOAuthTtls } from './oauth';
import { runMigrations } from './core/migrate';
import { configureDb } from './core/db';
import { configureOutputValidation } from './core/operation';
import { configureJobs, createTemporalClient } from './jobs';

// Unhandled rejections exit Bun with code 1 by default; log instead so a
// stray unawaited promise can't silently kill the server.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Database first (same failure order as when core/db read DATABASE_URL at import).
configureDb({ connectionString: process.env.DATABASE_URL ?? '' });

// Auth: refuse to boot unless fully configured (or AUTH_DISABLED_OK=1 locally),
// then inject the config object; features never read env themselves.
assertAuthEnv(process.env);
const auth = configureAuth(authConfigFromEnv(process.env));
configurePluggyEnv(process.env);
// Dev-only response checking against the contracts' output schemas (G9):
// API_VALIDATE_OUTPUT=warn|throw. Never in a cluster (production hot path).
const validateOutput = process.env.API_VALIDATE_OUTPUT;
if ((validateOutput === 'warn' || validateOutput === 'throw') && !process.env.KUBERNETES_SERVICE_HOST) {
  configureOutputValidation(validateOutput);
  console.log(`API_VALIDATE_OUTPUT=${validateOutput}: responses are checked against their contracts`);
}
await runMigrations();

/**
 * Signing key for OAuth tokens/CSRF: SESSION_SECRET whenever auth is on
 * (checkAuthConfig above already aborts boot unless it is >= 32 chars; this
 * re-checks so the dev key can never be reached with auth enabled). The fixed
 * dev key exists only for auth-disabled local dev, where no token is verified.
 */
function oauthSecret(): string {
  if (authDisabled()) return 'dev-only-insecure-oauth-secret-do-not-use';
  const secret = auth.sessionSecret;
  if (secret.length < 32) {
    console.error('FATAL: SESSION_SECRET must be set and >= 32 chars');
    process.exit(1);
  }
  return secret;
}

// Jobs: the API only holds a lazy Temporal client (health + cancel); the
// worker process (worker.ts) runs the relay and executes workflows.
configureJobs({
  instanceId: process.env.JOBS_INSTANCE_ID || 'budget-local',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'budget-jobs',
  uiUrl: process.env.TEMPORAL_UI_URL || null,
  temporal: createTemporalClient({
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'budget-jobs',
  }),
});

const app = buildApp({
  appOrigin: auth.appOrigin,
  adminOrigins: (process.env.ADMIN_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  version: readAppVersion(),
  mcpIssuer: apiBaseUrl(),
  oauth: {
    ...defaultOAuthTtls,
    issuer: apiBaseUrl(),
    resource: oauthResourceUrl(),
    // Same key as the session JWT (see oauthSecret).
    secret: oauthSecret(),
    // Auth disabled: /oauth/authorize acts as the dev user (consent still shown).
    devEmail: authDisabled() ? DEV_EMAIL : null,
  },
});

const port = Number(process.env.API_PORT ?? 3100);
// API_HOST narrows the bind (e.g. 127.0.0.1) for hosts where wildcard binds
// are held by privileged daemons; unset/empty = all interfaces.
serve({ fetch: app.fetch, port, hostname: process.env.API_HOST || undefined });
console.log(`Budget API listening on http://localhost:${port}`);

// Budget repeat-rule occurrence generation. Switchable so the old (syscd) and
// new API can run on one database without both generating occurrences.
const repeatTickOff = ['0', 'false', 'off', 'no'].includes((process.env.BUDGET_REPEAT_TICK ?? '').trim().toLowerCase());
if (!repeatTickOff) {
  startBudgetRepeatTick(parseIntEnv(process.env.BUDGET_REPEAT_INTERVAL_SECONDS, 86400));
} else {
  console.log('budget repeat-rule tick disabled (BUDGET_REPEAT_TICK)');
}
