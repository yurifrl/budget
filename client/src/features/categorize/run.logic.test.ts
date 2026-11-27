import { describe, expect, test } from 'bun:test';

import type { CategorizeRunStatus } from '@/budget/data/api';

import { CATEGORIZE_HOURLY_LIMIT } from '@shared/contracts/categorize';
import { jevKeyProblemSchema } from '@shared/contracts/jev';

import {
  runCountChoice,
  runCountField,
  runFailureLabel,
  runFailureNeedsKey,
  runFailuresLabel,
  runHeadline,
  runHourlyHint,
  runKeyProblemLabel,
  runOffersKeyLink,
  runPhase,
  runPollMs,
  runProgressLabel,
  runSendCount,
  runStartErrorMessage,
} from './run.logic';

const status = (
  run: CategorizeRunStatus['run'],
  extra: Partial<CategorizeRunStatus> = {},
): CategorizeRunStatus => ({
  budget_id: '11111111-1111-4111-8111-111111111111',
  configured: true,
  waiting: 0,
  candidates: 0,
  reason: null,
  hourly: { limit: CATEGORIZE_HOURLY_LIMIT, used: 0, frees_in_minutes: null },
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
  test('"all waiting" is what the hour allows, never the queue size', () => {
    expect(runSendCount(undefined)).toBe(0);
    expect(runSendCount(status(null, { waiting: 7, candidates: 7 }))).toBe(7);
    // Rows the hour cannot take yet are not promised.
    expect(runSendCount(status(null, { waiting: 900, candidates: 40 }))).toBe(40);
  });

  test('a typed count is trimmed by the allowance, so the page names what is sent', () => {
    const trimmed = status(null, { waiting: 500, candidates: 40 });
    expect(runSendCount(trimmed, 12)).toBe(12);
    expect(runSendCount(trimmed, 900)).toBe(40);
    expect(runSendCount(trimmed, 0)).toBe(0);
  });
});

describe('runCountField', () => {
  test('empty means everything waiting; only a whole number is a count', () => {
    expect(runCountField('', 40)).toEqual({ kind: 'all' });
    expect(runCountField('   ', 40)).toEqual({ kind: 'all' });
    expect(runCountField('12', 40)).toEqual({ kind: 'count', count: 12, clamped: false });
    expect(runCountField(' 12 ', 40)).toEqual({ kind: 'count', count: 12, clamped: false });
  });

  test('zero, negatives, fractions and text are refused instead of meaning “all”', () => {
    for (const text of ['0', '-3', '2.5', 'abc', '100000000000000000000']) {
      expect(runCountField(text, 40).kind).toBe('invalid');
    }
  });

  test('there is no per-run cap: the fresh status is the only ceiling', () => {
    // 4000 waiting: a typed 1500 is a run of 1500, not a trimmed 1000.
    expect(runCountField('1500', 4000)).toEqual({ kind: 'count', count: 1500, clamped: false });
    expect(runCountField('4001', 4000)).toEqual({ kind: 'count', count: 4000, clamped: true });
  });
});

describe('runCountChoice', () => {
  test('a field that is not a size sends nothing; Start stays off', () => {
    expect(runCountChoice({ kind: 'invalid' })).toBe(0);
    expect(runCountChoice({ kind: 'all' })).toBe('all');
    expect(runCountChoice({ kind: 'count', count: 40, clamped: true })).toBe(40);
  });
});

describe('runHourlyHint', () => {
  const hour = (used: number, frees: number | null = null) => ({
    limit: CATEGORIZE_HOURLY_LIMIT,
    used,
    frees_in_minutes: frees,
  });

  test('nothing to say when the choice fits the allowance', () => {
    expect(runHourlyHint(undefined)).toBeNull();
    expect(runHourlyHint(status(null, { waiting: 20, candidates: 20 }))).toBeNull();
    // A small typed count inside the allowance is silent even when "all" is trimmed.
    expect(runHourlyHint(status(null, { waiting: 900, candidates: 40 }), 10)).toBeNull();
  });

  test('a trimmed start says how many transactions the hour takes', () => {
    const hint = runHourlyHint(status(null, { waiting: 900, candidates: 40 }));
    expect(hint).toContain('40');
    expect(hint).toContain(String(CATEGORIZE_HOURLY_LIMIT));
  });

  test('a spent allowance says when a slot frees', () => {
    const spent = status(null, {
      waiting: 30,
      candidates: 0,
      hourly: hour(CATEGORIZE_HOURLY_LIMIT, 17),
    });
    expect(runHourlyHint(spent)).toContain('17');
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
    expect(runStartErrorMessage(tooMany, { isOwner: true })).toContain('more than 400 options');
  });

  test('a refusal over the hourly limit keeps the sentence naming the wait', () => {
    const refused = {
      status: 429,
      data: { error: 'x', code: 'categorize_hourly_limit', params: { limit: CATEGORIZE_HOURLY_LIMIT, minutes: 23 } },
    };
    expect(runStartErrorMessage(refused, { isOwner: true })).toContain('23');
  });
});
