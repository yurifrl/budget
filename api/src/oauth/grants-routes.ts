/**
 * Connected-apps routes (post-gate: mounted after requireUser). Scoped to the
 * caller's own grants; another user's grant id is a plain 404.
 */
import { Hono } from 'hono';

import { pool } from '../core/db';
import { implement, mountOperations, type AnyOperation } from '../core/operation';
import { HttpError } from '../core/validate';
import { requireUserId } from '../user';
import { oauthGrantsList, oauthGrantsRevoke } from '@shared/contracts/oauth';

interface GrantRow {
  id: string;
  client_name: string;
  scope: string;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
}

export const operations: readonly AnyOperation[] = [
  implement(oauthGrantsList, async (c) => {
    const { rows } = await pool.query<GrantRow>(
      `select g.id, oc.client_name, g.scope, g.created_at, g.expires_at,
              (select max(t.created_at) from public.oauth_refresh_tokens t where t.grant_id = g.id) as last_used_at
         from public.oauth_grants g
         join public.oauth_clients oc on oc.client_id = g.client_id
        where g.user_id = $1 and g.revoked_at is null and g.expires_at > now()
        order by g.created_at desc`,
      [requireUserId(c)],
    );
    return rows.map((r) => ({
      id: r.id,
      client_name: r.client_name,
      scopes: r.scope.split(' ').filter(Boolean),
      created_at: r.created_at.toISOString(),
      last_used_at: r.last_used_at ? r.last_used_at.toISOString() : null,
      expires_at: r.expires_at.toISOString(),
    }));
  }),
  implement(oauthGrantsRevoke, async (c, { id }) => {
    const { rowCount } = await pool.query(
      'update public.oauth_grants set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null',
      [id, requireUserId(c)],
    );
    if (rowCount !== 1) throw new HttpError(404, 'grant not found');
    return { ok: true };
  }),
];

const router = new Hono();
mountOperations(router, operations);
export default router;
