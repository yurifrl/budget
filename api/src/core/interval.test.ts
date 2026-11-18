import { afterEach, describe, expect, test } from 'bun:test';

import { createSingleFlight, parseIntEnv, startInterval } from './interval';

const quiet = () => {
  const warns: string[] = [];
  const errors: unknown[][] = [];
  return {
    warns,
    errors,
    log: { warn: (m: string) => void warns.push(m), error: (...a: unknown[]) => void errors.push(a) },
  };
};

describe('parseIntEnv', () => {
  test('valid values pass through', () => {
    expect(parseIntEnv('60', 300)).toBe(60);
    expect(parseIntEnv(' 60 ', 300)).toBe(60);
  });
  test.each([undefined, '', '   ', 'abc', 'NaN', 'Infinity', '0', '-5', '1.5'])(
    'bad value %p falls back to default',
    (raw) => {
      expect(parseIntEnv(raw, 300)).toBe(300);
    },
  );
  test('below a custom floor falls back; at the floor is kept', () => {
    expect(parseIntEnv('4', 300, 5)).toBe(300);
    expect(parseIntEnv('5', 300, 5)).toBe(5);
  });
  test('floor 0 allows an explicit 0 (retention disabled)', () => {
    expect(parseIntEnv('0', 30, 0)).toBe(0);
    expect(parseIntEnv('', 30, 0)).toBe(30);
  });
});

describe('createSingleFlight', () => {
  test('overlapping calls are skipped and logged once; runs again after completion', async () => {
    const { log, warns } = quiet();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tick = createSingleFlight(
      't',
      async () => {
        runs += 1;
        if (runs === 1) await gate;
      },
      log,
    );
    const first = tick();
    await tick();
    await tick();
    expect(runs).toBe(1);
    expect(warns).toHaveLength(1);
    release();
    await first;
    await tick();
    expect(runs).toBe(2);
  });

  test('a rejecting or throwing tick is logged and does not block later ticks', async () => {
    const { log, errors } = quiet();
    let n = 0;
    const tick = createSingleFlight(
      't',
      () => {
        n += 1;
        if (n === 1) throw new Error('sync');
        if (n === 2) return Promise.reject(new Error('async'));
      },
      log,
    );
    await tick();
    await tick();
    await tick();
    expect(n).toBe(3);
    expect(errors).toHaveLength(2);
  });

  test('forwards arguments', async () => {
    const seen: unknown[] = [];
    const tick = createSingleFlight('t', (a: number) => void seen.push(a), quiet().log);
    await tick(7);
    expect(seen).toEqual([7]);
  });
});

describe('startInterval', () => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  afterEach(() => {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  });

  test.each([0, NaN, -1, Infinity])('refuses to schedule %p ms', (ms) => {
    let called = false;
    globalThis.setInterval = (() => {
      called = true;
      return 0;
    }) as unknown as typeof setInterval;
    expect(() => startInterval(() => {}, ms)).toThrow();
    expect(called).toBe(false);
  });

  test('registers the interval, fires the tick, and stop clears it', () => {
    let fn!: () => void;
    let ms = 0;
    let cleared = false;
    globalThis.setInterval = ((f: () => void, m: number) => {
      fn = f;
      ms = m;
      return 42;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
      cleared = true;
    }) as unknown as typeof clearInterval;
    let ticks = 0;
    const stop = startInterval(() => void (ticks += 1), 5000);
    fn();
    expect(ms).toBe(5000);
    expect(ticks).toBe(1);
    stop();
    expect(cleared).toBe(true);
  });
});
