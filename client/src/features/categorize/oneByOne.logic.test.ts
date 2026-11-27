import { describe, expect, test } from 'bun:test';

import {
  dropFiled,
  entriesOf,
  filedLine,
  filedLineOf,
  filedToText,
  orderQueue,
  paneLine,
  progressLabel,
  progressView,
  noSuggestionHint,
  queueCounterLabel,
  queueRowSubline,
  recordFiled,
  remainingCount,
  resolveFocus,
  transferFiledTo,
  transferSubline,
} from './oneByOne.logic';

const sugg = (confidence: number, name = 'Fuel') => ({
  category_id: `c-${name}`,
  category_name: name,
  confidence,
  reason: null,
  source: 'jev' as const,
});
const row = (id: string, confidences: number[], state: 'has_suggestions' | 'no_suggestion' = 'has_suggestions') => ({
  transaction_id: id,
  suggestions: confidences.map((c) => sugg(c)),
  state,
});

describe('orderQueue', () => {
  test('highest confidence first, rows without a suggestion last, server order on ties', () => {
    const ordered = orderQueue([
      row('manual-1', [], 'no_suggestion'),
      row('a', [0.83]),
      row('b', [0.94, 0.04]),
      row('c', [0.83]),
      row('manual-2', [], 'no_suggestion'),
    ]);
    expect(ordered.map((r) => r.transaction_id)).toEqual(['b', 'a', 'c', 'manual-1', 'manual-2']);
  });

  test('does not mutate its input', () => {
    const input = [row('x', []), row('y', [0.9])];
    orderQueue(input);
    expect(input.map((r) => r.transaction_id)).toEqual(['x', 'y']);
  });
});

describe('resolveFocus', () => {
  const rows = [{ transaction_id: 'a' }, { transaction_id: 'b' }, { transaction_id: 'c' }];

  test('keeps the focused row while it is listed, wherever it moved', () => {
    expect(resolveFocus(rows, 'b', 0)).toEqual({ row: rows[1], index: 1 });
  });

  test('a filed row hands focus to the row now at its place', () => {
    const after = rows.filter((r) => r.transaction_id !== 'b');
    expect(resolveFocus(after, 'b', 1)).toEqual({ row: after[1], index: 1 });
  });

  test('filing the last row focuses the new last one', () => {
    const after = rows.slice(0, 2);
    expect(resolveFocus(after, 'c', 2)).toEqual({ row: after[1], index: 1 });
  });

  test('no id yet focuses the first row; an empty queue focuses nothing', () => {
    expect(resolveFocus(rows, null, 0).row).toBe(rows[0]);
    expect(resolveFocus([], 'a', 3)).toEqual({ row: null, index: 0 });
  });
});

describe('remainingCount and progress', () => {
  test('rows hidden but still counted by the server are not remaining', () => {
    const pageRows = [{ transaction_id: 'a' }, { transaction_id: 'b' }];
    expect(remainingCount({ left_to_categorize: 212 }, pageRows, new Set(['a']))).toBe(211);
    expect(remainingCount({ left_to_categorize: 212 }, pageRows, new Set())).toBe(212);
    expect(remainingCount(undefined, pageRows, new Set())).toBe(0);
  });

  test('position is rows done plus one, the total is done plus what is left', () => {
    expect(progressView(36, 176)).toEqual({ position: 37, total: 212, fraction: 36 / 212 });
    expect(progressView(0, 5)).toEqual({ position: 1, total: 5, fraction: 0 });
  });

  test('the last row does not count past the total, and an empty run is zero', () => {
    expect(progressView(5, 0)).toEqual({ position: 5, total: 5, fraction: 1 });
    expect(progressView(0, 0)).toEqual({ position: 0, total: 0, fraction: 0 });
  });

  test('the counter reads "37 of 212"', () => {
    expect(progressLabel(progressView(36, 176))).toBe('37 of 212');
  });
});

describe('queueRowSubline', () => {
  test('date and best category', () => {
    expect(queueRowSubline(row('a', [0.9]), '21/11')).toBe('21/11 · Fuel');
  });

  test('a manual row says why it has no chips', () => {
    expect(queueRowSubline(row('a', [], 'no_suggestion'), '21/11')).toBe('21/11 · no suggestion');
  });
});

describe('noSuggestionHint', () => {
  test('a state with words of its own explains itself; a suggestion state draws no line', () => {
    expect(noSuggestionHint('no_suggestion')).toBe('Why no chips: no suggestion.');
    expect(noSuggestionHint('failed')).toBe('Why no chips: classification failed.');
    // No words for this state: the card must not reserve an empty second line.
    expect(noSuggestionHint('has_suggestions')).toBeNull();
  });
});

describe('filed lines', () => {
  const entry = (id: string, text = 'filed to Fuel') =>
    filedLine({ transaction_id: id, payee: `payee ${id}`, amount: -100, date: '2026-11-21' }, text);

  test('newest last; filing the same row again replaces its line', () => {
    const list = recordFiled(recordFiled([], entry('a')), entry('b'));
    expect(list.map((e) => e.transaction_id)).toEqual(['a', 'b']);
    const again = recordFiled(list, entry('a', 'filed to Travel'));
    expect(again.map((e) => e.transaction_id)).toEqual(['b', 'a']);
    expect(again[1]!.text).toBe('filed to Travel');
  });

  test('only the last few are kept', () => {
    let list = [] as ReturnType<typeof recordFiled>;
    for (let i = 0; i < 5; i += 1) list = recordFiled(list, entry(`r${i}`), 3);
    expect(list.map((e) => e.transaction_id)).toEqual(['r2', 'r3', 'r4']);
  });

  test('rows that came back lose their line', () => {
    const list = [entry('a'), entry('b'), entry('c')];
    expect(dropFiled(list, ['b']).map((e) => e.transaction_id)).toEqual(['a', 'c']);
    expect(dropFiled(list, [])).toEqual(list);
  });

  test('the line names the category', () => {
    expect(filedToText('Fuel')).toBe('filed to Fuel');
  });
});

describe('transfer lines in the pane', () => {
  const item = {
    transaction_id: 't1',
    date: '2026-11-21',
    amount: -4200,
    account_id: 'a-checking',
    account_name: 'Checking',
    payee_id: null,
    payee: 'Landlord',
    confidence: 0.83,
    transferAccountId: 'a-savings',
    transferAccountName: 'Savings',
    side: 'to' as const,
    onBudget: true,
  };
  const asRow = row('r1', [0.4]) as never;

  test('Jev’s answers lead the list, the queue rows follow in their own order', () => {
    // The caller hands in rows already ordered; the answers just lead them.
    const entries = entriesOf([asRow, row('r2', [0.9]) as never], [item]);
    expect(entries.map((entry) => entry.transaction_id)).toEqual(['t1', 'r1', 'r2']);
    expect(entries[0]!.kind).toBe('transfer');
    expect(entries[1]!.kind).toBe('queue');
  });

  test('a transfer line names the account the money went to and its certainty', () => {
    const line = paneLine(entriesOf([], [item])[0]!, (iso) => `date ${iso}`);
    expect(line).toEqual({
      payee: 'Landlord',
      subline: 'date 2026-11-21 · Transfer to Savings',
      amount: -4200,
      confidence: 0.83,
    });
    expect(transferSubline('Transfer to Savings', '21 Nov')).toBe('21 Nov · Transfer to Savings');
  });

  test('a filed transfer leaves the same kind of dimmed line as a filed category', () => {
    const transferLine = filedLineOf(entriesOf([], [item])[0]!, transferFiledTo('Savings'));
    expect(transferLine).toEqual({
      transaction_id: 't1',
      payee: 'Landlord',
      amount: -4200,
      date: '2026-11-21',
      text: 'Transfer · Savings',
    });
  });

  test('a row already answered as a transfer is not listed twice while the queue catches up', () => {
    const entries = entriesOf([asRow, row('t1', [0.9]) as never], [item]);
    expect(entries.map((entry) => entry.transaction_id)).toEqual(['t1', 'r1']);
    expect(entries.filter((entry) => entry.transaction_id === 't1')).toHaveLength(1);
    expect(entries[0]!.kind).toBe('transfer');
  });
});

describe('queueCounterLabel', () => {
  test('the queue count alone when Jev lists no answers', () => {
    expect(queueCounterLabel(0, 0)).toBe('0 left');
    expect(queueCounterLabel(12, 0)).toBe('12 left');
  });

  test('each number agrees with its own noun', () => {
    expect(queueCounterLabel(12, 1)).toBe('12 left · 1 transfer answer');
    expect(queueCounterLabel(0, 2)).toBe('0 left · 2 transfer answers');
  });
});
