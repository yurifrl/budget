import { describe, expect, test } from 'bun:test';

import { inputLocations } from '../../operation-contract';
import {
  adminUsersCreate,
  adminUsersDelete,
  adminUsersList,
  adminUsersResetPassword,
  adminUsersUpdate,
  adminUserSchema,
} from './admin-users';
import { contracts } from './index';
import { meSchema } from './me';
import { authPasswordChange, authPasswordComplete, authPasswordLogin, passwordLoginResultSchema } from './password';

const API_ONLY = { api: true, cli: false, mcp: false };

describe('password and admin-user contracts', () => {
  test('every new operation is api-only and in the barrel', () => {
    const ops = [authPasswordLogin, authPasswordComplete, authPasswordChange, adminUsersList, adminUsersCreate, adminUsersUpdate, adminUsersResetPassword, adminUsersDelete];
    for (const op of ops) {
      expect(op.expose).toEqual(API_ONLY);
      expect(op.output).toBeDefined();
      expect(contracts).toContain(op);
    }
  });

  test('paths and methods', () => {
    expect([authPasswordLogin.method, authPasswordLogin.path]).toEqual(['POST', '/auth/password/login']);
    expect([authPasswordComplete.method, authPasswordComplete.path]).toEqual(['POST', '/auth/password/complete']);
    expect([authPasswordChange.method, authPasswordChange.path]).toEqual(['POST', '/auth/password/change']);
    expect([adminUsersList.method, adminUsersList.path]).toEqual(['GET', '/admin/users']);
    expect([adminUsersCreate.method, adminUsersCreate.path, adminUsersCreate.status]).toEqual(['POST', '/admin/users', 201]);
    expect([adminUsersUpdate.method, adminUsersUpdate.path]).toEqual(['PATCH', '/admin/users/:id']);
    expect([adminUsersResetPassword.method, adminUsersResetPassword.path]).toEqual(['POST', '/admin/users/:id/reset-password']);
    expect([adminUsersDelete.method, adminUsersDelete.path]).toEqual(['DELETE', '/admin/users/:id']);
    expect(inputLocations(adminUsersUpdate)).toEqual({ path: ['id'], query: [], body: ['name', 'role', 'status'] });
  });

  test('login input normalises the e-mail; session delivery is cookie | token', () => {
    expect(authPasswordLogin.input.parse({ email: ' A@B.com ', password: 'x' })).toEqual({ email: 'a@b.com', password: 'x' });
    expect(() => authPasswordLogin.input.parse({ email: 'a@b.com', password: 'x', session: 'both' })).toThrow();
    expect(() => authPasswordLogin.input.parse({ email: 'a@b.com', password: 'x'.repeat(1025) })).toThrow();
  });

  test('login output is signed_in or password_change_required', () => {
    expect(passwordLoginResultSchema.parse({ status: 'signed_in', email: 'a@b.com' }).status).toBe('signed_in');
    expect(passwordLoginResultSchema.parse({ status: 'password_change_required', email: 'a@b.com', change_token: 't', expires_in: 600 }).status).toBe(
      'password_change_required',
    );
    expect(() => passwordLoginResultSchema.parse({ status: 'password_change_required', email: 'a@b.com' })).toThrow();
  });

  test('update cannot carry an e-mail (unknown keys are dropped)', () => {
    const parsed = adminUsersUpdate.input.parse({ id: crypto.randomUUID(), email: 'x@y.z', role: 'admin' }) as Record<string, unknown>;
    expect('email' in parsed).toBe(false);
  });

  test('admin user row and /me carry the password flags', () => {
    expect(Object.keys(adminUserSchema.shape)).toEqual([
      'id', 'email', 'name', 'role', 'status', 'has_password', 'must_change_password', 'temp_expires_at',
      'locked_until', 'has_google', 'signed_in_at', 'last_seen_at', 'created_at',
    ]);
    expect(Object.keys(meSchema.shape)).toContain('has_password');
  });
});
