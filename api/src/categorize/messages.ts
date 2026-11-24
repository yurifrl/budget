/**
 * User-safe sentences the categorize job stores on its run (job_runs.user_message)
 * and the problems that end a run early. Pure constants, no imports: the
 * Temporal workflow bundle imports this file.
 *
 * Never provider text, never a key: these are fixed sentences chosen by code.
 */

/**
 * Why a run stops before/while classifying, with no provider call left to
 * make: no usable AI key, or a key that cannot be read. The run is recorded as
 * succeeded with this sentence, not as a failure storm of retries.
 */
export type CategorizeSkipProblem =
  /** No own key and the shared key is not available to this user. */
  | 'own_key_required'
  /** Feature on, but the server has no valid shared key configured. */
  | 'shared_key_missing'
  /** Feature on and a shared key configured, but no model chosen for it. */
  | 'shared_model_missing'
  /** No master key here: own keys cannot be sealed or opened. */
  | 'encryption_missing'
  /** The stored secret does not open (master key changed, wrong row). */
  | 'unreadable'
  /** A key is resolved but it names no model (own key saved without one). */
  | 'no_model';

/** ApplicationFailure.type values thrown by the activities → user message. */
export const CATEGORIZE_FAILURE_MESSAGES: Record<string, string> = {
  AiAuth: 'The AI provider refused your key. Check your AI key and try again.',
  AiPermanent: 'The AI provider refused the request. Try again later.',
  AiRateLimited: 'The AI provider is limiting requests right now. We will try again shortly.',
  AiTransient: "Couldn't reach the AI provider. We will try again later.",
  BudgetMissing: 'This budget is no longer available.',
};

export const CATEGORIZE_SKIP_MESSAGES: Record<CategorizeSkipProblem, string> = {
  own_key_required:
    "Add your own AI key to get category suggestions: the app's shared AI key is not available for your account.",
  shared_key_missing: 'The shared AI key is not configured on this server.',
  shared_model_missing: 'The shared AI key is configured, but no model is chosen for it.',
  encryption_missing: 'AI keys cannot be read on this server right now. Try again later.',
  unreadable: 'Your saved AI key cannot be read on this server. Save it again.',
  no_model: 'Choose a model for your AI key before running category suggestions.',
};
