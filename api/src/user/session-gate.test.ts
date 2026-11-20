import { describe, expect, test } from 'bun:test';

import { adminChangeRefusal } from './admin-guards';
import { decideSession } from './session-gate';
import { lockSecondsAfter, retryAfterSeconds } from './throttle';

const managed = { status: 'active' as const, passwordVersion: 2 };

describe('decideSession (the per-request rule)', () => {
  test('password sessions: login on, active user, password row, matching version', () => {
    const base = { idp: 'password', onConfigRule: false, passwordLogin: true };
    expect(decideSession({ ...base, pwv: 2, account: managed })).toBe(true);
    expect(decideSession({ ...base, pwv: 1, account: managed })).toBe(false);
    expect(decideSession({ ...base, pwv: 2, account: { status: 'disabled', passwordVersion: 2 } })).toBe(false);
    expect(decideSession({ ...base, pwv: 2, account: { status: 'active', passwordVersion: null } })).toBe(false);
    expect(decideSession({ ...base, pwv: 2, account: null })).toBe(false);
    expect(decideSession({ ...base, pwv: 2, account: managed, passwordLogin: false })).toBe(false);
    // On the Google list does not rescue a password session.
    expect(decideSession({ ...base, pwv: 1, account: managed, onConfigRule: true })).toBe(false);
    // Grants carry no version.
    expect(decideSession({ ...base, account: managed })).toBe(true);
  });

  test('config rule passes unchanged; unmarked sessions off the list need an active managed user', () => {
    expect(decideSession({ onConfigRule: true, passwordLogin: false })).toBe(true);
    expect(decideSession({ idp: 'access', onConfigRule: true, passwordLogin: true })).toBe(true);
    expect(decideSession({ onConfigRule: false, passwordLogin: true, account: managed })).toBe(true);
    expect(decideSession({ onConfigRule: false, passwordLogin: false, account: managed })).toBe(false);
    expect(decideSession({ onConfigRule: false, passwordLogin: true, account: { status: 'active', passwordVersion: null } })).toBe(false);
    expect(decideSession({ onConfigRule: false, passwordLogin: true, account: { status: 'disabled', passwordVersion: 1 } })).toBe(false);
    expect(decideSession({ onConfigRule: false, passwordLogin: true, account: null })).toBe(false);
    // An Access session that fails the config rule is not rescued by a password row.
    expect(decideSession({ idp: 'access', onConfigRule: false, passwordLogin: true, account: managed })).toBe(false);
  });
});

describe('throttle', () => {
  test('locks after 5 consecutive failures: 1 min doubling to a 15 min cap', () => {
    expect([1, 2, 3, 4].map(lockSecondsAfter)).toEqual([0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 50].map(lockSecondsAfter)).toEqual([60, 120, 240, 480, 900, 900, 900]);
  });
  test('Retry-After rounds up, 0 when not locked', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(retryAfterSeconds(null, now)).toBe(0);
    expect(retryAfterSeconds(new Date(now.getTime() - 1), now)).toBe(0);
    expect(retryAfterSeconds(new Date(now.getTime() + 1500), now)).toBe(2);
  });
});

describe('adminChangeRefusal', () => {
  const admin = { id: 'a', role: 'admin' as const, status: 'active' as const };
  const user = { id: 'u', role: 'user' as const, status: 'active' as const };
  test('an admin cannot disable, demote or delete themself; renaming is fine', () => {
    expect(adminChangeRefusal({ actorId: 'a', target: admin, change: { status: 'disabled' }, otherActiveAdmins: 3 })).toBe('cannot_modify_self');
    expect(adminChangeRefusal({ actorId: 'a', target: admin, change: { role: 'user' }, otherActiveAdmins: 3 })).toBe('cannot_modify_self');
    expect(adminChangeRefusal({ actorId: 'a', target: admin, change: 'delete', otherActiveAdmins: 3 })).toBe('cannot_modify_self');
    expect(adminChangeRefusal({ actorId: 'a', target: admin, change: {}, otherActiveAdmins: 0 })).toBeNull();
    expect(adminChangeRefusal({ actorId: 'a', target: admin, change: { role: 'admin', status: 'active' }, otherActiveAdmins: 0 })).toBeNull();
  });
  test('the last active admin cannot be disabled, demoted or deleted', () => {
    for (const change of [{ status: 'disabled' as const }, { role: 'user' as const }, 'delete' as const]) {
      expect(adminChangeRefusal({ actorId: 'x', target: admin, change, otherActiveAdmins: 0 })).toBe('last_admin');
      expect(adminChangeRefusal({ actorId: 'x', target: admin, change, otherActiveAdmins: 1 })).toBeNull();
    }
    // A disabled admin is not "the last active admin".
    expect(adminChangeRefusal({ actorId: 'x', target: { ...admin, status: 'disabled' }, change: 'delete', otherActiveAdmins: 0 })).toBeNull();
    expect(adminChangeRefusal({ actorId: 'x', target: user, change: { status: 'disabled' }, otherActiveAdmins: 0 })).toBeNull();
  });
});
