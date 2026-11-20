/**
 * Rules for a password a person CHOOSES (first change after a temporary
 * password, or a later change). Pure: the API enforces them, the client may
 * show the same verdict before submitting. Temporary passwords are generated
 * by the server and are not subject to these rules.
 *
 * - 12 to 128 characters (Unicode code points), no composition rules;
 * - not the account's e-mail (case and surrounding spaces ignored);
 * - not one of a small built-in list of very common passwords (compared
 *   lower-cased).
 *
 * "Not equal to the current/temporary password" needs the stored hash and is
 * checked by the API (`password_unchanged`).
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Every reason the API may refuse a chosen password (also the error `code`). */
export const PASSWORD_REJECTION_CODES = [
  'password_too_short',
  'password_too_long',
  'password_is_email',
  'password_too_common',
  'password_unchanged',
] as const;
export type PasswordRejection = (typeof PASSWORD_REJECTION_CODES)[number];

/**
 * Very common passwords of 12+ characters (shorter ones already fail the
 * length rule). Deliberately small: this is a guard against the obvious, not
 * a breach corpus.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789012345',
  '1234567890qwerty',
  '1q2w3e4r5t6y',
  '1q2w3e4r5t6y7u',
  '1qaz2wsx3edc',
  '1qaz2wsx3edc4rfv',
  'qazwsxedcrfv',
  'qwertyuiopasdfgh',
  'qwertyuiop12',
  'qwertyuiop123',
  'qwerty123456',
  'qwerty12345678',
  'asdfghjkl123',
  'asdfghjkl;\'',
  'zxcvbnm12345',
  'abc123456789',
  'abcdefghijkl',
  'abcd1234abcd',
  'aaaaaaaaaaaa',
  '111111111111',
  '000000000000',
  '121212121212',
  '112233445566',
  '123123123123',
  '987654321098',
  'password1234',
  'password12345',
  'password123456',
  'password!234',
  'passwordpassword',
  'password1password1',
  'p@ssw0rd1234',
  'p@ssword1234',
  'passw0rd1234',
  'mypassword123',
  'mypassword1234',
  'changeme1234',
  'changemenow!',
  'letmein12345',
  'letmeinplease',
  'welcome12345',
  'welcome123456',
  'iloveyou1234',
  'iloveyou12345',
  'administrator',
  'administrator1',
  'admin1234567',
  'admin123456789',
  'superman1234',
  'football1234',
  'baseball1234',
  'princess1234',
  'sunshine1234',
  'trustno1trustno1',
  'monkey123456',
  'dragon123456',
  'starwars1234',
  'computer1234',
  'internet1234',
  'whatever1234',
  'budget123456',
  'budgetbudget',
  'senha1234567',
  'senha123456789',
  'mudar1234567',
]);

const codePoints = (s: string): number => [...s].length;

/** Why `password` may not be chosen by the owner of `email`; null = acceptable. */
export function passwordRejection(password: string, email: string): Exclude<PasswordRejection, 'password_unchanged'> | null {
  const n = codePoints(password);
  if (n < PASSWORD_MIN_LENGTH) return 'password_too_short';
  if (n > PASSWORD_MAX_LENGTH) return 'password_too_long';
  const folded = password.trim().toLowerCase();
  if (email && folded === email.trim().toLowerCase()) return 'password_is_email';
  if (COMMON_PASSWORDS.has(folded)) return 'password_too_common';
  return null;
}

/** Human-readable message per rejection (the API's `error` text). */
export const PASSWORD_REJECTION_MESSAGES: Readonly<Record<PasswordRejection, string>> = {
  password_too_short: `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  password_too_long: `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  password_is_email: 'password must not be your e-mail address',
  password_too_common: 'password is too common, choose another',
  password_unchanged: 'new password must differ from the current one',
};
