import { describe, expect, test } from 'bun:test';

import { z } from './zod';

import { contracts as budget } from './contracts/budget';
import { upgradeRestorePayload } from './contracts/budget/schemas';
import { contracts as connections } from './contracts/connections';
import { defaultErrorCode, errorBody } from './errors';
import { currencyCodeSchema, milliunitsSchema } from './validation';

describe('money on the wire', () => {
  test('milliunits are integers; no budget/connections input or output field is named *cents*', () => {
    expect(milliunitsSchema.safeParse(12_340).success).toBe(true);
    expect(milliunitsSchema.safeParse(12.34).success).toBe(false);
    const json = (schema: z.ZodType) => JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
    const names = (schema: z.ZodType): string[] => json(schema).match(/"[A-Za-z_]*[cC]ents"/g) ?? [];
    // The scan sees field names (sanity: the create input mentions inflow).
    expect(json(budget.find((c) => c.name === 'budget_transactions_create')!.input)).toContain('"inflow"');
    for (const c of [...budget, ...connections]) {
      expect(names(c.input), c.name).toEqual([]);
      if (c.output) expect(names(c.output), c.name).toEqual([]);
    }
  });

  test('a legacy (cents) restore payload is scaled once; a format-2 one is untouched', () => {
    const v1 = { transactions: [{ outflow: 1234, inflow: 0 }], assignments: [{ budgeted: -5 }] };
    expect(upgradeRestorePayload(v1)).toEqual({
      format_version: 2,
      transactions: [{ outflow: 12340, inflow: 0 }],
      assignments: [{ budgeted: -50 }],
    });
    const v2 = { format_version: 2 as const, transactions: [{ outflow: 12345, inflow: 0 }], assignments: [] };
    expect(upgradeRestorePayload(v2)).toBe(v2);
  });
});

describe('currency codes', () => {
  test('normalised to upper case, exactly three letters', () => {
    expect(currencyCodeSchema.parse(' usd ')).toBe('USD');
    expect(currencyCodeSchema.safeParse('US').success).toBe(false);
    expect(currencyCodeSchema.safeParse('DOLLAR').success).toBe(false);
  });
});

describe('error codes', () => {
  test('status defaults, explicit codes win', () => {
    expect(defaultErrorCode(404)).toBe('not_found');
    expect(defaultErrorCode(418)).toBe('error');
    expect(defaultErrorCode(599)).toBe('internal');
    expect(errorBody(400, 'x is required', 'invalid_input')).toEqual({ error: 'x is required', code: 'invalid_input' });
    expect(errorBody(409, 'conflict')).toEqual({ error: 'conflict', code: 'conflict' });
  });
});
