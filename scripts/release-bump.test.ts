import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bumpTarget, nextAppVersion, parseTarget } from './release-bump';

const NOW = new Date('2026-11-23T12:00:00Z');

describe('nextAppVersion', () => {
  test('an older date moves to today', () => {
    expect(nextAppVersion('2026.11.20-04', NOW)).toBe('2026.11.23');
  });
  test('same day adds or increments the suffix', () => {
    expect(nextAppVersion('2026.11.23', NOW)).toBe('2026.11.23-01');
    expect(nextAppVersion('2026.11.23-09', NOW)).toBe('2026.11.23-10');
  });
  test('an exhausted suffix rolls to the next day', () => {
    expect(nextAppVersion('2026.11.23-99', NOW)).toBe('2026.11.24');
  });
  test('rejects a malformed value', () => {
    expect(() => nextAppVersion('v2026.11.23', NOW)).toThrow();
  });
});

describe('parseTarget', () => {
  test('accepts api and client only', () => {
    expect(parseTarget('api')).toBe('api');
    expect(parseTarget('client')).toBe('client');
    expect(() => parseTarget(undefined)).toThrow(/usage/);
    expect(() => parseTarget('both')).toThrow(/usage/);
  });
});

describe('bumpTarget', () => {
  function fixture(api: string, client: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-bump-'));
    for (const [dir, v] of [['api', api], ['client', client]] as const) {
      fs.mkdirSync(path.join(root, dir));
      fs.writeFileSync(path.join(root, dir, 'VERSION'), `${v}\n`);
    }
    return root;
  }
  const read = (root: string, dir: string) => fs.readFileSync(path.join(root, dir, 'VERSION'), 'utf8');

  test('api bumps only api/VERSION', () => {
    const root = fixture('2026.11.23-03', '2026.11.01');
    expect(bumpTarget(root, 'api', NOW)).toBe('2026.11.23-04');
    expect(read(root, 'api')).toBe('2026.11.23-04\n');
    expect(read(root, 'client')).toBe('2026.11.01\n');
    fs.rmSync(root, { recursive: true });
  });

  test('client bumps only client/VERSION, from its own sequence', () => {
    const root = fixture('2026.11.23-03', '2026.11.01');
    expect(bumpTarget(root, 'client', NOW)).toBe('2026.11.23');
    expect(read(root, 'client')).toBe('2026.11.23\n');
    expect(read(root, 'api')).toBe('2026.11.23-03\n');
    fs.rmSync(root, { recursive: true });
  });
});
