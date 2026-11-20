import { describe, expect, test } from 'bun:test';

import { inputLocations } from '../../operation-contract';
import {
  adminFeatureSchema,
  contracts,
  featuresAdminClearEveryone,
  featuresAdminClearUser,
  featuresAdminList,
  featuresAdminSetEveryone,
  featuresAdminSetUser,
  featuresMine,
  myFeaturesSchema,
} from './index';

const USER = '0b6f1c1e-3c1a-4f54-8a52-2d9d6f1a9b11';
const API_ONLY = { api: true, cli: false, mcp: false };

describe('features contracts', () => {
  test('the barrel lists the six operations, all api only', () => {
    expect(contracts.map((c) => c.name).sort()).toEqual([
      'features_admin_clear_everyone',
      'features_admin_clear_user',
      'features_admin_list',
      'features_admin_set_everyone',
      'features_admin_set_user',
      'features_mine',
    ]);
    for (const c of contracts) expect(c.expose, c.name).toEqual(API_ONLY);
  });

  test('features_mine is GET /features with no input', () => {
    expect(featuresMine.method).toBe('GET');
    expect(featuresMine.path).toBe('/features');
    expect(inputLocations(featuresMine)).toEqual({ path: [], query: [], body: [] });
    expect(myFeaturesSchema.parse({ features: { 'shared-pluggy-key': true } })).toEqual({ features: { 'shared-pluggy-key': true } });
    expect(() => myFeaturesSchema.parse({ features: { 'shared-pluggy-key': 'on' } })).toThrow();
  });

  test('admin paths: the key (and user) travel in the path, the value in the body', () => {
    expect(featuresAdminList.path).toBe('/admin/features');
    expect(inputLocations(featuresAdminSetEveryone)).toEqual({ path: ['key'], query: [], body: ['value'] });
    expect(inputLocations(featuresAdminClearEveryone)).toEqual({ path: ['key'], query: [], body: [] });
    expect(inputLocations(featuresAdminSetUser)).toEqual({ path: ['key', 'user_id'], query: [], body: ['value'] });
    expect(inputLocations(featuresAdminClearUser)).toEqual({ path: ['key', 'user_id'], query: [], body: [] });
  });

  test('a key outside the list, a non-boolean value and a non-uuid user are rejected', () => {
    expect(featuresAdminSetEveryone.input.safeParse({ key: 'shared-pluggy-key', value: true }).success).toBe(true);
    expect(featuresAdminSetEveryone.input.safeParse({ key: 'no-such-feature', value: true }).success).toBe(false);
    expect(featuresAdminSetEveryone.input.safeParse({ key: 'shared-pluggy-key', value: 'on' }).success).toBe(false);
    expect(featuresAdminSetEveryone.input.safeParse({ key: 'shared-pluggy-key' }).success).toBe(false);
    expect(featuresAdminSetUser.input.safeParse({ key: 'shared-pluggy-key', user_id: USER, value: false }).success).toBe(true);
    expect(featuresAdminSetUser.input.safeParse({ key: 'shared-pluggy-key', user_id: 'me', value: false }).success).toBe(false);
  });

  test('the admin row carries who and when on every stored value', () => {
    const change = { value: true, changed_by: { id: USER, email: 'a@b.test', name: null }, changed_at: '2026-11-20T10:00:00.000Z' };
    const row = { key: 'shared-pluggy-key', group: 'Banks', description: 'd', default: false, everyone: change, overrides: [{ ...change, user_id: USER }] };
    expect(adminFeatureSchema.parse(row)).toEqual(row);
    expect(adminFeatureSchema.parse({ ...row, everyone: null, overrides: [] }).everyone).toBeNull();
    expect(() => adminFeatureSchema.parse({ ...row, everyone: { value: true } })).toThrow();
    expect(() => adminFeatureSchema.parse({ ...row, group: undefined })).toThrow();
  });
});
