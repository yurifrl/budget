import { describe, expect, test } from 'bun:test';

import type { SkipEntry } from './accept.logic';
import { sendEntries } from './leave.logic';

const entry = (seq: number, id: string): SkipEntry => ({
  seq,
  kind: 'skip',
  label: id,
  item: { transactionId: id, categoryId: '', categoryName: '', subject: id },
  meta: { payeeId: null, topCategoryId: null, amount: 0 },
});

describe('sendEntries', () => {
  test('sends each row once, in order', async () => {
    const calls: string[] = [];
    const out = await sendEntries([entry(1, 'a'), entry(2, 'b')], async (id) => void calls.push(id));
    expect(calls).toEqual(['a', 'b']);
    expect(out.sent.length).toBe(2);
    expect(out.failed).toEqual([]);
  });

  test('a failed row does not stop the rest and is returned for another try', async () => {
    const out = await sendEntries([entry(1, 'a'), entry(2, 'b'), entry(3, 'c')], async (id) => {
      if (id === 'b') throw new Error('no');
    });
    expect(out.sent.map((e) => e.item.transactionId)).toEqual(['a', 'c']);
    expect(out.failed.map((e) => e.item.transactionId)).toEqual(['b']);
  });

  test('nothing to send is nothing sent', async () => {
    expect(await sendEntries([], async () => {})).toEqual({ sent: [], failed: [] });
  });
});
