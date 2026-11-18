import { afterEach, describe, expect, test } from 'bun:test';
import { addDaysToDate, localToday } from './date';

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** Build an instant from wall-clock parts in the given zone (TZ is re-read per Date op in Bun). */
function inZone(tz: string, make: () => Date): Date {
  process.env.TZ = tz;
  return make();
}

describe('localToday', () => {
  test('UTC-3 late evening stays on the local day (month end)', () => {
    const now = inZone('America/Sao_Paulo', () => new Date(2026, 10, 30, 23, 30));
    // 23:30 local is 02:30Z on Dec 1: the old UTC code returned 2026-12-01.
    expect(now.toISOString()).toBe('2026-12-01T02:30:00.000Z');
    expect(localToday(now)).toBe('2026-11-30');
  });

  test('UTC+ zone early morning is already the local day', () => {
    const now = inZone('Pacific/Auckland', () => new Date(2026, 5, 15, 1, 0));
    // 01:00 local is 13:00Z on the 14th: the old UTC code returned 2026-06-14.
    expect(now.toISOString()).toBe('2026-06-14T13:00:00.000Z');
    expect(localToday(now)).toBe('2026-06-15');
  });

  test('defaults to the current instant', () => {
    expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('addDaysToDate', () => {
  test('crosses month and year boundaries', () => {
    expect(addDaysToDate('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDaysToDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysToDate('2028-02-28', 1)).toBe('2028-02-29');
  });

  test.each([
    ['America/New_York', '2026-03-08', '2026-03-09', '2026-03-07'], // US spring forward
    ['America/New_York', '2026-11-01', '2026-11-02', '2026-10-31'], // US fall back
    ['America/Sao_Paulo', '2018-11-03', '2018-11-04', '2018-11-02'], // BR DST start (midnight gap)
    ['Europe/London', '2026-03-29', '2026-03-30', '2026-03-28'],
  ])('%s: DST day %s moves exactly one day', (tz, day, next, prev) => {
    process.env.TZ = tz;
    expect(addDaysToDate(day, 1)).toBe(next);
    expect(addDaysToDate(day, -1)).toBe(prev);
  });
});
