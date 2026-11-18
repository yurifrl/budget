import { describe, expect, test } from 'bun:test';

import { helloGet } from '@shared/contracts/hello';

import { createApp } from './app';

describe('hello_get route', () => {
  const app = createApp();

  test('serves the contract path in-process', async () => {
    const res = await app.request(`${helloGet.path}?name=Ada`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Hello, Ada!' });
  });

  test('defaults the name', async () => {
    const res = await app.request(helloGet.path);
    expect(await res.json()).toEqual({ message: 'Hello, world!' });
  });

  test('rejects invalid input with the shared schema', async () => {
    const res = await app.request(`${helloGet.path}?name=`);
    expect(res.status).toBe(400);
  });
});
