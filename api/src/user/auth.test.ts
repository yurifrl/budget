import { describe, it, expect } from 'bun:test';

import { issueSession, verifySession } from './auth';

describe('session tokens', () => {
  it('round-trips an issued session, lowercasing the email', async () => {
    const token = await issueSession('secret', 'A@B.com', 60);
    expect(await verifySession('secret', token)).toEqual({ email: 'a@b.com' });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await issueSession('secret', 'a@b.com', 60);
    expect(await verifySession('other', token)).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const token = await issueSession('secret', 'a@b.com', 60);
    expect(await verifySession('secret', token + 'x')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await issueSession('secret', 'a@b.com', -1);
    expect(await verifySession('secret', token)).toBeNull();
  });
});
