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
/**
 * Transactions classified per activity call. Smaller than one model turn is
 * cheap to resume and keeps the activity deadline below 31 minutes.
 */
export const CATEGORIZE_CHUNK_SIZE = 5;
/**
 * Transactions one run may classify; the rest stays uncategorized for the next
 * run. Chosen so a shared key never pays for an unbounded import backlog in
 * one trigger: at most 100 x 6 calls x ~1k output tokens, while a typical
 * transaction is one call.
 */
export const CATEGORIZE_RUN_LIMIT = 100;
/**
 * Output cap per model turn (thinking tokens included). Sized for a three-item
 * JSON answer plus reasons; `ai/http.ts` derives a 60 s deadline from it.
 */
export const CLASSIFY_MAX_TOKENS = 1024;
/** Model calls one transaction may make: 4 tool turns + 1 answer + 1 timeout retry. */
export const CLASSIFY_MAX_CALLS = 6;
/** Tokens (input + output) one transaction may spend before it is counted failed. */
export const CLASSIFY_MAX_TOKENS_PER_TRANSACTION = 20_000;
/** The per-call deadline the AI layer derives from CLASSIFY_MAX_TOKENS (60 s floor). */
export const CLASSIFY_CALL_DEADLINE_MS = 60_000;
/** How long a chunk waits inside itself for one 429 before Temporal retries the chunk. */
export const IN_CHUNK_RATE_LIMIT_WAIT_MS = 60_000;
/**
 * Hard activity deadline: CATEGORIZE_CHUNK_SIZE x CLASSIFY_MAX_CALLS x the
 * per-call deadline, plus one in-chunk 429 wait = 31 minutes. The workflow
 * passes this to `startToCloseTimeout`; raise it only with the caps above.
 */
export const CATEGORIZE_CHUNK_TIMEOUT_MS =
  CATEGORIZE_CHUNK_SIZE * CLASSIFY_MAX_CALLS * CLASSIFY_CALL_DEADLINE_MS + IN_CHUNK_RATE_LIMIT_WAIT_MS;
/** Provider-requested pause cap, so a bad header cannot park a run for hours. */
export const MAX_RATE_LIMIT_DELAY_MS = 15 * 60_000;
export const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;

/** Explicit re-classify: job input `{ force: true }`; also re-asks transactions with suggestions. */
export function forceFromInput(input: unknown): boolean {
  return typeof input === 'object' && input !== null && 'force' in input && input.force === true;
}
