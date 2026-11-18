/**
 * `ctx.log(level, msg, fields)` for job code: lines go to jobs.job_logs
 * (capped per attempt) and are mirrored to stdout either way.
 */
import { appendLog, countAttemptLogs, MAX_LOG_LINES_PER_ATTEMPT } from './store';
import type { LogLevel, Queryable } from './types';

export interface JobContext {
  runId: string;
  attemptNo: number;
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): Promise<void>;
}

export function createJobContext(
  db: Queryable,
  ids: { runId: string; attemptNo: number },
  stdout: (line: string) => void = (line) => console.log(line),
): JobContext {
  let used: number | null = null;
  return {
    ...ids,
    async log(level, message, fields) {
      stdout(`[job ${ids.runId} #${ids.attemptNo}] ${level}: ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`);
      try {
        // Seed from the DB once so an activity re-run after a crash keeps the cap.
        used ??= await countAttemptLogs(db, ids.runId, ids.attemptNo);
        if (used >= MAX_LOG_LINES_PER_ATTEMPT) return;
        if (await appendLog(db, { ...ids, level, message, fields })) used++;
      } catch (e) {
        // Logging must never fail the job.
        stdout(`[job ${ids.runId}] log write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
