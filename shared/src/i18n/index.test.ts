import { afterEach, describe, expect, test } from 'bun:test';

import { ERROR_CODE_BY_STATUS, SPECIFIC_ERROR_CODES } from '../errors';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password-policy';
import { checkCatalogs } from './check';
import { tCommon } from './common';
import { tError, translateErrorCode } from './errors';
import {
  defineMessages,
  getLocale,
  getLocaleKey,
  isPseudoLocale,
  labels,
  LOCALES,
  parseRich,
  pluralCategory,
  registry,
  resolveLocale,
  setLocale,
  setPseudoLocale,
  subscribe,
  type RegisteredNamespace,
  type Translation,
} from './index';

const en = {
  'title': 'MERGE PAYEE',
  'greet': 'Hello {name}, you have {n} items',
  'activity.count': { one: '{count} transaction', other: '{count} transactions' },
  'activity.lastUsed': '{count} · last used {date}',
  'repeat.weekly': 'Weekly',
  'repeat.daily': 'Daily',
} as const;

const ptBR: Translation<typeof en> = {
  'title': 'MESCLAR FAVORECIDO',
  'greet': 'Olá {name}, você tem {n} itens',
  'activity.count': { one: '{count} transação', other: '{count} transações' },
  'activity.lastUsed': '{count} · último uso {date}',
  'repeat.weekly': 'Semanal',
  'repeat.daily': 'Diária',
};

const t = defineMessages('test.sample', en, { 'pt-BR': ptBR });

afterEach(() => {
  setLocale('en');
  setPseudoLocale(false);
});

describe('t', () => {
  test('plain, params and plurals in en', () => {
    expect(t('title')).toBe('MERGE PAYEE');
    expect(t('greet', { name: 'Ana', n: 3 })).toBe('Hello Ana, you have 3 items');
    expect(t('activity.count', { count: 1 })).toBe('1 transaction');
    expect(t('activity.count', { count: 0 })).toBe('0 transactions');
    expect(t('activity.count', { count: 5 })).toBe('5 transactions');
  });

  test('pt-BR, and plural 0 is singular', () => {
    setLocale('pt-BR');
    expect(t('title')).toBe('MESCLAR FAVORECIDO');
    expect(t('activity.count', { count: 0 })).toBe('0 transação');
    expect(t('activity.count', { count: 1 })).toBe('1 transação');
    expect(t('activity.count', { count: 2 })).toBe('2 transações');
  });

  test('t.for ignores the active locale', () => {
    setLocale('pt-BR');
    expect(t.for('en')('title')).toBe('MERGE PAYEE');
    setLocale('en');
    expect(t.for('pt-BR')('activity.count', { count: 2 })).toBe('2 transações');
  });

  test('pseudo-locale wraps the active-locale result, not t.for', () => {
    setPseudoLocale(true);
    expect(isPseudoLocale()).toBe(true);
    expect(getLocale()).toBe('en');
    expect(getLocaleKey()).toBe('en-XA');
    expect(t('title')).toBe('⟦MERGE PAYEE⟧');
    expect(t('activity.count', { count: 2 })).toBe('⟦2 transactions⟧');
    expect(t.for('en')('title')).toBe('MERGE PAYEE');
  });

  test('a placeholder with no value is left as written', () => {
    const loose = t as unknown as (key: string, params?: Record<string, string>) => string;
    expect(loose('greet', { name: 'Ana' })).toBe('Hello Ana, you have {n} items');
  });

  test('types: params, plural count, unknown key', () => {
    // @ts-expect-error unknown key
    t('nope');
    // @ts-expect-error missing params
    t('greet');
    // @ts-expect-error wrong param name
    t('greet', { name: 'x', m: 1 });
    // @ts-expect-error plural count must be a number
    t('activity.count', { count: '2' });
    // @ts-expect-error a message with no placeholders takes no params
    t('title', { name: 'x' });
    expect(true).toBe(true);
  });

  test('types: pt-BR with a missing key, an extra key or a plural mismatch does not compile', () => {
    // @ts-expect-error missing key
    const missing: Translation<typeof en> = { title: 'x' };
    const extra: Translation<typeof en> = {
      ...ptBR,
      // @ts-expect-error extra key
      nope: 'x',
    };
    const wrongShape: Translation<typeof en> = {
      ...ptBR,
      // @ts-expect-error plural where English has a string
      title: { one: 'a', other: 'b' },
    };
    expect([missing, extra, wrongShape]).toHaveLength(3);
  });
});

describe('labels', () => {
  const REPEAT = labels(t, { weekly: 'repeat.weekly', daily: 'repeat.daily' });
  const asRecord: Record<'weekly' | 'daily', string> = REPEAT;

  test('resolves at read time', () => {
    expect(asRecord.weekly).toBe('Weekly');
    setLocale('pt-BR');
    expect(asRecord.weekly).toBe('Semanal');
    expect({ ...REPEAT }).toEqual({ weekly: 'Semanal', daily: 'Diária' });
    expect(Object.keys(REPEAT)).toEqual(['weekly', 'daily']);
  });

  test('a key with params is a type error', () => {
    // @ts-expect-error greet needs params
    labels(t, { bad: 'greet' });
    expect(true).toBe(true);
  });
});

describe('locale state', () => {
  test('subscribe fires on change only, and unsubscribes', () => {
    let calls = 0;
    const off = subscribe(() => calls++);
    setLocale('en');
    expect(calls).toBe(0);
    setLocale('pt-BR');
    expect(calls).toBe(1);
    setPseudoLocale(true);
    expect(calls).toBe(2);
    off();
    setLocale('en');
    expect(calls).toBe(2);
  });

  test('resolveLocale', () => {
    expect(resolveLocale(['pt-BR'])).toBe('pt-BR');
    expect(resolveLocale(['pt'])).toBe('pt-BR');
    expect(resolveLocale(['pt-PT'])).toBe('pt-BR');
    expect(resolveLocale(['PT_br'])).toBe('pt-BR');
    expect(resolveLocale(['en-US'])).toBe('en');
    expect(resolveLocale(['fr-FR', 'pt-BR'])).toBe('pt-BR');
    expect(resolveLocale(['en-GB', 'pt-BR'])).toBe('en');
    expect(resolveLocale(['de', 'es'])).toBe('en');
    expect(resolveLocale([])).toBe('en');
    expect(LOCALES).toEqual(['en', 'pt-BR']);
  });

  test('pluralCategory', () => {
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('en', 0)).toBe('other');
    expect(pluralCategory('pt-BR', 0)).toBe('one');
    expect(pluralCategory('pt-BR', 1)).toBe('one');
    expect(pluralCategory('pt-BR', 2)).toBe('other');
  });
});

describe('parseRich', () => {
  test('plain text', () => {
    expect(parseRich('hello')).toEqual(['hello']);
    expect(parseRich('')).toEqual([]);
  });
  test('tags and nesting', () => {
    expect(parseRich('a <b>bold <i>both</i></b> c')).toEqual([
      'a ',
      { tag: 'b', children: ['bold ', { tag: 'i', children: ['both'] }] },
      ' c',
    ]);
  });
  test('unmatched tags stay literal', () => {
    expect(parseRich('a </b> c')).toEqual(['a </b> c']);
    expect(parseRich('a <b>c')).toEqual(['a <b>c']);
    expect(parseRich('x < y and y > z')).toEqual(['x < y and y > z']);
    expect(parseRich('<b>a <i>b</b>')).toEqual([{ tag: 'b', children: ['a <i>b'] }]);
  });
});

describe('shared namespaces', () => {
  test('every registered shared catalog is sound', () => {
    expect(checkCatalogs(registry())).toEqual([]);
  });

  test('tCommon: seeded words, months, weekdays, long date', () => {
    expect(tCommon('cancel')).toBe('Cancel');
    expect(tCommon('loading')).toBe('Loading…');
    expect(tCommon('month.long.6')).toBe('June');
    expect(tCommon('month.short.12')).toBe('Dec');
    expect(tCommon('weekday.0')).toBe('Sun');
    expect(tCommon('date.long.monthFirst', { day: 5, month: 'June', year: 2026 })).toBe('June 5, 2026');
    setLocale('pt-BR');
    expect(tCommon('cancel')).toBe('Cancelar');
    expect(tCommon('date.long.dayFirst', { day: 5, month: 'junho', year: 2026 })).toBe('5 de junho de 2026');
  });

  test('tError covers every code and translates by runtime string', () => {
    const codes = [...Object.values(ERROR_CODE_BY_STATUS), ...SPECIFIC_ERROR_CODES, 'error'];
    for (const code of codes) expect(translateErrorCode(code)).toBeTruthy();
    expect(translateErrorCode('not_a_code')).toBeUndefined();
    expect(tError('not_found')).toBe('Not found.');
    setLocale('pt-BR');
    expect(tError('not_found')).toBe('Não encontrado.');
  });

  test('password limits in the messages match the policy', () => {
    expect(tError('password_too_short')).toContain(String(PASSWORD_MIN_LENGTH));
    expect(tError('password_too_long')).toContain(String(PASSWORD_MAX_LENGTH));
  });
});

describe('checkCatalogs', () => {
  const ns = (over: Partial<RegisteredNamespace> & { en: RegisteredNamespace['en']; pt: RegisteredNamespace['en'] }): RegisteredNamespace => ({
    name: 'x',
    en: over.en,
    catalogs: { en: over.en, 'pt-BR': over.pt },
    sameAsEnglish: over.sameAsEnglish ?? new Set(),
    dynamicPrefixes: over.dynamicPrefixes ?? [],
    skipUnusedCheck: over.skipUnusedCheck ?? false,
  });

  test('flags each kind of problem', () => {
    const problems = checkCatalogs(
      [
        ns({
          en: { a: 'A {n}', b: { one: '{count} x', other: '{count} xs' }, c: 'Same', d: 'Hi', e: 'Used', 'two.three.four.five': 'deep' },
          pt: { a: 'A', b: 'plain', c: 'Same', d: '  ', extra: 'e', e: 'Usado' },
          sameAsEnglish: new Set(['e']),
        }),
      ],
      "'a' 'b' 'c' 'd' 'e'",
    );
    const text = problems.join('\n');
    expect(text).toContain('[x] extra: in pt-BR but not in en');
    expect(text).toContain('[x] a: placeholders differ');
    expect(text).toContain('[x] b: plural shape differs');
    expect(text).toContain('[x] c: pt-BR is identical to en');
    expect(text).toContain('[x] d: empty pt-BR value');
    expect(text).toContain('[x] e: listed in sameAsEnglish but pt-BR differs');
    expect(text).toContain('[x] two.three.four.five: key must be flat dotted camelCase');
    expect(text).toContain('[x] two.three.four.five: missing in pt-BR');
  });

  test('unused keys, dynamic prefixes and exemptions', () => {
    const base = { en: { used: 'Used', 'dyn.a': 'Dyn', gone: 'Gone' }, pt: { used: 'Usado', 'dyn.a': 'Din', gone: 'Foi' } };
    const src = `t('used')`;
    expect(checkCatalogs([ns({ ...base, dynamicPrefixes: ['dyn.'] })], src)).toEqual([
      '[x] gone: unused (no string literal "gone" in the package source)',
    ]);
    expect(checkCatalogs([ns({ ...base, skipUnusedCheck: true })], src)).toEqual([]);
    expect(checkCatalogs([ns(base)])).toEqual([]);
  });
});
