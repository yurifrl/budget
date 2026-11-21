/** A backup is file-format data: what is written and what is matched never depends on the UI language. */

import { afterEach, describe, expect, test } from 'bun:test';
import { unzipSync, strFromU8 } from 'fflate';
import { setLocale } from '@shared/i18n';

import type { Budget } from '@/domain/types';
import { buildTransferZip, parseTransferFiles, PLAN_SUFFIX, REGISTER_SUFFIX } from './transfer';

afterEach(() => setLocale('en'));

const budget: Budget = {
  name: 'Home',
  accounts: [{ id: 'a1', name: 'Main', type: 'checking', group: 'CASH', onBudget: true, clearedBalance: 1000, unclearedBalance: 0, lastReconciledAt: null, userId: null }],
  groups: [{ id: 'g1', name: 'Everyday', categoryIds: ['c1'] }],
  categories: [{ id: 'c1', groupId: 'g1', name: 'Food', assigned: { 202611: 500 }, activity: {} }],
  transactions: [
    { id: 't1', accountId: 'a1', date: '2026-11-03', payee: 'Shop', categoryId: null, memo: '', outflow: 0, inflow: 1000, cleared: 'cleared' },
  ],
} as unknown as Budget;

describe('backup files across languages', () => {
  const now = new Date(2026, 10, 16, 10, 0);

  test('an archive exported in pt-BR is byte-identical to the English one and imports in en', () => {
    const en = buildTransferZip(budget, { now });
    setLocale('pt-BR');
    const pt = buildTransferZip(budget, { now });
    expect(pt.zipName).toBe(en.zipName);
    expect(Object.keys(unzipSync(pt.bytes))).toEqual(Object.keys(unzipSync(en.bytes)));
    for (const [name, bytes] of Object.entries(unzipSync(pt.bytes))) {
      expect(strFromU8(bytes)).toBe(strFromU8(unzipSync(en.bytes)[name]));
    }
    setLocale('en');
    const parsed = parseTransferFiles([{ name: 'x.zip', bytes: pt.bytes }]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.payload!.transactions).toHaveLength(1);
  });

  test('an English-exported archive imports while pt-BR is active, and errors are translated', () => {
    const en = buildTransferZip(budget, { now });
    setLocale('pt-BR');
    expect(parseTransferFiles([{ name: 'x.zip', bytes: en.bytes }]).errors).toEqual([]);
    expect(parseTransferFiles([]).errors).toEqual(['é necessário um arquivo Plan.tsv ou Register.tsv']);
    expect(PLAN_SUFFIX).toBe(' - Plan.tsv');
    expect(REGISTER_SUFFIX).toBe(' - Register.tsv');
  });
});
