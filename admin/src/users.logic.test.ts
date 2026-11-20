/// <reference types="bun" />
import { expect, test } from 'bun:test';

import { errorMessage, lockLabel, matchesFilter, passwordState, relativeTime, selfLimits, signedInLabel } from './users.logic';

const now = Date.parse('2026-11-20T12:00:00Z');
const iso = (ms: number) => new Date(now + ms).toISOString();
const DAY = 86_400_000;

test('passwordState', () => {
  expect(passwordState({ has_password: false, must_change_password: false, temp_expires_at: null }, now).label).toBe('no password');
  expect(passwordState({ has_password: true, must_change_password: false, temp_expires_at: null }, now).label).toBe('password set');
  expect(passwordState({ has_password: true, must_change_password: true, temp_expires_at: iso(5 * DAY - 1000) }, now).label).toBe(
    'temp password, expires in 5 days',
  );
  expect(passwordState({ has_password: true, must_change_password: true, temp_expires_at: iso(3 * 3_600_000) }, now).label).toBe(
    'temp password, expires in 3 hours',
  );
  expect(passwordState({ has_password: true, must_change_password: true, temp_expires_at: iso(1000) }, now).label).toBe(
    'temp password, expires in 1 minute',
  );
  const expired = passwordState({ has_password: true, must_change_password: true, temp_expires_at: iso(-1) }, now);
  expect(expired).toEqual({ label: 'temp password expired', tone: 'bad' });
});

test('time left rounds up', () => {
  const f = (ms: number) => passwordState({ has_password: true, must_change_password: true, temp_expires_at: iso(ms) }, now).label;
  expect(f(7 * DAY - 1000)).toBe('temp password, expires in 7 days');
});

test('lockLabel only while locked', () => {
  expect(lockLabel(null, now)).toBeNull();
  expect(lockLabel(iso(-1000), now)).toBeNull();
  expect(lockLabel(iso(60_000), now)).toMatch(/^locked until \d/);
});

test('relative and sign-in labels', () => {
  expect(relativeTime(null, now)).toBe('never');
  expect(relativeTime(iso(-10_000), now)).toBe('just now');
  expect(relativeTime(iso(-2 * DAY), now)).toBe('2 days ago');
  expect(signedInLabel({ signed_in_at: null }, now)).toBe('never signed in');
  expect(signedInLabel({ signed_in_at: iso(-60_000) }, now)).toBe('signed in 1 minute ago');
});

test('filter matches e-mail or name, case-insensitive', () => {
  const u = { email: 'Ana@x.org', name: 'Ana Maria' };
  expect(matchesFilter(u, '')).toBe(true);
  expect(matchesFilter(u, 'ana@')).toBe(true);
  expect(matchesFilter(u, 'maria')).toBe(true);
  expect(matchesFilter(u, 'bob')).toBe(false);
  expect(matchesFilter({ email: 'a@b.c', name: null }, 'zed')).toBe(false);
});

test('selfLimits', () => {
  expect(selfLimits({ email: 'A@b.c' }, 'a@B.c').isSelf).toBe(true);
  expect(selfLimits({ email: 'A@b.c' }, 'a@B.c').locked).toBe(true);
  expect(selfLimits({ email: 'a@b.c' }, 'x@y.z')).toEqual({ isSelf: false, locked: false, hint: null });
  // /me unresolved or failed: every row is locked, with a hint
  const unknown = selfLimits({ email: 'a@b.c' }, null);
  expect(unknown.isSelf).toBe(false);
  expect(unknown.locked).toBe(true);
  expect(unknown.hint).not.toBeNull();
});

test('errorMessage maps codes and falls back', () => {
  for (const c of ['user_exists', 'cannot_modify_self', 'last_admin', 'user_has_data', 'password_login_disabled', 'forbidden', 'not_found'])
    expect(errorMessage(c, 'raw')).not.toBe('raw');
  expect(errorMessage('weird', 'raw')).toBe('raw');
  expect(errorMessage(undefined, 'raw')).toBe('raw');
  expect(errorMessage(undefined, 'Failed to fetch', 'network')).toMatch(/^Cannot reach the API/);
  expect(errorMessage('user_exists', 'raw', 409)).toBe('A user with that e-mail already exists.');
});
