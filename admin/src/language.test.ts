/// <reference types="bun" />
import { expect, test } from 'bun:test';

import { localeForPreference, parseLanguagePreference } from './language';

test('parseLanguagePreference falls back to system', () => {
  expect(parseLanguagePreference('pt-BR')).toBe('pt-BR');
  expect(parseLanguagePreference('en')).toBe('en');
  expect(parseLanguagePreference('system')).toBe('system');
  expect(parseLanguagePreference('fr')).toBe('system');
  expect(parseLanguagePreference(null)).toBe('system');
});

test('localeForPreference: system follows the browser, otherwise the fixed locale', () => {
  expect(localeForPreference('system', ['pt-PT', 'en'])).toBe('pt-BR');
  expect(localeForPreference('system', ['fr'])).toBe('en');
  expect(localeForPreference('en', ['pt-BR'])).toBe('en');
  expect(localeForPreference('pt-BR', ['en-US'])).toBe('pt-BR');
});
