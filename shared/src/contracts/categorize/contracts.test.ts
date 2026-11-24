import { describe, expect, test } from 'bun:test';

import { inputLocations } from '../../operation-contract';
import {
  categorizeAccept,
  categorizeQueueList,
  categorizeRunStart,
  categorizeRunStatus,
  categorizeSettingsGet,
  categorizeSettingsSet,
  categorizeSkip,
  categorizeUndo,
  contracts,
} from './index';

const b = '11111111-1111-4111-8111-111111111111';
const t = '22222222-2222-4222-8222-222222222222';
const c = '33333333-3333-4333-8333-333333333333';

const suggestion = { category_id: c, category_name: 'Food', confidence: 0.91, reason: 'merchant', source: 'ai' as const };
const row = {
  transaction_id: t,
  date: '2026-11-01',
  amount: -2500,
  account_id: b,
  account_name: 'Checking',
  payee_id: null,
  payee: 'Padaria',
  memo: null,
  raw_bank_description: 'PADARIA 123',
  merchant: null,
  state: 'has_suggestions' as const,
  suggestions: [suggestion],
};

describe('Categorize contracts', () => {
  test('eight operations, all under /categorize, all with a budget_id', () => {
    expect(contracts.length).toBe(8);
    for (const op of contracts) {
      expect(op.path.startsWith('/categorize')).toBe(true);
      expect(Object.keys(op.input.shape)).toContain('budget_id');
      expect(inputLocations(op).path).toEqual([]);
    }
  });

  test('reads are GET; the run trigger and undo are not MCP tools (budget writes are)', () => {
    for (const op of [categorizeQueueList, categorizeRunStatus, categorizeSettingsGet]) {
      expect(op.method).toBe('GET');
      expect(op.expose).toEqual({ api: true, cli: true, mcp: true });
    }
    expect(categorizeRunStart.expose).toEqual({ api: true, cli: true, mcp: false });
    expect(categorizeUndo.expose).toEqual({ api: true, cli: true, mcp: false });
    for (const op of [categorizeAccept, categorizeSkip, categorizeSettingsSet]) expect(op.expose.mcp).toBe(true);
  });

  test('there is no re-classify flag', () => {
    expect(Object.keys(categorizeRunStart.input.shape)).toEqual(['budget_id']);
  });

  test('queue: page bounds, threshold at read time (not an input), states and bundles', () => {
    const input = categorizeQueueList.input.parse({ budget_id: b });
    expect(input).toEqual({ budget_id: b, limit: 50, offset: 0 });
    expect(categorizeQueueList.input.parse({ budget_id: b, limit: '25', offset: '10' })).toMatchObject({ limit: 25, offset: 10 });
    expect(categorizeQueueList.input.safeParse({ budget_id: b, limit: 201 }).success).toBe(false);
    expect(Object.keys(categorizeQueueList.input.shape)).not.toContain('confidence_threshold');

    const bundle = {
      bundle_key: 'eyJwYXllZV9pZCI6bnVsbCwicGF5ZWUiOiJQYWRhcmlhIiwiY2F0ZWdvcnlfaWQiOiJ4In0',
      payee_id: null,
      payee: 'Padaria',
      count: 2,
      total: -5000,
      first_date: '2026-11-01',
      last_date: '2026-11-02',
      suggestion,
    };
    const output = {
      rows: [row],
      counts: {
        left_to_categorize: 1,
        above_threshold: 1,
        has_suggestions: 1,
        below_threshold: 0,
        no_suggestion: 0,
        failed: 0,
        not_classified: 0,
      },
      bundles: [bundle],
    };
    expect(categorizeQueueList.output!.safeParse(output).success).toBe(true);
    expect(categorizeQueueList.output!.safeParse({ ...output, rows: [{ ...row, state: 'maybe' }] }).success).toBe(false);
    expect(categorizeQueueList.output!.safeParse({ ...output, rows: [{ ...row, suggestions: [{ ...suggestion, confidence: 1.1 }] }] }).success).toBe(false);
    expect(categorizeQueueList.output!.safeParse({ ...output, bundles: [{ ...bundle, total: 'x' }] }).success).toBe(false);
    expect(categorizeQueueList.input.parse({ budget_id: b, bundle: 'key' })).toMatchObject({ bundle: 'key' });
  });

  test('run start and status: no forced flag, progress shape, AI reason', () => {
    expect(categorizeRunStart.input.safeParse({ budget_id: b, force: true }).success).toBe(true); // extra keys are stripped
    expect(Object.keys(categorizeRunStart.input.parse({ budget_id: b }))).toEqual(['budget_id']);
    const active = { id: b, status: 'running', created_at: '2026-11-24T10:00:00.000Z', started_at: '2026-11-24T10:00:01.000Z', requested_by: t, done: 5, total: 100 };
    expect(categorizeRunStart.output!.safeParse({ run: active, created: true }).success).toBe(true);

    const finished = {
      id: b,
      status: 'succeeded',
      created_at: '2026-11-24T10:00:00.000Z',
      started_at: '2026-11-24T10:00:01.000Z',
      finished_at: '2026-11-24T10:10:00.000Z',
      total: 100,
      done: 98,
      suggested: 90,
      rule: 2,
      empty: 5,
      skipped: 1,
      failed: 2,
      remaining: 20,
      user_message: null,
    };
    const status = {
      active: null,
      last_finished: finished,
      ai: { available: true, reason: null, provider: 'openrouter', model: 'm', source: 'own' },
    };
    expect(categorizeRunStatus.output!.safeParse(status).success).toBe(true);
    expect(categorizeRunStatus.output!.safeParse({ ...status, ai: { ...status.ai, reason: 'no_idea' } }).success).toBe(false);
    expect(categorizeRunStatus.output!.safeParse({ ...status, last_finished: { ...finished, total: -1 } }).success).toBe(false);
  });

  test('accept takes pairs or a bundle; duplicates are invalid; undo lists skip reasons', () => {
    const items = [{ transaction_id: t, category_id: c }];
    expect(categorizeAccept.input.safeParse({ budget_id: b, items }).success).toBe(true);
    expect(categorizeAccept.input.safeParse({ budget_id: b, items: [] }).success).toBe(false);
    expect(categorizeAccept.input.safeParse({ budget_id: b, items: [{ transaction_id: 'nope', category_id: c }] }).success).toBe(false);
    expect(categorizeAccept.input.safeParse({ budget_id: b, items: [...items, ...items] }).success).toBe(false);
    expect(categorizeAccept.input.safeParse({ budget_id: b, bundle_key: 'key' }).success).toBe(true);
    expect(categorizeAccept.output!.safeParse({ accepted: 1, items }).success).toBe(true);
    expect(categorizeUndo.input.safeParse({ budget_id: b, transaction_ids: [t] }).success).toBe(true);
    expect(categorizeUndo.input.safeParse({ budget_id: b, transaction_ids: [t, t] }).success).toBe(false);
    expect(categorizeUndo.input.safeParse({ budget_id: b, items }).success).toBe(false);
    expect(categorizeUndo.input.safeParse({ budget_id: b, transaction_ids: [] }).success).toBe(false);
    expect(categorizeUndo.output!.safeParse({ restored: 1, transaction_ids: [t], skipped: [] }).success).toBe(true);
    expect(categorizeUndo.output!.safeParse({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'no_decision' }] }).success).toBe(true);
    expect(categorizeUndo.output!.safeParse({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'skipped' }] }).success).toBe(true);
    expect(categorizeUndo.output!.safeParse({ restored: 0, transaction_ids: [], skipped: [{ transaction_id: t, reason: 'stale' }] }).success).toBe(false);
    expect(categorizeUndo.output!.safeParse({ restored: 1, transaction_ids: [t] }).success).toBe(false);
  });

  test('skip names one transaction; settings are a 0..1 number', () => {
    expect(categorizeSkip.input.safeParse({ budget_id: b, transaction_id: t }).success).toBe(true);
    expect(categorizeSkip.input.safeParse({ budget_id: b, transaction_id: null }).success).toBe(false);
    expect(categorizeSkip.output!.safeParse({ dismissed: 2 }).success).toBe(true);
    expect(categorizeSettingsGet.output!.safeParse({ budget_id: b, confidence_threshold: 0.8 }).success).toBe(true);
    expect(categorizeSettingsSet.input.safeParse({ budget_id: b, confidence_threshold: 0.8 }).success).toBe(true);
    expect(categorizeSettingsSet.input.safeParse({ budget_id: b, confidence_threshold: 1.01 }).success).toBe(false);
    expect(categorizeSettingsSet.input.safeParse({ budget_id: b, confidence_threshold: -0.1 }).success).toBe(false);
  });
});
