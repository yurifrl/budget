/**
 * Job status enum. Extracted from syscd-app `server/jobs/types.ts`, whose
 * remaining content depends on pg.
 */
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
