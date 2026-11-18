import { describe, expect, test } from 'bun:test';

import { accountSavePatch, balanceEdit, closeAccountPatch, closeConfirm } from './accountEdit';
import { DEFAULT_MONEY_FORMAT } from './format';

const fmt = DEFAULT_MONEY_FORMAT;

describe('balanceEdit', () => {
  test('untouched: shows the formatted working balance and is unchanged', () => {
    const edit = balanceEdit(null, 123456, fmt);
    expect(edit.text).toBe(fmt.formatMoney(123456));
    expect(edit).toMatchObject({ cents: 123456, changed: false });
  });

  test('a negative working balance round-trips unchanged', () => {
    expect(balanceEdit(null, -98765, fmt)).toMatchObject({ cents: -98765, changed: false });
  });

  test('a draft is shown verbatim and parsed', () => {
    const text = fmt.formatMoney(5000);
    expect(balanceEdit(text, 123456, fmt)).toEqual({ text, cents: 5000, changed: true });
  });

  test('a draft that parses back to the working balance is unchanged', () => {
    expect(balanceEdit(fmt.formatMoney(123456), 123456, fmt).changed).toBe(false);
  });

  test('an emptied draft parses like the formatter does (changed unless the balance equals it)', () => {
    const empty = fmt.parseMoney('');
    expect(balanceEdit('', 123456, fmt)).toEqual({ text: '', cents: empty, changed: empty !== 123456 });
    expect(balanceEdit('', empty, fmt).changed).toBe(false);
  });
});

describe('accountSavePatch', () => {
  const base = { name: ' Nubank ', note: '  ', userId: 'u1', savedUserId: 'u1', balance: { cents: 100, changed: false } };

  test('a blank nickname blocks the save', () => {
    expect(accountSavePatch({ ...base, name: '   ' })).toEqual({ error: 'nickname is required' });
  });

  test('trims name and note; a blank note is null; unchanged extras are omitted', () => {
    expect(accountSavePatch(base)).toEqual({ patch: { name: 'Nubank', note: null } });
    expect(accountSavePatch({ ...base, note: ' joint ' })).toEqual({ patch: { name: 'Nubank', note: 'joint' } });
  });

  test('owner rides along only when changed, including to nobody', () => {
    expect(accountSavePatch({ ...base, userId: 'u2' })).toEqual({ patch: { name: 'Nubank', note: null, userId: 'u2' } });
    expect(accountSavePatch({ ...base, userId: null })).toEqual({ patch: { name: 'Nubank', note: null, userId: null } });
    expect(accountSavePatch({ ...base, userId: null, savedUserId: null })).toEqual({ patch: { name: 'Nubank', note: null } });
  });

  test('closed rides along when given, false (reopen) included', () => {
    expect(accountSavePatch({ ...base, closed: false })).toEqual({ patch: { name: 'Nubank', note: null, closed: false } });
    expect(accountSavePatch({ ...base, closed: true })).toEqual({ patch: { name: 'Nubank', note: null, closed: true } });
  });

  test('a changed balance is sent, zero included', () => {
    expect(accountSavePatch({ ...base, balance: { cents: 0, changed: true } })).toEqual({
      patch: { name: 'Nubank', note: null, workingBalanceCents: 0 },
    });
  });
});

describe('closeAccountPatch', () => {
  test('a non-zero balance is zeroed out with the close', () => {
    expect(closeAccountPatch(1500)).toEqual({ workingBalanceCents: 0, closed: true });
    expect(closeAccountPatch(-1500)).toEqual({ workingBalanceCents: 0, closed: true });
  });

  test('a zero balance just closes', () => {
    expect(closeAccountPatch(0)).toEqual({ closed: true });
  });
});

describe('closeConfirm', () => {
  test('zero balance asks plainly', () => {
    expect(closeConfirm(0, true)).toEqual({ kind: 'plain' });
  });

  test('positive on-budget money leaves the plan', () => {
    expect(closeConfirm(2500, true)).toEqual({ kind: 'adjust', adjustment: 2500, leavesPlan: true });
  });

  test('debt, or off-budget money, adjusts without the plan warning', () => {
    expect(closeConfirm(-2500, true)).toEqual({ kind: 'adjust', adjustment: 2500, leavesPlan: false });
    expect(closeConfirm(2500, false)).toEqual({ kind: 'adjust', adjustment: 2500, leavesPlan: false });
  });
});
