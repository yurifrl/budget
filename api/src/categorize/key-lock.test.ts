/**
 * The per-key lock: one body at a time for the same key, independent progress
 * for different keys, and a failure releases the queue.
 */
import { describe, expect, test } from 'bun:test';

import { withKeyLock } from './key-lock';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('withKeyLock', () => {
  test('serializes bodies of the same key', async () => {
    let running = 0;
    let maxRunning = 0;
    const body = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await tick();
      running--;
    };
    await Promise.all([withKeyLock('owner-1', body), withKeyLock('owner-1', body), withKeyLock('owner-1', body)]);
    expect(maxRunning).toBe(1);
  });

  test('does not serialize different keys', async () => {
    let running = 0;
    let maxRunning = 0;
    const body = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await tick();
      running--;
    };
    await Promise.all([withKeyLock('owner-a', body), withKeyLock('owner-b', body)]);
    expect(maxRunning).toBe(2);
  });

  test('a rejected body releases the next one and keeps its error', async () => {
    const order: string[] = [];
    const failed = withKeyLock('owner-2', async () => {
      order.push('first');
      throw new Error('boom');
    }).catch((error: Error) => error.message);
    const next = withKeyLock('owner-2', async () => {
      order.push('second');
      return 'ok';
    });
    expect(await failed).toBe('boom');
    expect(await next).toBe('ok');
    expect(order).toEqual(['first', 'second']);
  });
});
