/**
 * End-to-end run of `categorize_run` against a real Temporal dev server
 * (compose `temporal` on :57233) with a FAKE AI provider (no key, no HTTP).
 * One process: fixtures in Postgres, the workflow bundle + activities hosted by
 * an in-process worker on its own task queue (and its `-ai` queue), a ledger
 * row enqueued and the workflow started directly.
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55432/budgetnew_dev \
 *   TEMPORAL_ADDRESS=localhost:57233 bun api/scripts/e2e-categorize.ts
 *
 * It proves what unit tests cannot: the workflow registered in the bundle
 * runs, its prepare/chunk activities cross the `-ai` task queue, the ledger
 * gets counts and token usage, and a budget without a key ends at once with
 * the user-safe sentence.
 */
import { hostname } from 'node:os';

import { AI_PROVIDERS, type AiProviderId } from '@shared/contracts/ai';

import type { AiChatRequest, AiChatResult, AiProvider } from '../src/ai';
import { configureAiEnv, storeOwnKey } from '../src/ai';
import type { ProviderEntry } from '../src/ai/providers';
import { setProviders } from '../src/ai/providers';
import { AI_QUEUE_SUFFIX, startCategorizeRun } from '../src/categorize';
import { createCategorizeActivities } from '../src/categorize/activities';
import { configureDb, pool } from '../src/core/db';
import { runMigrations } from '../src/core/migrate';
import { configureSecretBox } from '../src/core/secret-box';
import { configureJobs, createTemporalClient } from '../src/jobs';
import { createLedgerActivities } from '../src/jobs/activities';
import { startWorkerHost } from '../src/jobs/worker-host';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
configureDb({ connectionString: process.env.DATABASE_URL });
configureAiEnv({});
configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });

const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const namespace = process.env.TEMPORAL_NAMESPACE || 'default';
// Its own queue: never steal tasks from a dev worker polling `budget-jobs`.
const taskQueue = process.env.TEMPORAL_TASK_QUEUE || 'budget-jobs-e2e-categorize';
const instanceId = process.env.JOBS_INSTANCE_ID || 'budget-e2e-categorize';
const OWNER = crypto.randomUUID();
const KEY = 'sk-e2e-categorize-0123456789abcdef';
const MODEL = 'fake-model';

let providerCalls = 0;
const fake: ProviderEntry = {
  baseUrl: 'https://fake.test',
  create: (apiKey: string): AiProvider => ({
    id: 'openai',
    async chat(_request: AiChatRequest): Promise<AiChatResult> {
      providerCalls++;
      if (apiKey !== KEY) throw new Error('the run did not use the fixtures key');
      return {
        text: JSON.stringify({ suggestions: [{ category_id: grocery, confidence: 0.9, reason: 'e2e grocery' }] }),
        toolCalls: [],
        model: MODEL,
        finishReason: 'stop',
        usage: { input: 40, output: 12 },
      };
    },
    async verifyKey() {
      return null;
    },
    async listModels() {
      return [];
    },
  }),
};
let grocery = '';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`E2E FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

async function waitForRun(runId: string, ms = 90_000): Promise<Record<string, unknown>> {
  const end = Date.now() + ms;
  for (;;) {
    const { rows } = await pool.query('select * from jobs.job_runs where id = $1', [runId]);
    const row = rows[0];
    if (['succeeded', 'failed', 'cancelled'].includes(row?.status)) return row;
    if (Date.now() > end) throw new Error(`timeout waiting for ${runId}: status ${row?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function startRun(budgetId: string): Promise<string> {
  // The real start path: it derives the run's actor (the owner) itself and
  // stores { force } in the job input.
  const { run } = await startCategorizeRun(pool, { budgetId, requestedBy: OWNER });
  await temporal.client.workflow.start('categorizeRun', {
    taskQueue,
    workflowId: `categorize-e2e-${run.id}`,
    args: [{ runId: run.id, jobType: run.job_type, subjectKey: budgetId, tenantId: run.tenant_id, input: run.input }],
  });
  return run.id;
}

configureJobs({ instanceId, taskQueue });
const temporal = createTemporalClient({ address, namespace, taskQueue });

const workerId = `${hostname()}:${process.pid}:e2e`;
const { trackedAttempt, ...ledgerActivities } = createLedgerActivities(pool, workerId);
const worker = startWorkerHost({
  address,
  namespace,
  taskQueue,
  activities: { ...ledgerActivities, ...createCategorizeActivities(pool, trackedAttempt) },
  activityQueues: [
    { taskQueue: `${taskQueue}${AI_QUEUE_SUFFIX}`, maxTaskQueueActivitiesPerSecond: 50, maxConcurrentActivityTaskExecutions: 1 },
  ],
});

const budgets: string[] = [];
try {
  await runMigrations();
  console.log(`health: ${JSON.stringify(await temporal.health())}`);

  // --- fixtures: one budget with a key, two uncategorized transactions ---------
  const budgetId = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const restaurant = crypto.randomUUID();
  grocery = crypto.randomUUID();
  const payeeId = crypto.randomUUID();
  const freeTxn = crypto.randomUUID();
  const ruleTxn = crypto.randomUUID();
  budgets.push(budgetId);
  await pool.query(`insert into public.users (id, email, role) values ($1, $2, 'user')`, [OWNER, `e2e-categorize-${OWNER}@budget.test`]);
  await pool.query(`insert into public.budgets (id, name, owner_user_id) values ($1, 'E2E categorize', $2)`, [budgetId, OWNER]);
  await pool.query(`insert into public.category_groups (id, budget_id, name) values ($1, $2, 'Everyday')`, [groupId, budgetId]);
  await pool.query(
    `insert into public.categories (id, budget_id, group_id, name) values ($1, $2, $3, 'Restaurants'), ($4, $2, $3, 'Groceries')`,
    [restaurant, budgetId, groupId, grocery],
  );
  await pool.query(
    `insert into public.accounts (id, budget_id, name, type, account_group) values ($1, $2, 'Checking', 'checking', 'CASH')`,
    [accountId, budgetId],
  );
  // Fixed payee: the existing rule answers, the model must not be called.
  await pool.query(
    `insert into public.payees (id, budget_id, name, categorization_mode, default_category_id) values ($1, $2, 'Cafe', 'fixed', $3)`,
    [payeeId, budgetId, restaurant],
  );
  await pool.query(
    `insert into public.transactions (id, budget_id, account_id, date, amount, import_payee_name) values ($1, $2, $3, '2026-11-10', -4500, 'MERCADO CENTRAL')`,
    [freeTxn, budgetId, accountId],
  );
  await pool.query(
    `insert into public.transactions (id, budget_id, account_id, date, amount, payee_id) values ($1, $2, $3, '2026-11-11', -1800, $4)`,
    [ruleTxn, budgetId, accountId, payeeId],
  );
  // The owner's own key, sealed exactly like the API stores it.
  await storeOwnKey(pool, OWNER, 'openai', KEY, MODEL);

  setProviders(Object.fromEntries(AI_PROVIDERS.map((id) => [id, fake])) as Record<AiProviderId, ProviderEntry>);

  const runId = await startRun(budgetId);
  const finished = await waitForRun(runId);
  assert(finished.status === 'succeeded', `categorize_run succeeded (attempts=${finished.attempts})`);
  const result = finished.result as Record<string, number | string | null>;
  assert(result.total === 2 && result.done === 2, `prepared and walked both transactions: ${JSON.stringify(result)}`);
  assert(result.rule === 1, 'the payee-rule transaction was answered without the model');
  assert(result.suggested === 1, 'the free transaction got a model suggestion');
  assert(result.failed === 0 && result.stopped === null, 'no failures and no early stop');
  assert(Number(result.input_tokens) > 0 && Number(result.output_tokens) > 0, `token usage recorded: in=${result.input_tokens} out=${result.output_tokens}`);
  assert(finished.user_message === null, 'no user message on a clean run');

  const suggestions = (await pool.query(
    `select transaction_id, rank, category_id, source, provider, model, confidence from public.category_suggestions where budget_id = $1 order by transaction_id, rank`,
    [budgetId],
  )).rows;
  assert(suggestions.length === 2, `two suggestion rows written: ${JSON.stringify(suggestions)}`);
  assert(
    suggestions.some((row) => row.source === 'ai' && row.category_id === grocery && row.provider === 'openai' && row.model === MODEL),
    'ai suggestion carries provider/model/category',
  );
  assert(
    suggestions.some((row) => row.source === 'payee_rule' && row.category_id === restaurant),
    'payee-rule suggestion recorded with source payee_rule',
  );
  const categorized = (await pool.query(`select count(*)::int as n from public.transactions where budget_id = $1 and category_id is not null`, [budgetId]))
    .rows[0].n;
  assert(categorized === 0, 'the job never wrote transactions.category_id');

  const logs = (await pool.query(`select message, fields from jobs.job_logs where run_id = $1 order by id`, [runId])).rows;
  assert(logs.some((row) => row.message === 'categorize chunk done' && row.fields?.done === 2), 'progress (done/total) landed in the jobs ledger');

  // --- a budget with no usable key ends at once, not in a failure storm --------
  const bareBudget = crypto.randomUUID();
  const bareGroup = crypto.randomUUID();
  const bareAccount = crypto.randomUUID();
  budgets.push(bareBudget);
  await pool.query(`insert into public.budgets (id, name, owner_user_id) values ($1, 'E2E no key', $2)`, [bareBudget, OWNER]);
  await pool.query(`insert into public.category_groups (id, budget_id, name) values ($1, $2, 'Everyday')`, [bareGroup, bareBudget]);
  await pool.query(`insert into public.accounts (id, budget_id, name, type, account_group) values ($1, $2, 'Checking', 'checking', 'CASH')`, [bareAccount, bareBudget]);
  await pool.query(
    `insert into public.transactions (id, budget_id, account_id, date, amount, import_payee_name) values ($1, $2, $3, '2026-11-12', -999, 'ANY STORE')`,
    [crypto.randomUUID(), bareBudget, bareAccount],
  );
  // The owner has a key above, so this budget's run WOULD use it; drop it to model "no key".
  await pool.query('delete from public.ai_credentials where user_id = $1', [OWNER]);
  const callsBefore = providerCalls;
  const bareRunId = await startRun(bareBudget);
  const bare = await waitForRun(bareRunId);
  assert(bare.status === 'succeeded', 'a key-less run is recorded as succeeded with a notice');
  assert(String(bare.user_message).includes('Add your own AI key'), `clear user-safe reason stored: ${bare.user_message}`);
  assert((bare.result as Record<string, unknown>).stopped === 'own_key_required', 'stopped reason is own_key_required');
  assert(providerCalls === callsBefore, 'no provider call was made without a key');

  console.log('E2E PASS');
} finally {
  await worker.stop().catch(() => undefined);
  if (budgets.length > 0) await pool.query('delete from public.budgets where id = any($1::uuid[])', [budgets]).catch(() => undefined);
  await pool.query('delete from public.users where id = $1', [OWNER]).catch(() => undefined);
  setProviders(null);
  await pool.end().catch(() => undefined);
}
