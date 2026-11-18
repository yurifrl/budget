import { describe, expect, test } from 'bun:test';

import { mediaForWidth } from './breakpoints';

describe('mediaForWidth (Tamagui v5 max-md / lg)', () => {
  test('web: phone up to 767.98, desktop from 1024', () => {
    expect(mediaForWidth(390, 'web')).toEqual({ 'max-md': true, lg: false });
    expect(mediaForWidth(767.98, 'web')).toEqual({ 'max-md': true, lg: false });
    expect(mediaForWidth(768, 'web')).toEqual({ 'max-md': false, lg: false });
    expect(mediaForWidth(1023, 'web')).toEqual({ 'max-md': false, lg: false });
    expect(mediaForWidth(1024, 'web')).toEqual({ 'max-md': false, lg: true });
  });

  test('native: non-overlap is 1pt, so 767 is phone and 767.5 is tablet', () => {
    expect(mediaForWidth(767, 'ios')['max-md']).toBe(true);
    expect(mediaForWidth(767.5, 'ios')['max-md']).toBe(false);
    expect(mediaForWidth(1024, 'ios').lg).toBe(true);
  });
});
