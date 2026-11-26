/**
 * The categorize run: ask Jev about the rows this run may send, and write the
 * answers as suggestions. It never writes a transaction's category — accepting
 * a suggestion stays the person's own action — and never writes a key, a
 * feature value or a setting.
 *
 * One call per transaction, a few in flight at a time, with the payee's past
 * categories always sent (without them Jev is confidently wrong). Failures are
 * told apart (R4): an answer that is unusable for this row counts toward its
 * cap and the run goes on; Jev being temporarily unavailable is recorded but
 * costs the row no attempt, and five such answers in a row stop the run; a
 * refused key or an out-of-credit account stops it at once without writing an
 * attempt for the row it was asking about.
 */
import type { Pool } from 'pg';

import type { CategorizeRunFailure } from '@shared/contracts/categorize';
import type { JevKeyProblem } from '@shared/contracts/jev';

import {
  classifyTransaction,
  isRowFailure,
  isTransientFailure,
  JEV_MAX_OPTIONS,
  JEV_MODEL,
  JevFailure,
  jevUnavailableError,
  resolveJevKey,
  type JevFacts,
} from '../jev';

import { merchantPanel, pendingTransferIds, recordAttempt, replaceSuggestions } from './store';
import {
  assignableCategories,
  budgetOwnerId,
  bumpProgress,
  candidateCount,
  failProgress,
  payeeHistory,
  readProgress,
  runCandidates,
  RUN_LIMIT,
  runTouched,
  startProgress,
  type RunCandidate,
  type RunProgress,
} from './run-store';

/** Attempts one transaction may spend on unusable answers before a later run stops asking. */
export const MAX_ATTEMPTS_PER_TRANSACTION = 3;
/** How many past categories of the payee one call carries. */
export const PAYEE_HISTORY_LIMIT = 12;
/** Calls in flight at once: enough to be quick, few enough to stay polite. */
export const RUN_CONCURRENCY = 4;
/** Consecutive "Jev is unavailable" answers that stop the run. */
export const TRANSIENT_STREAK_LIMIT = 5;

/** Why a run stopped before it could finish (the contract's own enum). */
export type RunFailureReason = CategorizeRunFailure;

/** A run that cannot continue. Never retryable: the next start begins a new run. */
export class RunFailure extends Error {
  constructor(
    readonly reason: RunFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'RunFailure';
  }
}

export type RunDeps = {
  /** Test seam: the real Jev call by default. */
  classify?: typeof classifyTransaction;
  log?: (level: 'info' | 'warn', message: string, fields?: Record<string, unknown>) => Promise<void>;
  /** Called before every call, so the activity stays alive. */
  heartbeat?: () => void;
};

/**
 * The failure a key problem is reported as. The page distinguishes "not
 * configured" (fix it on the key screen) from "Jev refused the key" and
 * "Jev is unavailable" (wait or top up).
 */
const KEY_PROBLEM_REASON: Record<JevKeyProblem, RunFailureReason> = {
  no_owner: 'not_configured',
  flag_off: 'not_configured',
  server_key_missing: 'not_configured',
  key_unreadable: 'not_configured',
};

/** The stops Jev itself causes (the reasons that carry a fixed sentence). */
type JevStop = 'key_rejected' | 'no_credits' | 'jev_unavailable';

/** The reason for a Jev failure that stops the run instead of costing a row an attempt. */
function stopReason(kind: JevFailure['kind']): JevStop {
  if (kind === 'rejected_key') return 'key_rejected';
  if (kind === 'no_credits') return 'no_credits';
  return 'jev_unavailable';
}

/**
 * What a stop says when Jev itself refused. Fixed sentences, never the remote
 * body: that text is the account's own error message and has no business in a
 * run's record (`JevFailure` keeps it for the key screen's own answer).
 */
const STOP_MESSAGE: Record<JevStop, string> = {
  key_rejected: 'Jev refused this budget\u2019s key.',
  no_credits: 'The Jev account behind this key is out of credit.',
  jev_unavailable: 'Jev could not be reached.',
};

/** What one call carries about the row: its own facts plus the payee's history. */
function factsOf(candidate: RunCandidate, history: string[]): JevFacts {
  const panel = merchantPanel(candidate.raw_payload, candidate.amount);
  return {
    payee: candidate.payee,
    // The bank's own text as the connection stored it; the payload's
    // description only when the row was never re-imported with one.
    bankText: candidate.bank_text ?? panel.raw_bank_description,
    memo: candidate.memo,
    amount: candidate.amount,
    date: candidate.date,
    account: candidate.account_name,
    payeeHistory: history,
  };
}

/**
 * One run of one budget, owner key resolved first: a run with no key does
 * nothing at all rather than writing attempts for rows it never asked about.
 */
export async function runCategorize(
  pool: Pool,
  args: { runId: string; budgetId: string },
  deps: RunDeps = {},
): Promise<RunProgress> {
  const { runId, budgetId } = args;
  const classify = deps.classify ?? classifyTransaction;

  const owner = await budgetOwnerId(pool, budgetId);
  const access = owner ? await resolveJevKey(pool, owner) : ({ ok: false, problem: 'no_owner' } as const);
  if (!access.ok) {
    const reason = KEY_PROBLEM_REASON[access.problem];
    await failProgress(pool, runId, budgetId, reason);
    throw new RunFailure(reason, jevUnavailableError(access.problem).message);
  }

  const categories = await assignableCategories(pool, budgetId, JEV_MAX_OPTIONS + 1);
  if (categories.length === 0) {
    await failProgress(pool, runId, budgetId, 'no_categories');
    throw new RunFailure('no_categories', 'this budget has no category to suggest');
  }
  if (categories.length > JEV_MAX_OPTIONS) {
    // Never a silently truncated list: Jev would answer out of the part that
    // was sent, and the right category might not be in it.
    await failProgress(pool, runId, budgetId, 'too_many_categories');
    throw new RunFailure(
      'too_many_categories',
      `this budget has more than ${JEV_MAX_OPTIONS} categories to suggest from, which is more than Jev accepts`,
    );
  }

  // A run's size is fixed at its FIRST delivery: a redelivery of the same run
  // (Temporal retry) only finishes the rows it still owes, so `done` never
  // passes `total` and no new row joins a run already in flight.
  const pendingTransfers = await pendingTransferIds(pool, budgetId);
  const progress = await readProgress(pool, runId);
  const total =
    progress?.total ??
    Math.min(await candidateCount(pool, budgetId, pendingTransfers, MAX_ATTEMPTS_PER_TRANSACTION), RUN_LIMIT);
  // A row this run already touched — answered, unusable, or in flight when the
  // worker died — is skipped by the candidate rule, so the size of what is
  // still owed follows those rows and not `done` (a transient answer stamps
  // the row and adds nothing to `done`; counting `done` would ask about more
  // distinct rows than `total` names).
  const remaining = Math.max(0, total - (progress ? await runTouched(pool, runId) : 0));
  const candidates =
    remaining > 0
      ? await runCandidates(pool, budgetId, pendingTransfers, MAX_ATTEMPTS_PER_TRANSACTION, runId, remaining)
      : [];
  await startProgress(pool, runId, budgetId, total);
  await deps.log?.('info', 'categorize run started', { total, remaining });

  /**
   * Shared by the workers: the first stop reason, the consecutive
   * "Jev unavailable" count, and the row counter. A plain object because the
   * workers assign it from inside their own closures.
   */
  const state: { stop: RunFailure | null; crash: unknown | null; transient: number; next: number } = {
    stop: null,
    crash: null,
    transient: 0,
    next: 0,
  };

  const askOne = async (candidate: RunCandidate): Promise<{ done: number; failures: number }> => {
    const history = candidate.payee_id
      ? await payeeHistory(pool, budgetId, candidate.payee_id, PAYEE_HISTORY_LIMIT)
      : [];
    deps.heartbeat?.();
    const answer = await classify({ key: access.key, facts: factsOf(candidate, history), options: categories });
    const written = await replaceSuggestions(
      pool,
      budgetId,
      candidate.transaction_id,
      answer.suggestions.map((suggestion) => ({
        categoryId: suggestion.categoryId,
        confidence: suggestion.confidence,
        reason: null,
        source: 'jev' as const,
        provider: 'jev',
        model: answer.model,
      })),
    );
    // An answer that names no category the budget may still use is "no
    // suggestion", never a stale set left behind from an earlier answer.
    await recordAttempt(pool, budgetId, candidate.transaction_id, runId, {
      outcome: written === 0 ? 'no_suggestion' : 'suggested',
      errorKind: null,
      model: answer.model,
      attempts: 'reset',
    });
    return { done: 1, failures: 0 };
  };

  const worker = async (): Promise<void> => {
    try {
      await work();
    } catch (err) {
      // Any rejection (a failed write included) stops the others from starting
      // new calls; the ones in flight still settle.
      state.crash ??= err;
      throw err;
    }
  };

  const work = async (): Promise<void> => {
    for (;;) {
      if (state.stop || state.crash) return;
      const candidate = candidates[state.next++];
      if (!candidate) return;
      deps.heartbeat?.();
      let step: { done: number; failures: number } | null = null;
      try {
        step = await askOne(candidate);
        state.transient = 0;
      } catch (err) {
        // Anything that is not a Jev answer is a crash: the row is left
        // unanswered (not counted done) and Temporal retries the activity.
        if (!(err instanceof JevFailure)) throw err;
        if (isRowFailure(err.kind)) {
          await recordAttempt(pool, budgetId, candidate.transaction_id, runId, {
            outcome: 'failed',
            errorKind: err.kind,
            model: JEV_MODEL,
            attempts: 'count',
          });
          step = { done: 1, failures: 1 };
          state.transient = 0;
          await deps.log?.('warn', 'Jev answered unusably for one transaction; a later run retries it', {
            transaction_id: candidate.transaction_id,
            kind: err.kind,
          });
        } else if (isTransientFailure(err.kind)) {
          // Jev never judged the row, so the cap is untouched but the row is
          // stamped: this same run must not ask it twice. A later run does.
          await recordAttempt(pool, budgetId, candidate.transaction_id, runId, {
            outcome: 'failed',
            errorKind: err.kind,
            model: JEV_MODEL,
            attempts: 'keep',
          });
          // The row is counted as unanswered (the page says so) but its
          // attempt cap is untouched: Jev never judged it.
          step = { done: 0, failures: 1 };
          state.transient++;
          if (state.transient >= TRANSIENT_STREAK_LIMIT) {
            state.stop = new RunFailure('jev_unavailable', `Jev answered "${err.kind}" ${state.transient} times in a row`);
          }
        } else {
          // A refused key or no credits: nothing was written for this row, and
          // every further row would fail the same way.
          state.stop = new RunFailure(stopReason(err.kind), STOP_MESSAGE[stopReason(err.kind)]);
        }
      } finally {
        if (step) await bumpProgress(pool, runId, step);
      }
    }
  };

  const workers = Math.max(1, Math.min(RUN_CONCURRENCY, candidates.length));
  // Every call in flight settles before the activity ends: a Temporal retry
  // must never overlap a call the previous attempt left running.
  await Promise.allSettled(Array.from({ length: workers }, worker));

  // The named failure is recorded first, so a worker's rejection in the same
  // delivery cannot bury the code the person can act on.
  if (state.stop) await failProgress(pool, runId, budgetId, state.stop.reason);
  // A worker can reject without a Jev answer (a progress or attempt write that
  // throws). Swallowing it would close a run that never finished.
  if (state.crash) throw state.crash;
  if (state.stop) throw state.stop;

  const finished = (await readProgress(pool, runId)) ?? {
    done: total,
    total,
    failures: 0,
    failure: null,
  };
  await deps.log?.('info', 'categorize run finished', { total: finished.total, failures: finished.failures });
  return finished;
}
