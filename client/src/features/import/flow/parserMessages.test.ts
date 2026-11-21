import { afterEach, describe, expect, test } from 'bun:test';
import { setLocale } from '@shared/i18n';

import { parserMessage } from './parserMessages';

afterEach(() => setLocale('en'));

describe('parserMessage', () => {
  test('known parser diagnostics become sentences', () => {
    expect(parserMessage('empty file')).toBe('The file is empty.');
    expect(parserMessage('line 3: unreadable date "31/02/2026"')).toBe('Line 3: unreadable date “31/02/2026”');
    expect(parserMessage('line 12: amount is zero')).toBe('Line 12: the amount is zero');
    expect(parserMessage('line 1: header has no date column')).toBe('Line 1: the header has no date column');
  });

  test('unknown text is shown as the parser wrote it', () => {
    expect(parserMessage('something new')).toBe('something new');
    expect(parserMessage('line 4: something new')).toBe('line 4: something new');
  });

  test('pt-BR', () => {
    setLocale('pt-BR');
    expect(parserMessage('line 3: bad date')).toBe('Linha 3: data inválida');
    expect(parserMessage('unreadable XLS file')).toBe('Não foi possível ler o arquivo XLS.');
  });
});
