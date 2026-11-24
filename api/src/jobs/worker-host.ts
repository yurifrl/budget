/**
 * Hosts the Temporal worker (SDK import #3). Boot never depends on Temporal:
 * connect/create failures are logged and retried with backoff until stopped.
 */
import { NativeConnection, Worker } from '@temporalio/worker';

import { workflowSource } from './workflows/source';

export interface WorkerHostOptions {
  address: string;
  namespace: string;
  taskQueue: string;
  activities: object;
  /**
   * Extra activity-only workers on other task queues (e.g. a rate-limited
   * queue for provider calls). `maxTaskQueueActivitiesPerSecond` is enforced by
   * the server per queue, so it holds across all pods;
   * `maxConcurrentActivityTaskExecutions` bounds how many of that queue's
   * activities ONE worker runs at once (the `-ai` queue uses 1 so a provider
   * key never sees two calls from this process in parallel).
   */
  activityQueues?: Array<{
    taskQueue: string;
    maxTaskQueueActivitiesPerSecond?: number;
    maxConcurrentActivityTaskExecutions?: number;
  }>;
  /** Called after each successful (re)connect, e.g. to ensure schedules. Failures are logged, not fatal. */
  onConnected?: () => Promise<void>;
  log?: (msg: string) => void;
}

export function startWorkerHost(opts: WorkerHostOptions): { stop(): Promise<void> } {
  const log = opts.log ?? ((m) => console.log(m));
  let stopped = false;
  let current: Worker[] = [];
  let wake: (() => void) | null = null;

  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  const source = workflowSource();
  log(`jobs worker: workflows from ${'workflowBundle' in source ? `pre-built bundle ${source.workflowBundle.codePath}` : 'source (bundling at start)'}`);

  const loop = (async () => {
    let backoff = 1_000;
    while (!stopped) {
      let connection: NativeConnection | null = null;
      try {
        const conn = await NativeConnection.connect({ address: opts.address });
        connection = conn;
        const worker = await Worker.create({
          connection,
          namespace: opts.namespace,
          taskQueue: opts.taskQueue,
          ...source,
          activities: opts.activities,
        });
        const extra = await Promise.all(
          (opts.activityQueues ?? []).map((q) =>
            Worker.create({
              connection: conn,
              namespace: opts.namespace,
              taskQueue: q.taskQueue,
              activities: opts.activities,
              ...(q.maxTaskQueueActivitiesPerSecond !== undefined
                ? { maxTaskQueueActivitiesPerSecond: q.maxTaskQueueActivitiesPerSecond }
                : {}),
              ...(q.maxConcurrentActivityTaskExecutions !== undefined
                ? { maxConcurrentActivityTaskExecutions: q.maxConcurrentActivityTaskExecutions }
                : {}),
            }),
          ),
        );
        current = [worker, ...extra];
        backoff = 1_000;
        log(`jobs worker: polling ${opts.namespace}/${opts.taskQueue} at ${opts.address}`);
        if (opts.onConnected) {
          opts.onConnected().catch((e) => log(`jobs worker: onConnected failed: ${e instanceof Error ? e.message : String(e)}`));
        }
        await Promise.all(current.map((w) => w.run()));
      } catch (e) {
        if (!stopped) log(`jobs worker: temporal unavailable (retry in ${backoff}ms): ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        current = [];
        await connection?.close().catch(() => undefined);
      }
      if (stopped) break;
      await nap(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  })();

  return {
    async stop() {
      stopped = true;
      wake?.();
      for (const w of current) w.shutdown();
      await loop;
    },
  };
}
