/**
 * End-to-end demo of the jobs foundation against a running worker
 * (`bun src/worker.ts`) and a Temporal dev server (compose `temporal` service via `task deps`).
 * Enqueues jobs_noop runs (success, failure, cancel) and waits for the ledger.
 *   DATABASE_URL=... JOBS_INSTANCE_ID=e2e bun scripts/e2e-jobs.ts
 */
import { configureDb, pool } from '../src/core/db';
import { runMigrations } from '../src/core/migrate';
import { configureJobs, createTemporalClient, enqueueJob } from '../src/jobs';

const instanceId = process.env.JOBS_INSTANCE_ID || 'budget-local';
configureJobs({ instanceId });
configureDb({ connectionString: process.env.DATABASE_URL ?? '' });
await runMigrations();
const temporal = createTemporalClient({
  address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  namespace: process.env.TEMPORAL_NAMESPACE || 'default',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'budget-jobs',
});

async function waitFor(id: string, statuses: string[], ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const { rows } = await pool.query('select * from jobs.job_runs where id = $1', [id]);
    if (statuses.includes(rows[0].status)) return rows[0];
    if (Date.now() > end) throw new Error(`timeout waiting for ${id}: ${rows[0].status}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`E2E FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
}

console.log('health:', await temporal.health());

const ok = (await enqueueJob(pool, { jobType: 'jobs_noop', subjectKey: `e2e-ok-${Date.now()}`, input: { sleepMs: 500 } })).run;
const okRow = await waitFor(ok.id, ['succeeded', 'failed']);
assert(okRow.status === 'succeeded', `noop succeeded (attempts=${okRow.attempts}, workflow=${okRow.temporal_workflow_id})`);
const logs = (await pool.query('select message from jobs.job_logs where run_id = $1 order by id', [ok.id])).rows;
assert(logs.length === 2, `ctx.log lines stored in job_logs: ${logs.map((l) => l.message).join(' | ')}`);
const att = (await pool.query('select status, worker_id from jobs.job_attempts where run_id = $1', [ok.id])).rows;
assert(att.length === 1 && att[0].status === 'succeeded', `attempt recorded by ${att[0]?.worker_id}`);

const bad = (await enqueueJob(pool, { jobType: 'jobs_noop', subjectKey: `e2e-bad-${Date.now()}`, input: { sleepMs: 0, fail: true } })).run;
const badRow = await waitFor(bad.id, ['succeeded', 'failed'], 60_000);
assert(badRow.status === 'failed' && String(badRow.error_message).includes('noop job asked to fail'), `failure closed run: ${badRow.error_message} (attempts=${badRow.attempts})`);

const slow = (await enqueueJob(pool, { jobType: 'jobs_noop', subjectKey: `e2e-slow-${Date.now()}`, input: { sleepMs: 30000 } })).run;
const running = await waitFor(slow.id, ['running']);
await temporal.cancel(running.temporal_workflow_id);
const cancelled = await waitFor(slow.id, ['cancelled', 'failed']);
assert(cancelled.status === 'cancelled', 'running run cancelled via Temporal');

const sched = await temporal.client.schedule.getHandle('jobs-retention').describe();
assert(sched.scheduleId === 'jobs-retention', `retention schedule present: ${JSON.stringify(sched.spec.calendars)}`);

console.log('E2E PASS');
await pool.end();
process.exit(0);
