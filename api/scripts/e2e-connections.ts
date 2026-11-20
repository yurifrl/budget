/**
 * End-to-end demo of connections-sync-on-Temporal with a FAKE bank adapter
 * (no Pluggy credentials needed). Subcommands, run against a Temporal dev
 * server and a Postgres DATABASE_URL:
 *
 *   setup            migrate + create user/connection fixtures (prints ids)
 *   worker           ledger+connections worker, relay, schedules (until killed)
 *   request [mode]   API role: POST /connections/:id/sync|reimport, print the run
 *   status           API role: GET /connections/sync-status
 *   wait <runId>     poll the ledger until the run is terminal
 *   sweep            start the connections-sweep workflow once and print its result
 *   cleanup          drop fixtures
 *
 *   DATABASE_URL=... TEMPORAL_ADDRESS=localhost:7243 bun scripts/e2e-connections.ts setup
 */
import { hostname } from 'node:os';

import { Hono } from 'hono';

import { createConnectionsActivities } from '../src/connections/activities';
import { default as connectionsApp } from '../src/connections';
import { setAggregators, type AggregatorEntry } from '../src/connections/registry';
import * as store from '../src/connections/store';
import type { BankAggregator } from '../src/connections/types';
import { CONNECTIONS_SWEEP_CRON, CONNECTIONS_SWEEP_SCHEDULE_ID, PLUGGY_ACTIVITIES_PER_SECOND, PLUGGY_QUEUE_SUFFIX } from '../src/connections';
import { configureDb, pool } from '../src/core/db';
import { runMigrations } from '../src/core/migrate';
import { httpOnError } from '../src/core/validate';
import { configureJobs, createTemporalClient, startRelay } from '../src/jobs';
import { createLedgerActivities } from '../src/jobs/activities';
import { startWorkerHost } from '../src/jobs/worker-host';

configureDb({ connectionString: process.env.DATABASE_URL ?? '' });

const PROVIDER = 'e2efake';
const USER_ID = '00000000-0000-4000-8000-00000000e2e1';
const ITEM = 'e2e-fake-item';
const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const namespace = process.env.TEMPORAL_NAMESPACE || 'default';
const taskQueue = process.env.TEMPORAL_TASK_QUEUE || 'budget-jobs';
const instanceId = process.env.JOBS_INSTANCE_ID ?? 'e2e';

/** Fake bank: a healthy item that reports newer data than any watermark. */
const fake: BankAggregator = {
  environment: 'production',
  verifyCredentials: async () => true,
  createConnectToken: async () => ({ token: 't', clientId: null, widgetUrl: null }),
  listExternalAccounts: async () => [],
  listTransactions: async () => {
    await new Promise((r) => setTimeout(r, 700)); // visible "syncing" window
    return { transactions: [], hasMore: false };
  },
  deleteConnection: async () => {},
  fetchInstitution: async () => 'E2E Fake Bank',
  getItemState: async () => ({ status: 'connected', lastUpdatedAt: new Date(Date.now() + 60_000).toISOString() }),
  mapWebhookDelivery: () => null,
  mapStatus: () => 'connected',
  verifyWebhookHeaders: () => true,
};
const entry: AggregatorEntry = { configured: () => true, create: () => fake };
setAggregators({ [PROVIDER]: entry });

configureJobs({ instanceId, taskQueue });
const temporal = createTemporalClient({ address, namespace, taskQueue });
configureJobs({ temporal }); // the API role needs health()

const api = new Hono();
api.onError(httpOnError);
api.use('/connections/*', async (c, next) => {
  c.set('user' as never, { id: USER_ID } as never);
  await next();
});
api.route('/connections', connectionsApp);

const json = async (res: Response) => ({ http: res.status, ...(await res.json()) });
const connectionId = async () => (await store.listConnectionsByUser(USER_ID))[0]!.id;
const [cmd = '', arg] = process.argv.slice(2);

async function main(): Promise<void> {
  await runMigrations();
  if (cmd === 'setup') {
    await pool.query('delete from public.users where id = $1', [USER_ID]);
    await pool.query(
      `insert into public.users (id, google_sub, email, role, status) values ($1, $2, 'e2e-connections@syscd.local', 'user', 'active')`,
      [USER_ID, USER_ID],
    );
    // The fake connection runs on the shared keys: this user may use them (else it is paused).
    await pool.query(`insert into public.feature_overrides (feature_key, user_id, value) values ('shared-pluggy-key', $1, true)`, [USER_ID]);
    const row = await store.upsertConnection({ userId: USER_ID, provider: PROVIDER, externalId: ITEM, status: 'connected', environment: 'production' });
    console.log(JSON.stringify({ connectionId: row.id }));
  } else if (cmd === 'request') {
    const id = await connectionId();
    console.log(JSON.stringify(await json(await api.request(`/connections/${id}/${arg ?? 'sync'}`, { method: 'POST' })), null, 2));
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await json(await api.request('/connections/sync-status')), null, 2));
  } else if (cmd === 'wait') {
    const end = Date.now() + 60_000;
    for (;;) {
      const { rows } = await pool.query('select id, status, attempts, user_message, result, temporal_workflow_id from jobs.job_runs where id = $1', [arg]);
      if (rows[0] && !['queued', 'running'].includes(rows[0].status)) {
        console.log(JSON.stringify(rows[0]));
        break;
      }
      if (Date.now() > end) throw new Error(`timeout waiting for ${arg}: ${rows[0]?.status}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    const conn = await store.getConnectionById(await connectionId());
    console.log(JSON.stringify({ connection: { status: conn?.status, last_synced_at: conn?.last_synced_at } }));
    const logs = await pool.query('select level, message from jobs.job_logs where run_id = $1 order by id', [arg]);
    console.log('logs:', JSON.stringify(logs.rows));
  } else if (cmd === 'sweep') {
    const out = await temporal.client.workflow.execute('connectionsSweep', { taskQueue, workflowId: `e2e-sweep-${Date.now()}`, args: [] });
    console.log('sweep result:', JSON.stringify(out));
    const sched = await temporal.client.schedule.getHandle(CONNECTIONS_SWEEP_SCHEDULE_ID).describe();
    console.log('schedule:', sched.scheduleId, JSON.stringify(sched.spec.calendars));
  } else if (cmd === 'cleanup') {
    await pool.query('delete from jobs.job_runs where tenant_id = $1', [USER_ID]);
    await pool.query('delete from public.users where id = $1', [USER_ID]);
    console.log('cleaned');
  } else if (cmd === 'worker') {
    const workerId = `${hostname()}:${process.pid}`;
    const { trackedAttempt, ...ledger } = createLedgerActivities(pool, workerId);
    const activities = { ...ledger, ...createConnectionsActivities(pool, trackedAttempt) };
    startWorkerHost({
      address,
      namespace,
      taskQueue,
      activities,
      activityQueues: [{ taskQueue: `${taskQueue}${PLUGGY_QUEUE_SUFFIX}`, maxTaskQueueActivitiesPerSecond: PLUGGY_ACTIVITIES_PER_SECOND }],
      onConnected: async () => {
        await temporal.ensureRetentionSchedule();
        await temporal.ensureSchedule({ scheduleId: CONNECTIONS_SWEEP_SCHEDULE_ID, workflowType: 'connectionsSweep', cron: CONNECTIONS_SWEEP_CRON });
      },
    });
    startRelay({ pool, starter: temporal.starter, instanceId, defaultTaskQueue: taskQueue });
    console.log(`e2e worker up (${namespace}/${taskQueue} @ ${address})`);
    await new Promise(() => undefined); // until killed
    return;
  } else {
    throw new Error(`unknown subcommand "${cmd}"`);
  }
  await pool.end();
  process.exit(0);
}

await main();
