import { describe, expect, test } from 'bun:test';

import {
  FEATURES,
  FEATURE_KEYS,
  featureDefaults,
  featureDefinition,
  featureKeySchema,
  featureSource,
  isFeatureKey,
  resolveFeature,
  resolveFeatureValue,
  withFeatureDefaults,
  type FeatureKey,
} from './features';

describe('feature list', () => {
  test("registers 'shared-pluggy-key', off by default", () => {
    const feature = FEATURES.find((f) => f.key === 'shared-pluggy-key');
    expect(feature).toBeDefined();
    expect(feature!.default).toBe(false);
    expect(feature!.group).toBe('Banks');
    expect(feature!.description).toContain('shared Pluggy keys');
    expect(featureDefinition('shared-pluggy-key')).toBe(feature!);
  });

  test("registers 'shared-ai-key', off by default", () => {
    const feature = FEATURES.find((f) => f.key === 'shared-ai-key');
    expect(feature).toBeDefined();
    expect(feature!.default).toBe(false);
    expect(feature!.group).toBe('AI');
    expect(feature!.description).toContain('shared AI key');
    expect(featureDefinition('shared-ai-key')).toBe(feature!);
  });

  test('every feature has a unique kebab-case key, a short group, a description and a boolean default', () => {
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURES.length);
    for (const f of FEATURES) {
      expect(f.key).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      expect(f.description.trim().length).toBeGreaterThan(10);
      expect(f.group).toMatch(/^\S.{0,22}\S$/);
      expect(typeof f.default).toBe('boolean');
    }
  });

  test('the key type and schema accept listed keys only', () => {
    const key: FeatureKey = 'shared-pluggy-key';
    expect(featureKeySchema.parse(key)).toBe(key);
    expect(featureKeySchema.safeParse('no-such-feature').success).toBe(false);
    expect(isFeatureKey('shared-pluggy-key')).toBe(true);
    expect(isFeatureKey('no-such-feature')).toBe(false);
  });
});

describe('resolveFeature', () => {
  const key: FeatureKey = 'shared-pluggy-key'; // default off

  test('nothing stored: the default in code', () => {
    expect(resolveFeature(key)).toBe(false);
    expect(resolveFeature(key, { everyone: null, user: null })).toBe(false);
    expect(featureSource({})).toBe('default');
  });

  test('the everyone value beats the default', () => {
    expect(resolveFeature(key, { everyone: true })).toBe(true);
    expect(resolveFeature(key, { everyone: false })).toBe(false);
    expect(featureSource({ everyone: false })).toBe('everyone');
  });

  test('the user override beats the everyone value, in both directions', () => {
    expect(resolveFeature(key, { everyone: true, user: false })).toBe(false);
    expect(resolveFeature(key, { everyone: false, user: true })).toBe(true);
    expect(resolveFeature(key, { user: true })).toBe(true);
    expect(featureSource({ everyone: true, user: false })).toBe('user');
  });
});

describe('resolveFeatureValue', () => {
  test('same order with any default: user, else everyone, else the default', () => {
    expect(resolveFeatureValue(true)).toBe(true);
    expect(resolveFeatureValue(true, { everyone: false })).toBe(false);
    expect(resolveFeatureValue(true, { everyone: false, user: true })).toBe(true);
    expect(resolveFeatureValue(false, { user: null, everyone: null })).toBe(false);
  });
});

describe('client-side defaults', () => {
  test('featureDefaults lists every key at its default', () => {
    expect(featureDefaults()).toEqual({ 'shared-pluggy-key': false, 'shared-ai-key': false });
  });

  test('withFeatureDefaults keeps known booleans, drops unknown keys, fills missing ones', () => {
    expect(withFeatureDefaults(undefined)).toEqual({ 'shared-pluggy-key': false, 'shared-ai-key': false });
    expect(withFeatureDefaults({ 'shared-pluggy-key': true, 'retired-feature': true })).toEqual({
      'shared-pluggy-key': true,
      'shared-ai-key': false,
    });
    expect(withFeatureDefaults({ 'shared-pluggy-key': 'yes' })).toEqual({ 'shared-pluggy-key': false, 'shared-ai-key': false });
  });
});
