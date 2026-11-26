/**
 * Jobs worker entrypoint: the Temporal worker + the outbox relay. Boot never
 * depends on Temporal being up — both loops keep retrying while it is down and
 * runs stay `queued` in the ledger meanwhile.
 *
 *   TEMPORAL_ADDRESS    host:port (default localhost:7233)
 *   TEMPORAL_NAMESPACE  default `default` locally; `budget` in prod
 *   TEMPORAL_TASK_QUEUE default `budget-jobs`
 *   JOBS_INSTANCE_ID    deployment/environment id stamped on runs (default `budget-local`)
 */
import { hostname } from 'node:os';

import { configureDb, pool } from './core/db';
import { runMigrations } from './core/migrate';
import { configureSecretsFromEnv } from './secrets-env';
import { createConnectionsActivities } from './connections/activities';
import { createCategorizeActivities } from './categorize/activities';
import { configureJevEnv } from './jev';
// Registers the `categorize_run` job type so the relay resolves its workflow.
import './categorize/job';
import {
  configurePluggyEnv,
  CONNECTIONS_SWEEP_CRON,
  CONNECTIONS_SWEEP_SCHEDULE_ID,
  PLUGGY_ACTIVITIES_PER_SECOND,
  PLUGGY_QUEUE_SUFFIX,
} from './connections';
import { createLedgerActivities } from './jobs/activities';
import { configureJobs, createTemporalClient, startRelay } from './jobs';
import { startWorkerHost } from './jobs/worker-host';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

configureDb({ connectionString: process.env.DATABASE_URL ?? '' });

const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const namespace = process.env.TEMPORAL_NAMESPACE || 'default';
const taskQueue = process.env.TEMPORAL_TASK_QUEUE || 'budget-jobs';
const instanceId = process.env.JOBS_INSTANCE_ID || 'budget-local';
const workerId = `${hostname()}:${process.pid}`;

configurePluggyEnv(process.env);
configureJevEnv(process.env);
// Same master key as the API: the sync activities decrypt users' own provider secrets.
configureSecretsFromEnv(process.env);
await runMigrations();

configureJobs({ instanceId, taskQueue });
const temporal = createTemporalClient({ address, namespace, taskQueue });

// trackedAttempt is stripped from the Temporal-visible bag; features that
// write attempts (connections) receive it by injection instead.
const { trackedAttempt, ...ledgerActivities } = createLedgerActivities(pool, workerId);
const activities = {
  ...ledgerActivities,
  ...createConnectionsActivities(pool, trackedAttempt),
  ...createCategorizeActivities(pool, trackedAttempt),
};

const worker = startWorkerHost({
  address,
  namespace,
  taskQueue,
  activities,
  // Provider-calling activities run on their own queue so the ~1/s limit
  // (shared across pods, enforced server-side) never throttles ledger writes.
  activityQueues: [
    { taskQueue: `${taskQueue}${PLUGGY_QUEUE_SUFFIX}`, maxTaskQueueActivitiesPerSecond: PLUGGY_ACTIVITIES_PER_SECOND },
  ],
  onConnected: async () => {
    await temporal.ensureRetentionSchedule();
    await temporal.ensureSchedule({ scheduleId: CONNECTIONS_SWEEP_SCHEDULE_ID, workflowType: 'connectionsSweep', cron: CONNECTIONS_SWEEP_CRON });
  },
});
const relay = startRelay({ pool, starter: temporal.starter, instanceId, defaultTaskQueue: taskQueue });
console.log(`jobs worker ${workerId} up (instance=${instanceId}, ${namespace}/${taskQueue} @ ${address})`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([relay.stop(), worker.stop()]);
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
