import type { Context } from 'hono';

import { serviceTokenMatches } from './authz';
import { pool } from '../core/db';

import type { IdentityRole, IdentityUser } from './types';

const SVC_EMAIL = 'svc-budget-mcp@syscd.local';
const SVC_SUB = 'svc:budget-mcp';

/**
 * Collision policy (USER-01 / assumption A5): a sign-in identity collides
 * with an existing row holding a different google_sub, or an upstream email
 * change would take a google_sub owned by another row. Merging silently
 * would hand a budget to the wrong account — the sign-in is refused with a
 * 403 instead (the error message doubles as the HTTP error body).
 */
export class EmailAlreadyProvisionedError extends Error {
  constructor() {
    super('email already provisioned');
  }
}

type Identity = { sub?: string | null; name?: string | null };

// Advisory-lock key (assumption A2): the literal int value of
// hashtext('syscd:users:bootstrap') (=-2134291256), computed once so the
// store carries no runtime dependency on hashtext. PG resolves the single
// bigint-key overload with the same key space position.
const BOOTSTRAP_LOCK_KEY = -2134291256n;

// Google's unique constraint on users.google_sub (PG default name) — used
// to surface a cross-email sub take as the A5 collision error.
const GOOGLE_SUB_UNIQUE_CONSTRAINT = 'users_google_sub_key';

type UpsertRow = {
  id: string;
  email: string;
  name: string | null;
  google_sub: string | null;
  role: IdentityRole;
  status: IdentityUser['status'];
  inserted: boolean;
};

const mapRow = (row: UpsertRow): IdentityUser => ({
  id: row.id,
  email: row.email,
  name: row.name ?? undefined,
  googleSub: row.google_sub,
  role: row.role,
  status: row.status,
});

/**
 * Resolve the persisted user for a session email, provisioning it JIT-style
 * on first sight (criterion 1). Normalizes the email first — equality is by
 * construction, never left to the CHECK to catch mixed case.
 *
 * Inside one transaction: an xact-scoped advisory lock serializes bootstrap
 * sign-ins (so the first-admin seed promotes exactly one row under
 * concurrency), then a single upsert with insert-detection. `DO UPDATE` —
 * never `DO NOTHING` — because every concurrent writer must RETURN the row.
 *
 * Identity is only passed by sign-in-time callers: a present sub backfills
 * a null google_sub (old cookies carry no sub — JWT shape frozen per D-01),
 * an incoming name only fills a missing one (the name is user-owned once set —
 * a name edited on the profile page must survive the next Google sign-in),
 * and last_seen_at is stamped on every touch. Callers resolving authority per request pass no
 * identity, leaving any stored google_sub untouched.
 *
 * First-admin seeding: only the very first insert may capture the bootstrap
 * slot, and only when the caller is seed-eligible (human sessions and the
 * dev bypass; service rows never).
 *
 * NEVER memoize the resolved user at module scope — criterion 2 reads roles
 * from the DB on every request.
 */
export async function resolveOrCreateSessionUser(
  email: string,
  identity?: Identity,
  opts?: { seedEligible?: boolean },
): Promise<IdentityUser> {
  const normalized = email.toLowerCase().trim();
  const sub = identity?.sub ?? null;
  const name = identity?.name ?? null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);
    const upsert = await client.query<UpsertRow>(
      `insert into public.users (id, google_sub, email, name)
       values (gen_random_uuid(), $1, $2, $3)
       on conflict (email) do update
         set google_sub = coalesce(public.users.google_sub, excluded.google_sub),
             name = coalesce(public.users.name, excluded.name),
             last_seen_at = now()
       returning id, email, name, google_sub, role, status, (xmax = 0) as inserted`,
      [sub, normalized, name],
    );
    const resolved = mapRow(upsert.rows[0]);
    // Collision policy: a row holding a different non-null google_sub is a
    // colliding identity, not a backfill.
    if (sub && resolved.googleSub && resolved.googleSub !== sub) {
      throw new EmailAlreadyProvisionedError();
    }
    if (upsert.rows[0].inserted && opts?.seedEligible !== false) {
      const promoted = await client.query<{ role: IdentityRole }>(
        `update public.users set role = 'admin'
         where id = $1 and not exists (select 1 from public.users where role = 'admin')
         returning role`,
        [resolved.id],
      );
      if (promoted.rows[0]) resolved.role = promoted.rows[0].role;
    }
    await client.query('commit');
    return resolved;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    if (err instanceof EmailAlreadyProvisionedError) throw err;
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === GOOGLE_SUB_UNIQUE_CONSTRAINT) {
      // A cross-email sub take: the row arrives for a new email carrying a
      // google_sub owned by another row (upstream email change) — refuse,
      // never take ownership of the other row's budget.
      throw new EmailAlreadyProvisionedError();
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Pre-provision (or look up) a user row by email without a sign-in — used to
 * invite someone to a shared budget before they have ever logged in. The row
 * has no google_sub and role 'user'; resolveOrCreateSessionUser's
 * `on conflict (email)` upsert links it on the person's first Google
 * sign-in (sub backfilled, same id, so memberships persist). Idempotent:
 * an existing row (provisioned or signed-in) is returned untouched, except
 * that an optional `name` fills a missing one (never overwrites).
 */
export async function provisionUserByEmail(
  email: string,
  name?: string,
): Promise<{ id: string; email: string; name: string | null }> {
  const normalized = email.toLowerCase().trim();
  const label = name?.trim() || null;
  const { rows } = await pool.query<{ id: string; email: string; name: string | null }>(
    `with ins as (
       insert into public.users (id, email, name) values (gen_random_uuid(), $1, $2)
       on conflict (email) do nothing
       returning id, email, name
     ),
     fill as (
       -- A name given at invite time only fills a missing one: the name is
       -- user-owned once set (never overwrite a real user's name).
       update public.users set name = $2
        where email = $1 and name is null and $2::text is not null
          and not exists (select 1 from ins)
       returning id, email, name
     )
     select id, email, name from ins
     union all
     select id, email, name from fill
     union all
     select id, email, name from public.users
      where email = $1 and not exists (select 1 from fill) and not exists (select 1 from ins)
     limit 1`,
    [normalized, label],
  );
  return rows[0];
}

/**
 * Dev-bypass admin guarantee (criterion 3): the bypassed machine has no
 * other authority, so its row is unconditionally admin in every dev-DB
 * state — unlike the bootstrap seed promote, which is once-only.
 */
export async function ensureDevAdminRole(id: string): Promise<void> {
  await pool.query(`update public.users set role = 'admin' where id = $1 and role <> 'admin'`, [id]);
}

/**
 * Service lane (criterion 3): the sole bearer authority post-gate for
 * MCP/CLI callers. Provisions exactly one persisted service row
 * (`svc-budget-mcp@syscd.local` / `svc:budget-mcp` — assumption A6 marker
 * values) resolved to the same id across calls. The service row is never
 * admin-eligible, even when it is the first row ever inserted.
 */
export async function resolveServiceUser(c: Context): Promise<IdentityUser | null> {
  const auth = c.req.header('Authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (!bearer || !serviceTokenMatches(bearer)) return null;
  return resolveOrCreateSessionUser(SVC_EMAIL, { sub: SVC_SUB }, { seedEligible: false });
}

/**
 * Access-token liveness: the OAuth grant behind a token must still exist,
 * be unrevoked and inside its absolute lifetime. Revoking a grant (explicit
 * revoke, refresh-token reuse detection) therefore kills its outstanding
 * access tokens at the next request instead of waiting out the 1h TTL.
 * The grant tables are owned by server/oauth (migration 0025); this is the
 * one read of them from the identity layer.
 */
export async function isGrantActive(grantId: string, email: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `select 1
       from public.oauth_grants g
       join public.users u on u.id = g.user_id
      where g.id = $1 and u.email = $2
        and g.revoked_at is null and g.expires_at > now()`,
    [grantId, email.toLowerCase()],
  );
  return rowCount === 1;
}

/**
 * A placeholder person: a named row with no email, no google_sub and role
 * 'user' — grouping only. It can never sign in (a session always carries an
 * email and NULL never matches `on conflict (email)` or the allow-list); an
 * email is linked later with {@link linkEmailToPlaceholder}.
 */
export async function createPlaceholderUser(name: string): Promise<{ id: string; email: null; name: string }> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `insert into public.users (id, email, name) values (gen_random_uuid(), null, $1) returning id, name`,
    [name.trim()],
  );
  return { ...rows[0], email: null };
}

type Queryable = Pick<typeof pool, 'query'>;

/**
 * Every single-column foreign key that references public.users(id), read from
 * the catalog so a future table that points at users is merged automatically
 * (and the merge test fails loudly on a composite FK it cannot repoint).
 */
export async function userReferenceColumns(db: Queryable = pool): Promise<{ table: string; column: string }[]> {
  const { rows } = await db.query<{ table: string; column: string; width: number }>(
    `select format('%I.%I', n.nspname, r.relname) as "table", a.attname as "column", array_length(c.conkey, 1) as width
       from pg_constraint c
       join pg_class r on r.oid = c.conrelid
       join pg_namespace n on n.oid = r.relnamespace
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.confrelid = 'public.users'::regclass
      order by 1, 2`,
  );
  const composite = rows.find((r) => r.width !== 1);
  if (composite) throw new Error(`cannot merge users: composite FK on ${composite.table}`);
  return rows.map(({ table, column }) => ({ table, column }));
}

/**
 * Repoint every reference to user `fromId` at `intoId` inside the caller's
 * transaction. Row by row under a savepoint: a row that would collide with a
 * unique key the target already holds (same budget membership, the target's
 * own avatar...) is dropped instead — the target's data wins.
 */
async function repointUserReferences(
  client: Queryable,
  fromId: string,
  intoId: string,
): Promise<void> {
  for (const { table, column } of await userReferenceColumns(client)) {
    const { rows } = await client.query<{ ctid: string }>(`select ctid::text as ctid from ${table} where ${column} = $1`, [fromId]);
    for (const { ctid } of rows) {
      await client.query('savepoint repoint');
      try {
        await client.query(`update ${table} set ${column} = $1 where ctid = $2::tid`, [intoId, ctid]);
        await client.query('release savepoint repoint');
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
        await client.query('rollback to savepoint repoint');
        await client.query(`delete from ${table} where ctid = $1::tid`, [ctid]);
      }
    }
  }
}

export class EmailLinkError extends Error {}

/**
 * Attach an email to a placeholder person. No row holds the email yet → the
 * placeholder simply gains it (it becomes a pre-provisioned user who links on
 * their first Google sign-in). A row already holds it (signed in, or invited)
 * → the placeholder is MERGED into that row in one transaction: all references
 * repointed (see {@link repointUserReferences}), a missing name filled from the
 * placeholder, then the placeholder deleted. Returns the surviving user id.
 */
export async function linkEmailToPlaceholder(
  placeholderId: string,
  rawEmail: string,
): Promise<{ id: string; merged: boolean }> {
  const email = rawEmail.toLowerCase().trim();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const ph = await client.query<{ name: string | null }>(
      'select name from public.users where id = $1 and email is null for update',
      [placeholderId],
    );
    if (!ph.rows[0]) throw new EmailLinkError('person already has an email');
    const existing = await client.query<{ id: string }>('select id from public.users where email = $1 for update', [email]);
    let result: { id: string; merged: boolean };
    if (!existing.rows[0]) {
      await client.query('update public.users set email = $2 where id = $1', [placeholderId, email]);
      result = { id: placeholderId, merged: false };
    } else {
      const intoId = existing.rows[0].id;
      await repointUserReferences(client, placeholderId, intoId);
      await client.query('update public.users set name = $2 where id = $1 and name is null', [intoId, ph.rows[0].name]);
      await client.query('delete from public.users where id = $1', [placeholderId]);
      result = { id: intoId, merged: true };
    }
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Rename a person who has not signed in (placeholder or pending invitee).
 * A signed-in user's name is theirs (profile) — returns false, nothing changed.
 */
export async function renameUnclaimedUser(userId: string, name: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update public.users set name = $2 where id = $1 and google_sub is null`,
    [userId, name.trim()],
  );
  return (rowCount ?? 0) > 0;
}
