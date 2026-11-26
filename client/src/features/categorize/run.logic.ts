/**
 * Pure rules of the Categorize run card: what the card shows for a given run
 * status, how many rows the next run takes, and what a Jev key problem means
 * in words. Wire-typed, so it lives beside the screen (not in domain/).
 */

import type { CategorizeRunStatus } from '@/budget/data/api';
import { apiErrorMessage, apiErrorParam } from '@/platform/api/baseQuery';

import { CATEGORIZE_RUN_LIMIT } from '@shared/contracts/categorize';
import { jevKeyProblemSchema, type JevKeyProblem } from '@shared/contracts/jev';

import { t } from './i18n';

/** Rows one run asks about: the one constant the contract, the API and this page share. */
export const RUN_BATCH = CATEGORIZE_RUN_LIMIT;

export type RunPhase = 'never' | 'waiting' | 'running' | 'finished' | 'failed' | 'cancelled';

/** The run the card describes, or 'never' before this budget's first run. */
export function runPhase(status: CategorizeRunStatus | undefined): RunPhase {
  if (!status?.run) return 'never';
  switch (status.run.state) {
    case 'queued':
      return 'waiting';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'finished';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

/** Whether the card keeps polling: a run in flight changes without a client write. */
export function runPollMs(status: CategorizeRunStatus | undefined): number {
  const phase = runPhase(status);
  return phase === 'waiting' || phase === 'running' ? 2000 : 0;
}

/**
 * How many rows this run will send. The server counts them with the run's own
 * rule (not the queue's size: a queue row may already carry suggestions), so
 * the page never promises more than it sends.
 */
export function runSendCount(status: CategorizeRunStatus | undefined): number {
  return status?.candidates ?? 0;
}

/** The sentence for the card's headline. A finished run names its own result. */
export function runHeadline(status: CategorizeRunStatus | undefined): string {
  const run = status?.run;
  switch (runPhase(status)) {
    case 'never':
      return t('run.never');
    case 'waiting':
      return t('run.waiting');
    case 'running':
      return t('run.running');
    case 'finished':
      return run && run.total > 0
        ? t('run.finishedCount', { done: run.done, total: run.total, failures: run.failures })
        : t('run.finished');
    case 'failed':
      return t('run.failed');
    case 'cancelled':
      return t('run.cancelled');
  }
}

/** "12 of 34" while there is progress to show, else null. */
export function runProgressLabel(status: CategorizeRunStatus | undefined): string | null {
  const run = status?.run;
  if (!run || run.total === 0) return null;
  return t('run.progress', { done: run.done, total: run.total, count: run.total });
}

/** The failures summary, or null when nothing failed. */
export function runFailuresLabel(status: CategorizeRunStatus | undefined): string | null {
  const failures = status?.run?.failures ?? 0;
  return failures > 0 ? t('run.failures', { count: failures }) : null;
}

/**
 * Why no key can be used, in the page's words ("Jev API key" named explicitly,
 * as the brief requires). A run uses the budget OWNER's key, so a member of
 * someone else's budget cannot fix the two problems a key would fix: telling
 * them to save their own would be a lie.
 */
export function runKeyProblemLabel(problem: JevKeyProblem, options: { isOwner: boolean }): string {
  switch (problem) {
    case 'no_owner':
      return t('run.noKeyOwner');
    case 'flag_off':
      return options.isOwner ? t('run.noKeyShared') : t('run.noKeyMember');
    case 'server_key_missing':
      return options.isOwner ? t('run.noKeyServer') : t('run.noKeyMember');
    case 'key_unreadable':
      return options.isOwner ? t('run.noKeyUnreadable') : t('run.noKeyMember');
  }
}

/** Whether the card offers the key screen for a not-configured reason. */
export function runOffersKeyLink(problem: JevKeyProblem, options: { isOwner: boolean }): boolean {
  return problem !== 'no_owner' && options.isOwner;
}

/**
 * Why a run stopped before asking every row, or null when it did not: one
 * sentence per code the server records, so the card never shows a bare code.
 * A run uses the budget OWNER's key, so the three key-related codes have a
 * member variant: telling a member to save or re-save a key would be a lie.
 */
export function runFailureLabel(
  status: CategorizeRunStatus | undefined,
  options: { isOwner: boolean },
): string | null {
  switch (status?.run?.failure ?? null) {
    case null:
      return null;
    case 'key_rejected':
      return options.isOwner ? t('run.failure.keyRejected') : t('run.failure.keyRejectedMember');
    case 'no_credits':
      return options.isOwner ? t('run.failure.noCredits') : t('run.failure.noCreditsMember');
    case 'jev_unavailable':
      return t('run.failure.jevUnavailable');
    case 'too_many_categories':
      return t('run.failure.tooManyCategories');
    case 'no_categories':
      return t('run.failure.noCategories');
    case 'not_configured':
      return options.isOwner ? t('run.failure.notConfigured') : t('run.failure.notConfiguredMember');
    case 'internal':
      return t('run.failure.internal');
  }
}

/** Whether a stopped run stopped over its key, so the card can link to the screen. */
export function runFailureNeedsKey(status: CategorizeRunStatus | undefined): boolean {
  switch (status?.run?.failure ?? null) {
    case 'key_rejected':
    case 'no_credits':
    case 'not_configured':
      return true;
    default:
      return false;
  }
}

/**
 * Why starting the run failed, in words. A run cannot start for a key reason
 * that the caller may be unable to fix (the owner's key), so the card reuses
 * the same owner-aware sentences instead of the generic "Jev is unavailable".
 */
export function runStartErrorMessage(error: unknown, options: { isOwner: boolean }): string {
  const problem = jevKeyProblemSchema.safeParse(apiErrorParam(error, 'reason'));
  if (problem.success) return runKeyProblemLabel(problem.data, options);
  return apiErrorMessage(error, t('run.startFailed'));
}

/**
 * The hint under the confirmation, or null when one run can take everything
 * waiting. A run that comes back with exactly the limit may have more behind
 * it, which is all this sentence claims ("up to").
 */
export function runRestLabel(status: CategorizeRunStatus | undefined): string | null {
  return (status?.candidates ?? 0) >= RUN_BATCH ? t('run.rest', { batch: RUN_BATCH }) : null;
}
