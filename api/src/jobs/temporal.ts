/**
 * Temporal client side (SDK import #1): lazy connection, cached health ping,
 * workflow starter for the relay, cancel for the API, and the retention
 * schedule. Everything else in server/jobs depends on the ports in types.ts.
 */
import {
  Connection,
  Client,
  ScheduleOverlapPolicy,
  WorkflowExecutionAlreadyStartedError,
  isGrpcServiceError,
} from '@temporalio/client';

import type { TemporalHealth, TemporalPort, WorkflowStarter } from './types';

export interface TemporalOptions {
  address: string;
  namespace: string;
  taskQueue: string;
  /** Health ping cache. Default 15s. */
  healthTtlMs?: number;
}

export const RETENTION_SCHEDULE_ID = 'jobs-retention';
/** Daily at 03:17 UTC. Cadence changes apply on the next worker boot (update-in-place). */
export const RETENTION_CRON = '17 3 * * *';

export interface TemporalClient extends TemporalPort {
  starter: WorkflowStarter;
  connection: Connection;
  client: Client;
  ensureRetentionSchedule(): Promise<void>;
  /** Create-or-update a cron Schedule explicitly (never adopt an existing one as-is). */
  ensureSchedule(def: { scheduleId: string; workflowType: string; cron: string }): Promise<void>;
}

export function createTemporalClient(opts: TemporalOptions): TemporalClient {
  // Lazy: no I/O until the first RPC, so boot never depends on Temporal being up.
  const connection = Connection.lazy({ address: opts.address });
  const client = new Client({ connection, namespace: opts.namespace });
  const ttl = opts.healthTtlMs ?? 15_000;
  let cached: { at: number; value: TemporalHealth } | null = null;
  let inflight: Promise<TemporalHealth> | null = null;

  async function probe(): Promise<TemporalHealth> {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('temporal health ping timed out after 3s')), 3_000);
      });
      try {
        await Promise.race([connection.workflowService.getSystemInfo({}), timeout]);
      } finally {
        clearTimeout(timer);
      }
      return { up: true, checked_at: new Date().toISOString() };
    } catch (e) {
      return { up: false, reason: e instanceof Error ? e.message : String(e), checked_at: new Date().toISOString() };
    }
  }

  return {
    connection,
    client,
    async health() {
      if (cached && Date.now() - cached.at < ttl) return cached.value;
      inflight ??= probe().finally(() => {
        inflight = null;
      });
      const value = await inflight;
      cached = { at: Date.now(), value };
      return value;
    },
    async cancel(workflowId) {
      await client.workflow.getHandle(workflowId).cancel();
    },
    starter: {
      async start(req) {
        try {
          const handle = await client.workflow.start(req.workflow, {
            args: [req.args],
            taskQueue: req.taskQueue,
            workflowId: req.workflowId,
          });
          return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
        } catch (e) {
          // Idempotent: the relay committed the hand-off after a previous start.
          if (e instanceof WorkflowExecutionAlreadyStartedError) {
            const desc = await client.workflow.getHandle(req.workflowId).describe();
            return { workflowId: req.workflowId, runId: desc.runId };
          }
          throw e;
        }
      },
    },
    async ensureRetentionSchedule() {
      await this.ensureSchedule({ scheduleId: RETENTION_SCHEDULE_ID, workflowType: 'jobsRetention', cron: RETENTION_CRON });
    },
    async ensureSchedule({ scheduleId, workflowType, cron }) {
      const spec = { cronExpressions: [cron] };
      const action = {
        type: 'startWorkflow' as const,
        workflowType,
        taskQueue: opts.taskQueue,
        args: [] as [],
      };
      const policies = { overlap: ScheduleOverlapPolicy.SKIP };
      try {
        await client.schedule.create({ scheduleId, spec, action, policies });
      } catch (e) {
        if (!(isGrpcServiceError(e) && e.code === 6) && (e as Error).name !== 'ScheduleAlreadyRunning') throw e;
        // Exists: update explicitly so cadence/queue changes apply (never adopt as-is).
        await client.schedule.getHandle(scheduleId).update((prev) => ({ ...prev, spec, action, policies }));
      }
    },
  };
}
