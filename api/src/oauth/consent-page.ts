import type { Locale } from '@shared/i18n';

import { t } from './i18n';

/** HTML-escape for text and double-quoted attribute contexts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ConsentView {
  clientName: string;
  redirectUri: string;
  scopes: string[];
  email: string;
  action: string;
  /** Page language (from Accept-Language); never the process-wide locale. */
  locale: Locale;
  /** Hidden form fields to round-trip (all values escaped on render). */
  fields: Record<string, string>;
}

export function renderConsent(v: ConsentView): string {
  const tr = t.for(v.locale);
  let host: string;
  try {
    const u = new URL(v.redirectUri);
    // Custom (non-web) schemes: show the scheme explicitly so the user knows it opens a desktop app.
    host = u.protocol === 'https:' || u.protocol === 'http:' ? u.host : `${u.protocol}//${u.host}`;
  } catch {
    host = tr('consent.invalidHost');
  }
  const hidden = Object.entries(v.fields)
    .map(([k, val]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(val)}">`)
    .join('\n');
  const scopes = v.scopes
    .map((s) => `<li>${s === 'write' ? tr('consent.scopeWrite') : tr('consent.scopeRead')}</li>`)
    .join('');
  return `<!doctype html>
<html lang="${v.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(tr('consent.title'))}</title>
<style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111}
.box{border:1px solid #ddd;border-radius:12px;padding:1.5rem}code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px;word-break:break-all}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #888;cursor:pointer;margin-right:.5rem}
button.ok{background:#111;color:#fff;border-color:#111}</style></head>
<body><div class="box">
<h1>${tr('consent.heading', { client: escapeHtml(v.clientName) })}</h1>
<p>${tr('consent.signedIn', { email: escapeHtml(v.email) })}</p>
<p>${tr('consent.sentBack', { host: escapeHtml(host) })}</p>
<ul>${scopes}</ul>
<form method="post" action="${escapeHtml(v.action)}">
${hidden}
<button class="ok" type="submit" name="decision" value="approve">${escapeHtml(tr('consent.approve'))}</button>
<button type="submit" name="decision" value="deny">${escapeHtml(tr('consent.deny'))}</button>
</form></div></body></html>`;
}

/** Keys of the error page messages (`i18n/en.ts`, `error.*`). */
export type ErrorPageKey =
  | 'error.unknownClient'
  | 'error.redirectNotRegistered'
  | 'error.tooLargeToResume'
  | 'error.crossOrigin'
  | 'error.sessionExpired'
  | 'error.invalidForm'
  | 'error.notAuthorized'
  | 'error.accountDisabled'
  | 'error.badRequest'
  | 'error.bodyTooLarge'
  | 'error.invalidJson';

export function renderError(locale: Locale, message: ErrorPageKey): string {
  const tr = t.for(locale);
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${escapeHtml(tr('error.title'))}</title></head>
<body style="font:16px system-ui,sans-serif;max-width:28rem;margin:4rem auto"><h1>${escapeHtml(tr('error.heading'))}</h1><p>${escapeHtml(tr(message))}</p></body></html>`;
}
