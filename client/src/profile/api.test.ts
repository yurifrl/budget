import { describe, expect, test } from 'bun:test';

import { listGrantsRequest, revokeGrantRequest } from './api';

describe('connected apps requests (from contracts)', () => {
  test('list is GET /oauth/grants with no params or body', () => {
    expect(listGrantsRequest()).toEqual({ url: '/oauth/grants', method: 'GET' });
  });

  test('revoke is DELETE /oauth/grants/:id with the id in the path only', () => {
    expect(revokeGrantRequest('0b6f1c1e-3c1a-4f54-8a52-2d9d6f1a9b11')).toEqual({
      url: '/oauth/grants/0b6f1c1e-3c1a-4f54-8a52-2d9d6f1a9b11',
      method: 'DELETE',
    });
  });
});
