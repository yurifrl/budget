import { afterEach, describe, expect, test } from 'bun:test';

import { checkCatalogs } from '@shared/i18n/check';
import { getLocale, registry, setLocale } from '@shared/i18n';

import { renderConsent, renderError } from './consent-page';
import { acceptLanguageTags, requestLocale, t } from './i18n';

afterEach(() => setLocale('en'));

const view = (locale: 'en' | 'pt-BR') => ({
  clientName: '<b>Cursor</b>',
  redirectUri: 'https://app.example/cb',
  scopes: ['read', 'write'],
  email: 'a@b.test',
  action: '/oauth/authorize',
  locale,
  fields: { csrf: 'x' },
});

describe('OAuth consent page i18n', () => {
  test('the oauth catalog is sound (same keys and placeholders in en and pt-BR)', () => {
    expect(checkCatalogs(registry().filter((ns) => ns.name === 'oauth'))).toEqual([]);
  });

  test('Accept-Language picks the locale by quality, then order', () => {
    expect(acceptLanguageTags('pt-BR,pt;q=0.9,en;q=0.8')).toEqual(['pt-BR', 'pt', 'en']);
    expect(acceptLanguageTags('en;q=0.5, pt-BR;q=0.9')).toEqual(['pt-BR', 'en']);
    expect(acceptLanguageTags('*, fr;q=0')).toEqual([]);
    expect(requestLocale('pt-BR,pt;q=0.9,en;q=0.8')).toBe('pt-BR');
    expect(requestLocale('fr-FR, pt;q=0.4')).toBe('pt-BR');
    expect(requestLocale('en-US,en;q=0.9,pt;q=0.5')).toBe('en');
    expect(requestLocale('de')).toBe('en');
    expect(requestLocale(undefined)).toBe('en');
  });

  test('renders English and Portuguese with the lang attribute and escaped user text', () => {
    const en = renderConsent(view('en'));
    expect(en).toContain('<html lang="en">');
    expect(en).toContain('Authorize <strong>&lt;b&gt;Cursor&lt;/b&gt;</strong>?');
    expect(en).toContain('Approve</button>');
    expect(en).toContain('Make changes to your budget data');
    const pt = renderConsent(view('pt-BR'));
    expect(pt).toContain('<html lang="pt-BR">');
    expect(pt).toContain('Autorizar <strong>&lt;b&gt;Cursor&lt;/b&gt;</strong>?');
    expect(pt).toContain('Aprovar</button>');
    expect(pt).toContain('Ver os dados do seu orçamento');
    expect(pt).not.toContain('Approve');
  });

  test('error page is translated and never touches the locale singleton', () => {
    expect(renderError('pt-BR', 'error.sessionExpired')).toContain('Sua sessão expirou. Comece de novo.');
    expect(renderError('pt-BR', 'error.sessionExpired')).toContain('<html lang="pt-BR">');
    expect(renderError('en', 'error.sessionExpired')).toContain('Your session expired. Start again.');
    expect(getLocale()).toBe('en');
    expect(t.for('pt-BR')('consent.deny')).toBe('Negar');
  });
});
