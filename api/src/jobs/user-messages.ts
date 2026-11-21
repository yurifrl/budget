/**
 * The user-safe sentences the jobs ledger writes into `job_runs.user_message`
 * itself (feature workflows add their own, e.g. connections/errors.ts). Pure
 * constants (no imports): the Temporal workflow bundle imports this file.
 *
 * They are stored English text, so changing one orphans old rows: the API maps
 * a stored sentence back to a code by exact match (connections/server-messages.ts),
 * and an unknown sentence simply has no code.
 */
export const JOB_USER_MESSAGES = {
  cancelledBeforeStart: 'Cancelled before it started',
  cancelled: 'Cancelled',
  failed: 'The background job failed',
  unavailable: 'This background job is not available',
} as const;
