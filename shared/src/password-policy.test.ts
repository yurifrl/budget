import { describe, expect, test } from 'bun:test';

import { PASSWORD_REJECTION_CODES, PASSWORD_REJECTION_MESSAGES, passwordRejection } from './password-policy';

describe('passwordRejection', () => {
  test('length is 12 to 128 code points, no composition rules', () => {
    expect(passwordRejection('a'.repeat(11) + 'b', 'x@y.z')).toBeNull();
    expect(passwordRejection('short pass!', 'x@y.z')).toBe('password_too_short');
    expect(passwordRejection('lowercase only words', 'x@y.z')).toBeNull();
    expect(passwordRejection('q'.repeat(128), 'x@y.z')).toBeNull();
    expect(passwordRejection('q'.repeat(129), 'x@y.z')).toBe('password_too_long');
    // 12 emoji = 12 code points (24 UTF-16 units): accepted; 11 refused.
    expect(passwordRejection('🙂'.repeat(12), 'x@y.z')).toBeNull();
    expect(passwordRejection('🙂'.repeat(11), 'x@y.z')).toBe('password_too_short');
  });

  test('not the e-mail, ignoring case and surrounding spaces', () => {
    expect(passwordRejection('Person@Example.com', 'person@example.com')).toBe('password_is_email');
    expect(passwordRejection(' person@example.com ', 'person@example.com')).toBe('password_is_email');
    expect(passwordRejection('person@example.com!', 'person@example.com')).toBeNull();
  });

  test('very common passwords are refused, case-insensitively', () => {
    expect(passwordRejection('password1234', 'x@y.z')).toBe('password_too_common');
    expect(passwordRejection('PassWord1234', 'x@y.z')).toBe('password_too_common');
    expect(passwordRejection('123456789012', 'x@y.z')).toBe('password_too_common');
    expect(passwordRejection('correct horse battery', 'x@y.z')).toBeNull();
  });

  test('every code has a message', () => {
    for (const code of PASSWORD_REJECTION_CODES) expect(PASSWORD_REJECTION_MESSAGES[code].length).toBeGreaterThan(0);
  });
});
