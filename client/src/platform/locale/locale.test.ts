import { afterEach, describe, expect, test } from 'bun:test';

import { getLocale, setLocale, setPseudoLocale } from '@shared/i18n';

import { MemoryKVStore } from '../storage/memory';
import {
  getLanguagePreference,
  initLocale,
  LANGUAGE_STORAGE_KEY,
  localeForPreference,
  parseLanguagePreference,
  setLanguagePreference,
  subscribeLanguagePreference,
} from './locale';

afterEach(async () => {
  setLocale('en');
  setPseudoLocale(false);
  await setLanguagePreference(new MemoryKVStore(), 'system');
  setLocale('en');
});

describe('language preference', () => {
  test('parseLanguagePreference keeps known values only', () => {
    expect(parseLanguagePreference('pt-BR')).toBe('pt-BR');
    expect(parseLanguagePreference('en')).toBe('en');
    expect(parseLanguagePreference('system')).toBe('system');
    expect(parseLanguagePreference('fr')).toBe('system');
    expect(parseLanguagePreference(null)).toBe('system');
  });

  test('localeForPreference: system follows the device, others are fixed', () => {
    expect(localeForPreference('system', ['pt-BR', 'en-US'])).toBe('pt-BR');
    expect(localeForPreference('system', ['de'])).toBe('en');
    expect(localeForPreference('en', ['pt-BR'])).toBe('en');
    expect(localeForPreference('pt-BR', [])).toBe('pt-BR');
  });

  test('initLocale applies a stored override', async () => {
    const storage = new MemoryKVStore({ [LANGUAGE_STORAGE_KEY]: 'pt-BR' });
    expect(await initLocale(storage)).toBe('pt-BR');
    expect(getLocale()).toBe('pt-BR');
    expect(getLanguagePreference()).toBe('pt-BR');
  });

  test('initLocale ignores a junk stored value', async () => {
    expect(await initLocale(new MemoryKVStore({ [LANGUAGE_STORAGE_KEY]: 'klingon' }))).toBe('system');
  });

  test('setLanguagePreference persists, applies and notifies; system removes the key', async () => {
    const storage = new MemoryKVStore();
    let calls = 0;
    const off = subscribeLanguagePreference(() => calls++);
    await setLanguagePreference(storage, 'pt-BR');
    expect(getLocale()).toBe('pt-BR');
    expect(await storage.get<string | null>(LANGUAGE_STORAGE_KEY, null)).toBe('pt-BR');
    expect(calls).toBeGreaterThan(0);
    await setLanguagePreference(storage, 'system');
    expect(await storage.get(LANGUAGE_STORAGE_KEY, null)).toBeNull();
    expect(getLanguagePreference()).toBe('system');
    off();
  });
});
