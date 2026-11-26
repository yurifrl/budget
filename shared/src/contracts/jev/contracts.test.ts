import { describe, expect, test } from 'bun:test';

import { jevKeyDelete, jevKeyGet, jevKeySave, jevKeyTest, contracts } from './index';
import { jevKeyProblemSchema, jevKeyStatusSchema } from './outputs';

describe('Jev key contracts', () => {
  test('four user-scoped operations under /jev, none of them budget-addressed', () => {
    expect(contracts.map((op) => op.name).sort()).toEqual([
      'jev_key_delete',
      'jev_key_get',
      'jev_key_save',
      'jev_key_test',
    ]);
    for (const op of contracts) {
      expect(op.path.startsWith('/jev')).toBe(true);
      expect(Object.keys(op.input.shape)).not.toContain('budget_id');
    }
    expect(jevKeyGet.method).toBe('GET');
  });

  test('a key shorter than any real key is rejected before any call', () => {
    expect(jevKeySave.input.safeParse({ key: 'sk-or-v1-short' }).success).toBe(false);
    expect(jevKeySave.input.parse({ key: '  sk-or-v1-0123456789abcdef  ' })).toEqual({
      key: 'sk-or-v1-0123456789abcdef',
    });
  });

  test('the key itself is never on a surface that echoes inputs back', () => {
    // Save takes a secret: never CLI (shell history) or MCP (model context).
    expect(jevKeySave.expose).toEqual({ api: true, cli: false, mcp: false });
    for (const op of [jevKeyGet, jevKeyTest, jevKeyDelete]) expect(op.expose.mcp).toBe(false);
  });

  test('status answers a masked ending, a date, the shared-key flag and a reason', () => {
    const status = {
      last_four: '1234',
      saved_at: '2026-11-26T10:00:00.000Z',
      using_server_key: false,
      reason: null,
    };
    expect(jevKeyStatusSchema.parse(status)).toEqual(status);
    expect(jevKeyStatusSchema.parse({ ...status, last_four: null, saved_at: null, using_server_key: true, reason: 'flag_off' }))
      .toMatchObject({ using_server_key: true, reason: 'flag_off' });
    expect(jevKeyStatusSchema.safeParse({ ...status, last_four: undefined }).success).toBe(false);
    for (const reason of ['no_owner', 'flag_off', 'server_key_missing', 'key_unreadable']) {
      expect(jevKeyProblemSchema.safeParse(reason).success).toBe(true);
    }
  });
});
