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
const ids = (list: SkipEntry[]) => list.map((e) => e.item.transactionId);

describe('sendEntries', () => {
  test('sends each row once, in order', async () => {
    const calls: string[] = [];
    const out = await sendEntries([entry(1, 'a'), entry(2, 'b')], async (id) => void calls.push(id));
    expect(calls).toEqual(['a', 'b']);
    expect(ids(out.sent)).toEqual(['a', 'b']);
    expect(out.dropped).toEqual([]);
    expect(out.retry).toEqual([]);
  });

  test('a row refused for good is dropped, one that may pass is kept, and neither stops the rest', async () => {
    const out = await sendEntries([entry(1, 'a'), entry(2, 'b'), entry(3, 'c'), entry(4, 'd')], async (id) => {
      if (id === 'b') throw { status: 409, code: 'categorize_already_categorized' };
      if (id === 'c') throw { status: 500 };
      if (id === 'd') throw { status: 403 };
    });
    expect(ids(out.sent)).toEqual(['a']);
    expect(ids(out.dropped)).toEqual(['b', 'd']);
    expect(ids(out.retry)).toEqual(['c']);
  });

  test('nothing to send is nothing sent', async () => {
    expect(await sendEntries([], async () => {})).toEqual({ sent: [], dropped: [], retry: [] });
  });
});
