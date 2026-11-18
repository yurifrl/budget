-- 0101 · multi-user sign-in bookkeeping. Additive and nullable (this database
--   is shared with the running syscd-app, which never names these columns).
--
--   users.signed_in_at: when this API first saw the person authenticated (any
--     provider). NULL = never signed in here: an invited e-mail or a
--     placeholder person. Until now "never signed in" was read from
--     google_sub IS NULL, which is wrong for people who only ever use
--     Cloudflare Access (their google_sub stays NULL for good): they showed as
--     pending forever and any budget member could rename them. Backfilled for
--     rows that hold a Google subject; everyone else is stamped on their next
--     request (resolveOrCreateSessionUser).
--
--   oauth_grants.idp: how the session that approved the grant signed in
--     ('access' = Cloudflare Access; NULL = Google, or a grant made before
--     this column). An Access person's tokens are then not checked against
--     the Google allow-list (see isAllowed in api/src/user/config.ts).
alter table public.users
  add column if not exists signed_in_at timestamptz;

update public.users
   set signed_in_at = last_seen_at
 where signed_in_at is null and google_sub is not null;

alter table public.oauth_grants
  add column if not exists idp text;
