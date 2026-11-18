/**
 * Outbox relay: hands `queued` ledger rows to Temporal. One row per
 * transaction (FOR UPDATE SKIP LOCKED, safe with several worker pods); the
 * workflow id is the run id, so a repeated start is a no-op. When Temporal is
 * unreachable the row stays `queued` and the loop backs off — nothing is lost
 * and nothing runs elsewhere.
 */
import type { Pool, PoolClient } from 'pg';

import { getJobType } from './registry';
import { closeRun, lockPending, markHandedOff, NOTIFY_CHANNEL } from './store';
import type { WorkflowStarter } from './types';

export interface RelayDeps {
  pool: Pick<Pool, 'connect'>;
  starter: WorkflowStarter;
  instanceId: string;
  defaultTaskQueue: string;
  /** Upper bound for one workflow start (a down Temporal can otherwise hang on connect). Default 15s. */
  startTimeoutMs?: number;
}

export interface RelayPassResult {
  started: number;
  /** Set when the pass stopped on a starter failure (Temporal unreachable); rows stay queued. */
  error: string | null;
}

function withTimeout<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms (scheduler unreachable?)`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Drain pending rows until none are left or the executor refuses one. */
export async function relayOnce(deps: RelayDeps): Promise<RelayPassResult> {
  let started = 0;
  for (;;) {
    const client = await deps.pool.connect();
    try {
      await client.query('begin');
      const [run] = await lockPending(client, deps.instanceId, 1);
      if (!run) {
        await client.query('rollback');
        return { started, error: null };
      }
      const def = getJobType(run.job_type);
      if (!def) {
        await closeRun(client, run.id, {
          status: 'failed',
          errorMessage: `unknown job type ${run.job_type}`,
          userMessage: 'This background job is not available',
        });
        await client.query('commit');
        continue;
      }
      try {
        const handle = await withTimeout(deps.startTimeoutMs ?? 15_000, 'workflow start', deps.starter.start({
          workflow: def.workflow,
          taskQueue: def.taskQueue ?? deps.defaultTaskQueue,
          workflowId: run.id,
          args: {
            runId: run.id,
            jobType: run.job_type,
            subjectKey: run.subject_key,
            tenantId: run.tenant_id,
            input: run.input,
          },
        }));
        await markHandedOff(client, run.id, handle.workflowId, handle.runId);
        await client.query('commit');
        started++;
      } catch (e) {
        await client.query('rollback');
        return { started, error: e instanceof Error ? e.message : String(e) };
      }
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      return { started, error: e instanceof Error ? e.message : String(e) };
    } finally {
      client.release();
    }
  }
}

export interface RelayOptions extends RelayDeps {
  /** Poll fallback when no NOTIFY arrives. */
  pollMs?: number;
  maxBackoffMs?: number;
  log?: (msg: string) => void;
}

/** Run the relay until stop() is called. Never throws; survives Postgres/Temporal outages. */
export function startRelay(opts: RelayOptions): { stop(): Promise<void> } {
  const pollMs = opts.pollMs ?? 5_000;
  const maxBackoff = opts.maxBackoffMs ?? 60_000;
  const log = opts.log ?? ((m) => console.log(m));
  let stopped = false;
  let wake: (() => void) | null = null;
  let dirty = false;
  let listener: PoolClient | null = null;

  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      if (dirty) {
        dirty = false;
        resolve();
        return;
      }
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        wake = null;
        resolve();
      }
      wake = done;
    });

  async function ensureListener(): Promise<void> {
    if (listener) return;
    const c = await opts.pool.connect();
    c.on('notification', () => {
      dirty = true;
      wake?.();
    });
    c.on('error', () => {
      listener = null;
      c.release(true);
    });
    await c.query(`listen ${NOTIFY_CHANNEL}`);
    listener = c;
  }

  const done = (async () => {
    let backoff = 1_000;
    while (!stopped) {
      let failed = false;
      try {
        await ensureListener();
      } catch (e) {
        log(`jobs relay: listen failed (polling only): ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        const res = await relayOnce(opts);
        if (res.started > 0) log(`jobs relay: started ${res.started} run(s)`);
        if (res.error) {
          failed = true;
          log(`jobs relay: executor unavailable, runs stay queued (retry in ${backoff}ms): ${res.error}`);
        }
      } catch (e) {
        failed = true;
        log(`jobs relay: pass failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (failed) {
        await nap(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
      } else {
        backoff = 1_000;
        await nap(pollMs);
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      wake?.();
      await done;
      if (listener) {
        listener.removeAllListeners('notification');
        listener.release(true);
        listener = null;
      }
    },
  };
}
