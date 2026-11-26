import { describe, expect, test } from 'bun:test';

import { setLocale } from '@shared/i18n';

import { errorCode, ruleExistsOutcome, ruleToCreate, suggestRule } from './transferRule.logic';

describe('suggestRule', () => {
  test('text without a variable part: "is" the whole text', () => {
    expect(suggestRule('NU PAGAMENTOS SA')).toEqual({ matchType: 'is', text: 'NU PAGAMENTOS SA' });
    expect(suggestRule('  Pix   enviado ')).toEqual({ matchType: 'is', text: 'Pix enviado' });
  });

  test('a variable tail (number, date): "starts with" the stable prefix, separators dropped', () => {
    expect(suggestRule('PAGAMENTO FATURA 11/2026')).toEqual({ matchType: 'starts_with', text: 'PAGAMENTO FATURA' });
    expect(suggestRule('TED ENVIADA *00123 JOAO')).toEqual({ matchType: 'starts_with', text: 'TED ENVIADA' });
    expect(suggestRule('PIX NUBANK - 25/11')).toEqual({ matchType: 'starts_with', text: 'PIX NUBANK' });
  });

  test('a prefix too short to mean anything, or a number first: the whole text, "is"', () => {
    expect(suggestRule('PIX 123456')).toEqual({ matchType: 'is', text: 'PIX 123456' });
    expect(suggestRule('123 DEPOSITO')).toEqual({ matchType: 'is', text: '123 DEPOSITO' });
  });
});

describe('ruleToCreate', () => {
  test('nothing when the checkbox is off or the text is blank', () => {
    expect(ruleToCreate(false, { matchType: 'is', text: 'X Y Z' })).toBeNull();
    expect(ruleToCreate(true, { matchType: 'is', text: '  ' })).toBeNull();
  });

  test('the trimmed rule otherwise; a one-character pattern is refused for the loose types only', () => {
    expect(ruleToCreate(true, { matchType: 'starts_with', text: ' PIX NUBANK ' })).toEqual({ match_type: 'starts_with', condition: 'PIX NUBANK' });
    expect(ruleToCreate(true, { matchType: 'contains', text: 'N' })).toBeNull();
    expect(ruleToCreate(true, { matchType: 'is', text: 'N' })).toEqual({ match_type: 'is', condition: 'N' });
  });
});

describe('errorCode', () => {
  test('reads the code of an RTK Query error or an API error', () => {
    expect(errorCode({ status: 409, data: { code: 'rename_rule_exists' } })).toBe('rename_rule_exists');
    expect(errorCode({ code: 'rename_rule_too_short' })).toBe('rename_rule_too_short');
    expect(errorCode(new Error('x'))).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});

describe('ruleExistsOutcome', () => {
  const body = { match_type: 'is' as const, condition: 'PIX MARIA' };
  test('the transfer payee itself holds the rule: saved', () => {
    expect(ruleExistsOutcome([{ match_type: 'is', condition: 'pix maria ' }], body, 'Transfer : Savings')).toEqual({ saved: true });
  });
  test('another payee holds it: not saved, names the payee', () => {
    expect(ruleExistsOutcome([{ match_type: 'contains', condition: 'PIX MARIA' }], body, 'Maria')).toEqual({
      saved: false,
      message: 'the payee “Maria” already has that rule',
    });
  });
  test('holder unknown: not saved, says another payee', () => {
    expect(ruleExistsOutcome([], body, undefined)).toEqual({ saved: false, message: 'another payee already has that rule' });
  });
  test('pt-BR', () => {
    setLocale('pt-BR');
    expect(ruleExistsOutcome([], body, 'Maria').message).toBe('o favorecido “Maria” já tem essa regra');
    setLocale('en');
  });
});
