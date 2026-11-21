import { afterEach, describe, expect, test } from 'bun:test';

import { setLocale } from '@shared/i18n';

import { connectionStatusView, pluggyLanguage, syncWindowLabel } from './connections';
import { describeSyncOutcome } from './syncRun';

afterEach(() => setLocale('en'));

describe('banks model in pt-BR', () => {
  test('pluggyLanguage follows the active locale', () => {
    expect(pluggyLanguage()).toBe('en');
    setLocale('pt-BR');
    expect(pluggyLanguage()).toBe('pt');
  });

  test('sync outcomes are whole sentences per label', () => {
    setLocale('pt-BR');
    const done = { kind: 'done', run: null } as const;
    expect(describeSyncOutcome(done, 'Sync').text).toBe('Sincronização concluída.');
    expect(describeSyncOutcome(done, 'Re-import').text).toBe('Reimportação concluída.');
  });

  test('status pills and sync windows', () => {
    setLocale('pt-BR');
    expect(connectionStatusView('error').label).toBe('Erro de sincronização');
    expect(syncWindowLabel(0)).toBe('Todo o histórico');
  });
});
