/**
 * Categorize feature barrel: the only import surface for other API features.
 *
 * What the queue/accept task (budget-edxg) uses:
 *  - `startCategorizeRun` — enqueue (or join) the budget's `categorize_run`;
 *  - `categorizeRunStatus` — its active and last-finished ledger rows;
 *  - `readCategorySuggestions` — pending suggestions at/above a threshold,
 *    joined with the transaction and category the page shows. It is scoped by
 *    budget id only: the HTTP layer must check the caller's budget access.
 * Importing this file registers the `categorize_run` job type (API + worker).
 */
export { startCategorizeRun, categorizeRunStatus, type StartCategorizeRunParams } from './job';
export {
  listSuggestions as readCategorySuggestions,
  type SuggestionListOptions,
  type SuggestionRow,
  type SuggestionSource,
  type SuggestionStatus,
} from './store';
export {
  AI_ACTIVITIES_PER_SECOND,
  AI_QUEUE_SUFFIX,
  CATEGORIZE_CHUNK_SIZE,
  CATEGORIZE_RUN_JOB,
  CATEGORIZE_RUN_LIMIT,
} from './jobspec';
