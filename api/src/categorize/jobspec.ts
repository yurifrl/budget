/**
 * Pure constants of the `categorize_run` job. No imports: the Temporal
 * workflow bundle (workflows.ts) and the activities both use this file.
 *
 * Coalescing: the jobs ledger's partial unique index is on (job_type,
 * subject_key) for queued/running runs, so every trigger for one budget joins
 * the same run (subject key = budget id).
 */
export const CATEGORIZE_RUN_JOB = 'categorize_run';
/** Suffix appended to the task queue for provider-calling activities (rate limited). */
export const AI_QUEUE_SUFFIX = '-ai';
/** ~60 provider-bound activity starts per minute across all worker pods. */
export const AI_ACTIVITIES_PER_SECOND = 1;
/** Transactions classified per activity call (each may take several model turns). */
export const CATEGORIZE_CHUNK_SIZE = 10;
/** Provider-requested pause cap, so a bad header cannot park a run for hours. */
export const MAX_RATE_LIMIT_DELAY_MS = 15 * 60_000;
export const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
