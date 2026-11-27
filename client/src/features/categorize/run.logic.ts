/**
 * Pure rules of the Categorize run card: what the card shows for a given run
 * status, how many rows the next run takes, and what a Jev key problem means
 * in words. Wire-typed, so it lives beside the screen (not in domain/).
 */

import type { CategorizeRunStatus } from '@/budget/data/api';
import { apiErrorMessage, apiErrorParam } from '@/platform/api/baseQuery';

import { CATEGORIZE_HOURLY_LIMIT } from '@shared/contracts/categorize';
import { jevKeyProblemSchema, type JevKeyProblem } from '@shared/contracts/jev';

import { t } from './i18n';

/**
 * What the person asked the run to take: everything waiting, or a number they
 * typed. The hour trims either one, so this is a wish, not a promise.
 */
export type RunCountChoice = 'all' | number;

/**
 * What the count field says. Empty asks for everything waiting; a whole number
 * from 1 is a count, trimmed to what this start really sends (the hour's free
 * allowance decides that — the page itself has no cap); anything else is not a
 * size, so Start stays off instead of quietly sending everything.
 */
export type RunCountField =
  | { kind: 'all' }
  | { kind: 'count'; count: number; clamped: boolean }
  | { kind: 'invalid' };

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
 * The rows this start really sends: the person's choice, trimmed by the hour's
 * free allowance. The server counts the allowance with the run's own rule (not
 * the queue's size: a queue row may already carry suggestions), so the page
 * never promises more than it sends.
 */
export function runSendCount(
  status: CategorizeRunStatus | undefined,
  choice: RunCountChoice = 'all',
): number {
  const sendable = status?.candidates ?? 0;
  return choice === 'all' ? sendable : Math.min(choice, sendable);
}

/** Reads the count field: only empty means "everything waiting". */
export function runCountField(text: string, sendable: number): RunCountField {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'all' };
  // Digits only in a number-pad field; a paste can still carry sign, dot or letters.
  if (!/^\d+$/.test(trimmed)) return { kind: 'invalid' };
  const typed = Number(trimmed);
  if (!Number.isSafeInteger(typed) || typed <= 0) return { kind: 'invalid' };
  if (sendable > 0 && typed > sendable) return { kind: 'count', count: sendable, clamped: true };
  return { kind: 'count', count: typed, clamped: false };
}

/** The size to send; a field that is not a size sends nothing (Start is off). */
export function runCountChoice(field: RunCountField): RunCountChoice {
  if (field.kind === 'count') return field.count;
  return field.kind === 'all' ? 'all' : 0;
}

/** The short cue under the field, or null while the entry is usable and unclamped. */
export function runCountCue(field: RunCountField): string | null {
  if (field.kind === 'invalid') return t('run.countInvalid');
  if (field.kind === 'count' && field.clamped) return t('run.countClamped', { max: field.count });
  return null;
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

/**
 * What the hourly safety limit does to this choice, in a sentence, or null when
 * the whole choice fits: the allowance is spent (and when it frees), or it trims
 * the run below what the person asked for. The limit protects the person's Jev
 * credits, not the run: a run has no size of its own.
 */
export function runHourlyHint(
  status: CategorizeRunStatus | undefined,
  choice: RunCountChoice = 'all',
): string | null {
  const asked = choice === 'all' ? (status?.waiting ?? 0) : choice;
  const sendable = status?.candidates ?? 0;
  if (asked === 0 || asked <= sendable) return null;
  if (sendable === 0) {
    return t('run.hourSpent', { minutes: status?.hourly.frees_in_minutes ?? 60 });
  }
  return t('run.hourTrims', { count: sendable, limit: CATEGORIZE_HOURLY_LIMIT });
}

/** The failures line of a finished run, or null when every row was answered. */
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
