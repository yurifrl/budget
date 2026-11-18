-- 0021 · Bank-link is strictly 1:1 — one upstream account may be linked to at
--   most one budget account (and each budget account holds at most one link).
--   accounts.connection_id already enforces the account-side single link
--   (a plain column); this index enforces the upstream side.
--   If pre-existing rows already share an upstream pair (the bug this work
--   closes), keep the oldest link and clear the rest — unlink semantics are
--   "the account stays, it just loses its bank link".
with ranked as (
  select id,
         row_number() over (
           partition by connection_id, external_account_id
           order by created_at asc, id asc
         ) as rn
    from public.accounts
   where connection_id is not null and external_account_id is not null
)
update public.accounts a
   set connection_id = null, external_account_id = null, institution = null
  from ranked r
 where a.id = r.id and r.rn > 1;

create unique index accounts_link_unique
  on public.accounts (connection_id, external_account_id)
  where connection_id is not null and external_account_id is not null;
