import { describe, expect, test } from 'bun:test';

import { AVATAR_MAX_SIDE, candidateSeeds, checkDisplayName, displayName, randomSeed, squareCropRect, uploadErrorMessage } from './model';

describe('profile model', () => {
  test('display name validation trims and bounds', () => {
    expect(checkDisplayName('  Yuri ')).toEqual({ ok: true, value: 'Yuri' });
    expect(checkDisplayName('   ').ok).toBe(false);
    expect(checkDisplayName('x'.repeat(81)).ok).toBe(false);
    expect(checkDisplayName('x'.repeat(80)).ok).toBe(true);
  });

  test('candidateSeeds keeps the current look first and the rest unique', () => {
    const seeds = candidateSeeds('mine', 6);
    expect(seeds).toHaveLength(6);
    expect(seeds[0]).toBe('mine');
    expect(new Set(seeds).size).toBe(6);
  });

  test('randomSeed is short and uses the injected rng', () => {
    expect(randomSeed(() => 0)).toBe('aaaaaaaaaa');
    expect(randomSeed().length).toBeLessThanOrEqual(64);
  });

  test('displayName falls back to the email local part', () => {
    expect(displayName({ name: 'Yuri', email: 'y@x.com' })).toBe('Yuri');
    expect(displayName({ name: null, email: 'dev@localhost' })).toBe('dev');
  });

  test('upload errors are human readable', () => {
    expect(uploadErrorMessage(413, 'x')).toContain('too large');
    expect(uploadErrorMessage(400, 'unsupported image type')).toContain('JPEG');
    expect(uploadErrorMessage('FETCH_ERROR', undefined)).toContain('reach');
  });
});

describe('squareCropRect', () => {
  test('landscape: centered square of the short side', () => {
    expect(squareCropRect(600, 400)).toEqual({ originX: 100, originY: 0, side: 400, outSide: 400 });
  });
  test('portrait: centered vertically', () => {
    expect(squareCropRect(400, 801)).toEqual({ originX: 0, originY: 200, side: 400, outSide: 400 });
  });
  test('already square: identity crop', () => {
    expect(squareCropRect(300, 300)).toEqual({ originX: 0, originY: 0, side: 300, outSide: 300 });
  });
  test('large images are bounded to AVATAR_MAX_SIDE for output only', () => {
    const c = squareCropRect(4032, 3024);
    expect(c.side).toBe(3024);
    expect(c.outSide).toBe(AVATAR_MAX_SIDE);
    expect(c.originX).toBe(504);
    expect(squareCropRect(4000, 3000, 256).outSide).toBe(256);
  });
  test('fractional / degenerate sizes never produce a zero or fractional side', () => {
    expect(squareCropRect(100.7, 50.2).side).toBe(50);
    expect(squareCropRect(0, 0).side).toBe(1);
  });
});
