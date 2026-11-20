import { describe, expect, it } from 'bun:test';

import {
  changeTokenDead,
  checkChange,
  checkLogin,
  checkNewPassword,
  failureMessage,
  FIELD_HINTS,
  formatWait,
  GENERIC_FAILURE,
  SESSION_NOT_SAVED,
  newPasswordHint,
  parseRetryAfter,
  POLICY_MESSAGES,
} from './password.logic';

const fail = (status: number, code: string | null, retryAfter: number | null = null) => ({ status, code, retryAfter });

describe('parseRetryAfter / formatWait', () => {
  it('reads seconds and HTTP dates, rejects the rest', () => {
    expect(parseRetryAfter('60')).toBe(60);
    expect(parseRetryAfter('0')).toBe(1);
    expect(parseRetryAfter(new Date(1_000_000 + 90_000).toUTCString(), 1_000_000 - (1_000_000 % 1000))).toBeGreaterThan(80);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
  it('rounds waits up in plain units', () => {
    expect(formatWait(1)).toBe('1 second');
    expect(formatWait(45)).toBe('45 seconds');
    expect(formatWait(61)).toBe('2 minutes');
    expect(formatWait(900)).toBe('15 minutes');
    expect(formatWait(3600)).toBe('1 hour');
  });
});

describe('failureMessage', () => {
  it('one message for every invalid_credentials at sign-in', () => {
    expect(failureMessage('login', fail(401, 'invalid_credentials'))).toBe('Wrong e-mail or password.');
  });
  it('says how long to wait on 429', () => {
    expect(failureMessage('login', fail(429, 'too_many_attempts', 120))).toBe('Too many attempts. Try again in 2 minutes.');
    expect(failureMessage('login', fail(429, 'too_many_attempts'))).toContain('Wait a few minutes');
  });
  it('expired temp password asks for a new one from the admin', () => {
    expect(failureMessage('login', fail(401, 'temp_password_expired'))).toContain('administrator');
  });
  it('dead change token sends the person back with a clear reason', () => {
    expect(failureMessage('complete', fail(401, 'invalid_change_token'))).toContain('Sign in again');
    expect(changeTokenDead(fail(401, 'invalid_change_token'))).toBe(true);
    expect(changeTokenDead(fail(400, 'password_too_short'))).toBe(false);
  });
  it('every policy code has its own words', () => {
    for (const code of Object.keys(POLICY_MESSAGES)) {
      expect(failureMessage('complete', fail(400, code))).toBe(POLICY_MESSAGES[code as keyof typeof POLICY_MESSAGES]);
    }
  });
  it('wrong current password on change, no_password, offline, unknown', () => {
    expect(failureMessage('change', fail(401, 'invalid_credentials'))).toBe('The current password is not right.');
    expect(failureMessage('change', fail(400, 'no_password'))).toContain('no password');
    expect(failureMessage('login', fail(0, null))).toContain('Can’t reach');
    expect(failureMessage('login', fail(500, null))).toContain('Something went wrong');
    expect(failureMessage('login', fail(404, 'not_found'))).toContain('turned off');
  });
});

describe('more failures', () => {
  it('403 forbidden on change is explained; an unsaved session is the generic failure', () => {
    expect(failureMessage('change', fail(403, 'forbidden'))).toContain('kind of session');
    expect(failureMessage('login', SESSION_NOT_SAVED)).toBe(GENERIC_FAILURE);
  });
});

describe('form checks', () => {
  it('login needs both fields', () => {
    expect(checkLogin(' ', 'x').ok).toBe(false);
    expect(checkLogin('a@b.c', '').ok).toBe(false);
    expect(checkLogin(' a@b.c ', 'pw')).toEqual({ ok: true, value: { email: 'a@b.c', password: 'pw' } });
  });
  it('new password follows the shared policy, then the confirmation', () => {
    expect(checkNewPassword('short', 'short', 'a@b.c')).toEqual({ ok: false, error: POLICY_MESSAGES.password_too_short });
    expect(checkNewPassword('a@b.c', 'a@b.c', 'a@b.c').ok).toBe(false);
    expect(checkNewPassword('correct horse battery', 'correct horse batterx', 'a@b.c')).toEqual({
      ok: false,
      error: 'The two passwords don’t match.',
    });
    expect(checkNewPassword('correct horse battery', 'correct horse battery', 'a@b.c')).toEqual({
      ok: true,
      value: 'correct horse battery',
    });
  });
  it('change rejects a new password equal to the current one', () => {
    const pw = 'correct horse battery';
    expect(checkChange('', pw, pw, 'a@b.c').ok).toBe(false);
    expect(checkChange(pw, pw, pw, 'a@b.c')).toEqual({ ok: false, error: POLICY_MESSAGES.password_unchanged });
    expect(checkChange('old password here', pw, pw, 'a@b.c').ok).toBe(true);
  });
  it('live hint is empty until there is something wrong to say', () => {
    expect(newPasswordHint('', 'a@b.c')).toBe('');
    expect(newPasswordHint('abc', 'a@b.c')).toBe(POLICY_MESSAGES.password_too_short);
    expect(newPasswordHint('correct horse battery', 'a@b.c')).toBe('');
  });
});

describe('field hints', () => {
  it('map to the autofill vocabulary', () => {
    expect(FIELD_HINTS.email.autoComplete).toBe('username');
    expect(FIELD_HINTS.email.textContentType).toBe('username');
    expect(FIELD_HINTS.current.autoComplete).toBe('current-password');
    expect(FIELD_HINTS.new.autoComplete).toBe('new-password');
    expect(FIELD_HINTS.new.textContentType).toBe('newPassword');
  });
});
