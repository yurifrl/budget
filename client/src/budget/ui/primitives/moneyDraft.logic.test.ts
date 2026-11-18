import { describe, expect, it } from 'bun:test';

import { moneyFormat } from '../../domain/format';
import { DEFAULT_FMT_PREFS } from '../../domain/fmtPrefs';
import {
  amountCellPatch,
  amountCellValue,
  appendQuickMathOp,
  draftCommitCents,
  draftMatchesValue,
  moneyDraftText,
  quickMathOpLabel,
  signedAmountText,
} from './moneyDraft.logic';

const br = moneyFormat(DEFAULT_FMT_PREFS, false);
const us = moneyFormat({ ...DEFAULT_FMT_PREFS, numberLocale: 'en-US' }, false);

describe('signedAmountText', () => {
  it('zero is an empty draft', () => {
    expect(signedAmountText(0, br.formatAmount)).toBe('');
  });
  it('positive values carry an explicit +', () => {
    expect(signedAmountText(131451, br.formatAmount)).toBe(`+${br.formatAmount(131451)}`);
    expect(signedAmountText(131451, br.formatAmount)).toBe('+1.314,51');
  });
  it('negative values use the formatter sign as is', () => {
    expect(signedAmountText(-131451, br.formatAmount)).toBe(br.formatAmount(-131451));
    expect(signedAmountText(-131451, br.formatAmount).startsWith('+')).toBe(false);
  });
  it('follows the number locale of the formatter', () => {
    expect(signedAmountText(131451, us.formatAmount)).toBe('+1,314.51');
  });
  it('round-trips through parseMoney with its sign', () => {
    for (const cents of [1, 5590, -5590, 131451, -131451]) {
      expect(br.parseMoney(signedAmountText(cents, br.formatAmount))).toBe(cents);
    }
  });
});

describe('moneyDraftText', () => {
  it('plain: the formatted magnitude, zero included', () => {
    expect(moneyDraftText(0, { allowEmpty: false, signed: false }, br.formatAmount)).toBe('0,00');
    expect(moneyDraftText(11500, { allowEmpty: false, signed: false }, br.formatAmount)).toBe('115,00');
  });
  it('allowEmpty: zero starts blank, non-zero is formatted', () => {
    expect(moneyDraftText(0, { allowEmpty: true, signed: false }, br.formatAmount)).toBe('');
    expect(moneyDraftText(11500, { allowEmpty: true, signed: false }, br.formatAmount)).toBe('115,00');
  });
  it('signed: the signed text; zero is blank even without allowEmpty', () => {
    expect(moneyDraftText(11500, { allowEmpty: false, signed: true }, br.formatAmount)).toBe('+115,00');
    expect(moneyDraftText(0, { allowEmpty: false, signed: true }, br.formatAmount)).toBe('');
    expect(moneyDraftText(0, { allowEmpty: true, signed: true }, br.formatAmount)).toBe('');
  });
});

describe('draftMatchesValue', () => {
  it('keeps a draft that already parses to the new value', () => {
    expect(draftMatchesValue('10', 1000, false, br.parseMoney)).toBe(true);
    expect(draftMatchesValue('R$ 10,00', 1000, false, br.parseMoney)).toBe(true);
  });
  it('re-seeds a draft that parses to something else', () => {
    expect(draftMatchesValue('10', 2000, false, br.parseMoney)).toBe(false);
  });
  it('allowEmpty reset to 0: a non-blank zero draft is re-seeded, a blank one kept', () => {
    expect(draftMatchesValue('0,00', 0, true, br.parseMoney)).toBe(false);
    expect(draftMatchesValue('', 0, true, br.parseMoney)).toBe(true);
    expect(draftMatchesValue('0,00', 0, false, br.parseMoney)).toBe(true);
  });
});

describe('draftCommitCents', () => {
  const plain = { signed: false, quickMath: false };
  const qm = { signed: false, quickMath: true };
  const signed = { signed: true, quickMath: true };
  it('plain mode parses the draft', () => {
    expect(draftCommitCents('115,00', 0, plain, br.parseMoney)).toBe(11500);
    expect(draftCommitCents('', 500, plain, br.parseMoney)).toBe(br.parseMoney(''));
  });
  it('quick-math mode evaluates expressions against the prior value', () => {
    expect(draftCommitCents('50+20', 0, qm, br.parseMoney)).toBe(7000);
    expect(draftCommitCents('×2', 1500, qm, br.parseMoney)).toBe(3000);
  });
  it('quick-math mode keeps the prior value on an invalid or empty draft', () => {
    expect(draftCommitCents('5+×', 1234, qm, br.parseMoney)).toBe(1234);
    expect(draftCommitCents('', 1234, qm, br.parseMoney)).toBe(1234);
  });
  it('signed mode wins over quick-math: the operand is the sign, not an operator', () => {
    expect(draftCommitCents('-115,00', 500, signed, br.parseMoney)).toBe(-11500);
    expect(draftCommitCents('+115,00', 500, signed, br.parseMoney)).toBe(11500);
    expect(draftCommitCents('115,00', 500, signed, br.parseMoney)).toBe(11500);
  });
});

describe('appendQuickMathOp', () => {
  it('appends to a number', () => {
    expect(appendQuickMathOp('5', '+')).toBe('5+');
    expect(appendQuickMathOp('', '×')).toBe('×');
  });
  it('replaces a trailing operator', () => {
    expect(appendQuickMathOp('5+', '×')).toBe('5×');
    expect(appendQuickMathOp('5÷', '−')).toBe('5−');
  });
  it('replaces a trailing operator behind trailing spaces (and drops them)', () => {
    expect(appendQuickMathOp('5+  ', '×')).toBe('5×');
  });
  it('keeps trailing spaces when appending', () => {
    expect(appendQuickMathOp('5 ', '+')).toBe('5 +');
  });
  it('mid-expression operators still append', () => {
    expect(appendQuickMathOp('5+2', '−')).toBe('5+2−');
  });
  it('an ASCII hyphen is not the − operator glyph, so it is not replaced', () => {
    expect(appendQuickMathOp('5-', '+')).toBe('5-+');
  });
});

describe('quickMathOpLabel', () => {
  it('names each operator', () => {
    expect(quickMathOpLabel('+')).toBe('Add operator');
    expect(quickMathOpLabel('−')).toBe('Subtract operator');
    expect(quickMathOpLabel('×')).toBe('Multiply operator');
    expect(quickMathOpLabel('÷')).toBe('Divide operator');
  });
});

describe('amountCellValue', () => {
  it('an outflow shows as a negative value', () => {
    expect(amountCellValue(5590, 0)).toEqual({ isOutflow: true, cents: -5590 });
  });
  it('an inflow shows as a positive value', () => {
    expect(amountCellValue(0, 5590)).toEqual({ isOutflow: false, cents: 5590 });
  });
  it('an empty cell counts as an outflow of zero', () => {
    const v = amountCellValue(0, 0);
    expect(v.isOutflow).toBe(true);
    expect(v.cents === 0).toBe(true);
  });
  it('outflow wins when both are set', () => {
    expect(amountCellValue(100, 200)).toEqual({ isOutflow: true, cents: -100 });
  });
});

describe('amountCellPatch', () => {
  it('negative commits store an outflow', () => {
    expect(amountCellPatch(-5590)).toEqual({ outflowCents: 5590, inflowCents: 0 });
  });
  it('positive and zero commits store an inflow', () => {
    expect(amountCellPatch(5590)).toEqual({ outflowCents: 0, inflowCents: 5590 });
    expect(amountCellPatch(0)).toEqual({ outflowCents: 0, inflowCents: 0 });
  });
});
