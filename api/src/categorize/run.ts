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
  NOT_TRANSFER_OPTION,
  jevUnavailableError,
  resolveJevKey,
  TRANSFER_OPTION,
  type JevFacts,
  type JevOption,
} from '../jev';

import { matcherRowIds, merchantPanel, recordAttempt, replaceSuggestions, type NewSuggestion, type SuggestionTarget } from './store';
import {
  assignableCategories,
  budgetOwnerId,
  bumpProgress,
  candidateWaiting,
  failProgress,
  offeredOptions,
  payeeHistory,
  readProgress,
  runCandidates,
  runTouched,
  startProgress,
  transferCounterparts,
  type AccountOption,
  type CategoryOption,
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
/**
 * Rows loaded per query. A run of any size holds one page at a time, bank
 * payloads included; the candidate rule skips the rows already stamped by this
 * run, so each load moves forward.
 */
export const RUN_PAGE = 100;

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

/**
 * The options one row is asked. An outflow gets the categories; a row of either
 * sign gets one transfer option per open account of the budget (never the row's
 * own), labelled `Transfer / <account>`. An inflow has no category question —
 * the shared rule says an inflow needs no category — so its only use is naming
 * the transfer, and it also gets "Not a transfer" so Jev can say the row is
 * ordinary money in rather than a movement it does not believe in.
 *
 * A row the person already answered "not a transfer" (or "outside the budget")
 * gets no transfer option at all: the question is not asked again. A mark
 * from a link they undid (`manual`) only stops auto-linking, so the row is asked.
 * An inflow is offered only the accounts holding its free counterpart
 * (`counterpartAccounts`): accept takes no other, since it never invents a leg
 * for money that arrived.
 */
function optionsFor(
  candidate: RunCandidate,
  categories: readonly JevOption[],
  accounts: readonly AccountOption[],
  counterpartAccounts: ReadonlySet<string>,
): JevOption[] {
  const transfers = candidate.transfer_refused
    ? []
    : accounts
        .filter((account) => account.id !== candidate.account_id)
        .filter((account) => candidate.amount <= 0 || counterpartAccounts.has(account.id))
        .map((account) => ({ id: `${TRANSFER_OPTION}${account.id}`, label: `Transfer / ${account.name}` }));
  if (candidate.amount <= 0) return [...categories, ...transfers];
  return transfers.length > 0 ? [...transfers, { id: NOT_TRANSFER_OPTION, label: 'Not a transfer' }] : [];
}

/** What one call carries about the row: its own facts, its counterpart and the payee's history. */
function factsOf(
  candidate: RunCandidate,
  history: string[],
  counterpart: { found: boolean; account: string | null },
): JevFacts {
  const panel = merchantPanel(candidate.raw_payload, candidate.amount);
  return {
    payee: candidate.payee,
    // The bank's own text as the connection stored it; the payload's
    // description only when the connection kept no row at all.
    bankText: candidate.bank_text ?? panel.raw_bank_description,
    memo: candidate.memo,
    amount: candidate.amount,
    date: candidate.date,
    account: { name: candidate.account_name, kind: candidate.account_kind },
    counterpart,
    payeeHistory: history,
  };
}

/**
 * One run of one budget, owner key resolved first: a run with no key does
 * nothing at all rather than writing attempts for rows it never asked about.
 */
export async function runCategorize(
  pool: Pool,
  args: { runId: string; budgetId: string; take?: number },
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

  const { categories, accounts, ceiling } = await offeredOptions(pool, budgetId);
  if (categories.length === 0) {
    await failProgress(pool, runId, budgetId, 'no_categories');
    throw new RunFailure('no_categories', 'this budget has no category to suggest');
  }
  // The limit is Jev's, and it counts every option sent: categories plus the
  // transfer options (all open accounts but the row's own, so one less).
  if (ceiling > JEV_MAX_OPTIONS) {
    // Never a silently truncated list: Jev would answer out of the part that
    // was sent, and the right answer might not be in it.
    await failProgress(pool, runId, budgetId, 'too_many_categories');
    throw new RunFailure(
      'too_many_categories',
      `this budget offers ${ceiling} options (categories and accounts), more than the ${JEV_MAX_OPTIONS} Jev accepts`,
    );
  }

  // A run's SIZE is fixed at its first delivery: the count the person chose,
  // trimmed by what was waiting then. A redelivery (Temporal retry) only finishes
  // the rows it still owes, so `done` never passes `total`; a row that became a
  // candidate since can be one of those still owed (the count left room), which
  // is why only the count is fixed, not the list. A run whose job carries no size
  // (queued before the field existed) takes everything waiting.
  //
  // The rows the transfer matcher holds are not asked about: they are shown — and
  // decided — in the transfer lists, both sides together, so asking Jev again
  // would put the same movement in front of the person twice.
  const matcherRows = await matcherRowIds(pool, budgetId);
  const progress = await readProgress(pool, runId);
  const total =
    progress?.total ??
    Math.min(
      args.take ?? Number.MAX_SAFE_INTEGER,
      await candidateWaiting(pool, budgetId, matcherRows, MAX_ATTEMPTS_PER_TRANSACTION),
    );
  // A page boundary falls on rows, not on `done`: a row this run already touched
  // — answered, unusable, or in flight when the worker died — is skipped by the
  // candidate rule, so what is still owed follows those rows (a transient answer
  // stamps the row and adds nothing to `done`).
  const owed = Math.max(0, total - (progress ? await runTouched(pool, runId) : 0));
  await startProgress(pool, runId, budgetId, total);
  await deps.log?.('info', 'categorize run started', { total, owed });

  /**
   * Shared by the workers: the first stop reason, the consecutive
   * "Jev unavailable" count. A plain object because the workers assign it from
   * inside their own closures.
   */
  const state: { stop: RunFailure | null; crash: unknown | null; transient: number } = {
    stop: null,
    crash: null,
    transient: 0,
  };

  /**
   * The rows still to ask about, one page at a time. Single-threaded: a shift
   * never races another worker, and `loading` makes every worker wait on the one
   * query in flight instead of piling up its own.
   *
   * `taken` is every id handed out so far. A row is only stamped once its call
   * settles, so the page fetched while calls are in flight has to be told what
   * was already handed out — otherwise it returns those rows again and one
   * transaction is asked about twice while another never is.
   */
  const buffer: {
    rows: RunCandidate[];
    taken: string[];
    asked: number;
    exhausted: boolean;
    loading: Promise<void> | null;
  } = {
    rows: [],
    taken: [],
    asked: 0,
    exhausted: owed === 0,
    loading: null,
  };

  const claim = async (): Promise<RunCandidate | null> => {
    for (;;) {
      if (state.stop || state.crash) return null;
      const next = buffer.rows.shift();
      if (next) {
        buffer.asked++;
        buffer.taken.push(next.transaction_id);
        return next;
      }
      if (buffer.exhausted || buffer.asked >= owed) return null;
      buffer.loading ??= (async () => {
        const size = Math.min(RUN_PAGE, owed - buffer.asked);
        const loaded = await runCandidates(
          pool,
          budgetId,
          matcherRows,
          MAX_ATTEMPTS_PER_TRANSACTION,
          runId,
          size,
          buffer.taken,
        );
        buffer.rows.push(...loaded);
        // Fewer rows than asked for is the end of what this run may send: rows
        // stopped needing a category, or the cap no longer lets them in.
        if (loaded.length < size) buffer.exhausted = true;
      })().finally(() => {
        buffer.loading = null;
      });
      await buffer.loading;
    }
  };

  const askOne = async (candidate: RunCandidate): Promise<{ done: number; failures: number }> => {
    const history = candidate.payee_id
      ? await payeeHistory(pool, budgetId, candidate.payee_id, PAYEE_HISTORY_LIMIT)
      : [];
    // One query per row, inflows only: an inflow's own question is whether the
    // money came from another account, which is answered by its other leg.
    const counterparts = candidate.amount > 0 ? await transferCounterparts(pool, budgetId, candidate.transaction_id) : [];
    const counterpart = counterparts[0] ?? null;
    const options = optionsFor(candidate, categories, accounts, new Set(counterparts.map((row) => row.account_id)));
    if (options.length === 0) {
      // Nothing left to offer — an inflow whose transfer question is no longer
      // open (no free counterpart account any more). A call with an
      // empty choice is not a question, so the row is recorded unasked.
      await recordAttempt(pool, budgetId, candidate.transaction_id, runId, {
        outcome: 'no_suggestion',
        errorKind: null,
        model: null,
        attempts: 'reset',
      });
      return { done: 1, failures: 0 };
    }
    deps.heartbeat?.();
    const answer = await classify({
      key: access.key,
      facts: factsOf(candidate, history, { found: counterpart !== null, account: counterpart?.account_name ?? null }),
      options,
    });
    const suggestions: NewSuggestion[] = answer.suggestions.map((suggestion) => {
      const target: SuggestionTarget = suggestion.transferAccountId
        ? { kind: 'transfer', accountId: suggestion.transferAccountId }
        : { kind: 'category', categoryId: suggestion.categoryId ?? '' };
      return {
        target,
        confidence: suggestion.confidence,
        reason: null,
        source: 'jev',
        provider: 'jev',
        model: answer.model,
      };
    });
    const written = await replaceSuggestions(pool, budgetId, candidate.transaction_id, suggestions);
    // An answer that names no target the budget may still use is "no
    // suggestion", never a stale set left behind from an earlier answer. A row
    // categorized or decided while Jev answered drops the answer: it is stamped
    // (this run asked it) with no model, so it costs nothing of the hour.
    await recordAttempt(pool, budgetId, candidate.transaction_id, runId, {
      outcome: written === null || written === 0 ? 'no_suggestion' : 'suggested',
      errorKind: null,
      model: written === null ? null : answer.model,
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
      const candidate = await claim();
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

  const workers = Math.max(1, Math.min(RUN_CONCURRENCY, owed));
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
