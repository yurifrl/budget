import { describe, expect, test } from 'bun:test';

import type { CategorizeRunStatus } from '@/budget/data/api';

import { jevKeyProblemSchema } from '@shared/contracts/jev';

import {
  RUN_BATCH,
  runFailureLabel,
  runFailureNeedsKey,
  runFailuresLabel,
  runHeadline,
  runKeyProblemLabel,
  runOffersKeyLink,
  runPhase,
  runPollMs,
  runProgressLabel,
  runRestLabel,
  runSendCount,
  runStartErrorMessage,
} from './run.logic';

const status = (
  run: CategorizeRunStatus['run'],
  extra: Partial<CategorizeRunStatus> = {},
): CategorizeRunStatus => ({
  budget_id: '11111111-1111-4111-8111-111111111111',
  configured: true,
  candidates: 0,
  reason: null,
  run,
  ...extra,
});

const running = status({
  state: 'running',
  run_id: '22222222-2222-4222-8222-222222222222',
  done: 3,
  total: 10,
  failures: 0,
  failure: null,
  started_at: '2026-11-26T10:00:00.000Z',
});

describe('runPhase', () => {
  test('no run at all is "never"; each ledger state maps to its phase', () => {
    expect(runPhase(undefined)).toBe('never');
    expect(runPhase(status(null))).toBe('never');
    const base = running.run!;
    expect(runPhase(status(base))).toBe('running');
    expect(runPhase(status({ ...base, state: 'queued' }))).toBe('waiting');
    expect(runPhase(status({ ...base, state: 'succeeded' }))).toBe('finished');
    expect(runPhase(status({ ...base, state: 'failed' }))).toBe('failed');
    expect(runPhase(status({ ...base, state: 'cancelled' }))).toBe('cancelled');
  });
});

describe('runPollMs', () => {
  test('polls only while a run can still change on its own', () => {
    expect(runPollMs(running)).toBe(2000);
    expect(runPollMs(status({ ...running.run!, state: 'queued' }))).toBe(2000);
    expect(runPollMs(status({ ...running.run!, state: 'succeeded' }))).toBe(0);
    expect(runPollMs(undefined)).toBe(0);
  });
});

describe('runSendCount', () => {
  test('the count is the run\'s own candidate count, never the queue size', () => {
    expect(runSendCount(undefined)).toBe(0);
    expect(runSendCount(status(null, { candidates: 7 }))).toBe(7);
    // The server caps at the limit; the page repeats its number, not a guess.
    expect(runSendCount(status(null, { candidates: RUN_BATCH }))).toBe(RUN_BATCH);
  });
});

describe('the card lines', () => {
  test('headline follows the phase, and a finished run names its own result', () => {
    expect(runHeadline(undefined)).toBe('No run yet.');
    expect(runHeadline(running)).toBe('Asking Jev…');
    expect(runHeadline(status({ ...running.run!, state: 'succeeded' }))).toBe(
      'Run finished: 3 of 10 suggested, 0 could not be answered.',
    );
    // A run that had nothing to ask about says so, without a count.
    expect(runHeadline(status({ ...running.run!, state: 'succeeded', total: 0 }))).toBe(
      'The last run finished.',
    );
    expect(runHeadline(status({ ...running.run!, state: 'failed' }))).toBe('The last run failed.');
  });

  test('progress shows only when there was something to do', () => {
    expect(runProgressLabel(running)).toBe('3 of 10 transactions');
    expect(runProgressLabel(status({ ...running.run!, done: 0, total: 0 }))).toBeNull();
    expect(runProgressLabel(undefined)).toBeNull();
  });

  test('the failures summary appears only when a call failed', () => {
    expect(runFailuresLabel(running)).toBeNull();
    expect(runFailuresLabel(status({ ...running.run!, failures: 1 }))).toBe(
      '1 could not be answered; a later run retries it.',
    );
  });

  test('every key problem in the contract has a sentence naming the Jev API key', () => {
    // The schema is the source of truth: a new reason cannot reach the card
    // without a case here (tsc on the switch) and in this list.
    for (const problem of jevKeyProblemSchema.options) {
      for (const isOwner of [true, false]) {
        expect(runKeyProblemLabel(problem, { isOwner }), problem).toContain('Jev API key');
      }
    }
  });

  test('a member is never told to save a key a run would not use', () => {
    for (const problem of jevKeyProblemSchema.options) {
      if (problem === 'no_owner') continue;
      expect(runKeyProblemLabel(problem, { isOwner: false }), problem).toContain('owner');
    }
  });

  test('the key link is offered only where saving a key could help the caller', () => {
    for (const problem of jevKeyProblemSchema.options) {
      expect(runOffersKeyLink(problem, { isOwner: false }), problem).toBe(false);
    }
    expect(runOffersKeyLink('no_owner', { isOwner: true })).toBe(false);
    expect(runOffersKeyLink('flag_off', { isOwner: true })).toBe(true);
    expect(runOffersKeyLink('key_unreadable', { isOwner: true })).toBe(true);
  });

  test('a stopped run says why, one sentence per code, and nothing otherwise', () => {
    expect(runFailureLabel(running, { isOwner: true })).toBeNull();
    const codes = [
      'not_configured',
      'key_rejected',
      'no_credits',
      'jev_unavailable',
      'no_categories',
      'too_many_categories',
      'internal',
    ] as const;
    for (const failure of codes) {
      const label = runFailureLabel(status({ ...running.run!, failure }), { isOwner: true });
      expect(label, failure).toContain('The run');
    }
  });

  test('a member is never told to save or re-save the key over a stopped run', () => {
    for (const failure of ['key_rejected', 'no_credits', 'not_configured'] as const) {
      const label = runFailureLabel(status({ ...running.run!, failure }), { isOwner: false });
      expect(label, failure).toContain('owner');
    }
  });

  test('a run stopped over its key links to the key screen; another failure does not', () => {
    for (const failure of ['key_rejected', 'no_credits', 'not_configured'] as const) {
      expect(runFailureNeedsKey(status({ ...running.run!, failure })), failure).toBe(true);
    }
    for (const failure of ['jev_unavailable', 'internal', null] as const) {
      expect(runFailureNeedsKey(status({ ...running.run!, failure })), String(failure)).toBe(false);
    }
  });

  test('a start refused over its key answers with the reason\'s own sentence, not "Jev is unavailable"', () => {
    const refused = { status: 503, data: { error: 'x', code: 'jev_unavailable', params: { reason: 'no_owner' } } };
    expect(runStartErrorMessage(refused, { isOwner: true })).toBe(
      'No Jev API key can be used: this budget has no owner to take one from.',
    );
    // A member reads the owner's duty, never their own.
    const unreadable = { status: 503, data: { error: 'x', code: 'jev_unavailable', params: { reason: 'key_unreadable' } } };
    expect(runStartErrorMessage(unreadable, { isOwner: false })).toContain('owner');
    // A refused start for another cause keeps the catalog's sentence.
    const tooMany = { status: 409, data: { error: 'x', code: 'categorize_too_many_categories', params: { max: 400 } } };
    expect(runStartErrorMessage(tooMany, { isOwner: true })).toContain('more than 400 categories');
  });

  test('the rest-hint shows only when the run came back with a full batch', () => {
    expect(runRestLabel(status(null, { candidates: RUN_BATCH - 1 }))).toBeNull();
    expect(runRestLabel(undefined)).toBeNull();
    expect(runRestLabel(status(null, { candidates: RUN_BATCH }))).not.toBeNull();
  });
});
