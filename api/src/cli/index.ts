/**
 * CLI feature: commands generated from the operation catalog, plus OAuth
 * login. Public surface only — see ./run.ts for the runner.
 */
export { runCli, type CliDeps } from './run';
export { getAccessToken, AuthError, type TokenDeps, type FetchLike } from './auth';
export { resolveConfigDir, normalizeApiUrl } from './credentials';
