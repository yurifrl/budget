/**
 * Categorize feature barrel: the only import surface for other API features.
 *
 * What the queue/accept task (budget-edxg) uses:
 *  - `readCategorySuggestions` — pending suggestions at/above a threshold,
 *    joined with the transaction and category the page shows, plus the row's
 *    latest attempt. Scoped by budget id only: the HTTP layer must check the
 *    caller's budget access.
 *  - `readCategorizeAttempts` — per-transaction attempts, so the page can tell
 *    "not classified yet" (no attempt row) from "classified, no suggestion"
 *    (outcome `no_suggestion`) and "failed" (with its error kind).
 *
 * Re-run rule for the page: once a person accepted or dismissed ANY suggestion
 * of a transaction, that transaction is never classified again.
 */

// Registers the `categorize_run` job type (the API also enqueues it).
import './job';
export {
  listSuggestions as readCategorySuggestions,
  listAttempts as readCategorizeAttempts,
  type AttemptListOptions,
  type AttemptOutcome,
  type AttemptRow,
  type BankFacts,
  type CategorizeAttempt,
  type SuggestionListOptions,
  type SuggestionRow,
  type SuggestionSource,
  type SuggestionStatus,
} from './store';
