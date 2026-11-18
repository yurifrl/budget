/** Connections feature barrel: routes (post-gate), webhook sink (pre-gate), sync job registration. */
import type { AnyOperation } from '../core/operation';
import connections, { operations as routeOperations } from './routes';

export const operations: readonly AnyOperation[] = [...routeOperations];

export default connections;
export { default as webhook } from './webhook';
// Provider env, handed over by the entrypoints (features never read process.env).
export { configurePluggyEnv } from './adapters/pluggy/client';
// Importing the barrel registers the `connections_sync` job type (API + worker).
export { enqueueConnectionSync } from './job';
export {
  CONNECTIONS_SWEEP_CRON,
  CONNECTIONS_SWEEP_SCHEDULE_ID,
  PLUGGY_ACTIVITIES_PER_SECOND,
  PLUGGY_QUEUE_SUFFIX,
} from './jobspec';
// What budget reads/writes in the connections tables (account linking, card-payment pairing).
export { blockImportShadows, blockedImportShadowIds, findUserConnection } from './ledger-reads';
