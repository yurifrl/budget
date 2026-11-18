import { pool, withTransaction } from '../core/db';

import { randomToken, sha256Hex } from './crypto';

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  if (clientId.length === 0 || clientId.length > 128) return null;
  const { rows } = await pool.query<{ client_id: string; client_name: string; redirect_uris: string[] }>(
    'select client_id, client_name, redirect_uris from public.oauth_clients where client_id = $1',
    [clientId],
  );
  const r = rows[0];
  return r ? { clientId: r.client_id, clientName: r.client_name, redirectUris: r.redirect_uris } : null;
}

/**
 * Insert a client unless the rolling-hour registration cap is reached. The
 * cap check and insert are one statement, so concurrent registrations cannot
 * race past it by more than the in-flight snapshot window.
 */
export async function createClient(
  name: string,
  redirectUris: string[],
  maxPerHour: number,
): Promise<OAuthClient | null> {
  const clientId = `c_${randomToken().slice(0, 22)}`;
  const { rowCount } = await pool.query(
    `insert into public.oauth_clients (client_id, client_name, redirect_uris)
     select $1, $2, $3
      where (select count(*) from public.oauth_clients where created_at > now() - interval '1 hour') < $4`,
    [clientId, name, redirectUris, maxPerHour],
  );
  return rowCount === 1 ? { clientId, clientName: name, redirectUris } : null;
}

export interface NewCode {
  userId: string;
  clientId: string;
  scope: string;
  resource: string;
  redirectUri: string;
  codeChallenge: string;
  codeTtlSeconds: number;
  grantTtlSeconds: number;
}

/** Approve: create the grant and a single-use code bound to it. Returns the raw code. */
export async function createGrantAndCode(n: NewCode): Promise<string> {
  const code = randomToken();
  return withTransaction(pool, async (client) => {
    // Opportunistic cleanup keeps the code table small without a scheduler.
    await client.query(`delete from public.oauth_codes where expires_at < now() - interval '1 day'`);
    const { rows } = await client.query<{ id: string }>(
      `insert into public.oauth_grants (id, user_id, client_id, scope, resource, expires_at)
       values (gen_random_uuid(), $1, $2, $3, $4, now() + make_interval(secs => $5))
       returning id`,
      [n.userId, n.clientId, n.scope, n.resource, n.grantTtlSeconds],
    );
    await client.query(
      `insert into public.oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
       values ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [sha256Hex(code), rows[0]!.id, n.redirectUri, n.codeChallenge, n.codeTtlSeconds],
    );
    return code;
  });
}

export interface RedeemedGrant {
  grantId: string;
  userId: string;
  email: string;
  clientId: string;
  scope: string;
  resource: string;
  redirectUri: string;
  codeChallenge: string;
}

/**
 * Atomically consume a code: one UPDATE flips consumed_at only if the code is
 * unconsumed, unexpired and its grant is live — two concurrent redeemers can
 * never both win. A code that exists but was already consumed is a replay and
 * revokes its grant (and with it anything already issued from it).
 */
export async function redeemCode(code: string): Promise<RedeemedGrant | null> {
  const hash = sha256Hex(code);
  const { rows } = await pool.query<{
    grant_id: string; user_id: string; email: string; client_id: string; scope: string;
    resource: string; redirect_uri: string; code_challenge: string;
  }>(
    `with c as (
       update public.oauth_codes oc
          set consumed_at = now()
         from public.oauth_grants g
        where oc.code_hash = $1 and oc.consumed_at is null and oc.expires_at > now()
          and g.id = oc.grant_id and g.revoked_at is null and g.expires_at > now()
        returning oc.grant_id, oc.redirect_uri, oc.code_challenge
     )
     select c.grant_id, g.user_id, u.email, g.client_id, g.scope, g.resource, c.redirect_uri, c.code_challenge
       from c join public.oauth_grants g on g.id = c.grant_id join public.users u on u.id = g.user_id
      where u.status = 'active'`,
    [hash],
  );
  const r = rows[0];
  if (r) {
    return {
      grantId: r.grant_id, userId: r.user_id, email: r.email, clientId: r.client_id, scope: r.scope,
      resource: r.resource, redirectUri: r.redirect_uri, codeChallenge: r.code_challenge,
    };
  }
  await pool.query(
    `update public.oauth_grants set revoked_at = now()
      where revoked_at is null
        and id = (select grant_id from public.oauth_codes where code_hash = $1 and consumed_at is not null)`,
    [hash],
  );
  return null;
}

/** Mint the first refresh token of a grant. Returns the raw token. */
export async function issueRefreshToken(grantId: string): Promise<string> {
  const token = randomToken();
  await pool.query('insert into public.oauth_refresh_tokens (token_hash, grant_id) values ($1, $2)', [
    sha256Hex(token),
    grantId,
  ]);
  return token;
}

export interface RotatedGrant {
  grantId: string;
  email: string;
  clientId: string;
  scope: string;
  refreshToken: string;
}

/**
 * Rotate: atomically mark the presented token used (only if unused and its
 * grant is live, active user, matching client) and insert its successor in
 * the same transaction. Presenting an already-rotated token is reuse: the
 * whole grant is revoked. Unknown token or wrong client: plain failure.
 */
export async function rotateRefreshToken(token: string, clientId: string): Promise<RotatedGrant | null> {
  const hash = sha256Hex(token);
  const next = randomToken();
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ grant_id: string; email: string; client_id: string; scope: string }>(
      `update public.oauth_refresh_tokens t
          set used_at = now()
         from public.oauth_grants g, public.users u
        where t.token_hash = $1 and t.used_at is null
          and g.id = t.grant_id and g.client_id = $2 and g.revoked_at is null and g.expires_at > now()
          and u.id = g.user_id and u.status = 'active'
        returning t.grant_id, u.email, g.client_id, g.scope`,
      [hash, clientId],
    );
    const r = rows[0];
    if (r) {
      await client.query('insert into public.oauth_refresh_tokens (token_hash, grant_id) values ($1, $2)', [
        sha256Hex(next),
        r.grant_id,
      ]);
      return { grantId: r.grant_id, email: r.email, clientId: r.client_id, scope: r.scope, refreshToken: next };
    }
    // Reuse detection: a rotated token for THIS client presented again.
    await client.query(
      `update public.oauth_grants set revoked_at = now()
        where revoked_at is null and client_id = $2
          and id = (select grant_id from public.oauth_refresh_tokens where token_hash = $1 and used_at is not null)`,
      [hash, clientId],
    );
    return null;
  });
}

export async function revokeGrant(grantId: string): Promise<void> {
  await pool.query('update public.oauth_grants set revoked_at = now() where id = $1 and revoked_at is null', [grantId]);
}

/** Revoke by refresh token (any state). Returns nothing: RFC 7009 never discloses. */
export async function revokeByRefreshToken(token: string, clientId: string | null): Promise<void> {
  await pool.query(
    `update public.oauth_grants set revoked_at = now()
      where revoked_at is null and ($2::text is null or client_id = $2)
        and id = (select grant_id from public.oauth_refresh_tokens where token_hash = $1)`,
    [sha256Hex(token), clientId],
  );
}
