-- 0107 · resumable history import per linked account (budget-u5yt).
--   A full import (first sync of an account, or Re-import history) pages the
--   provider until its history (or the sync window) ends, capped at
--   FULL_IMPORT_MAX_ROWS rows per sync. When the cap is hit, the point where
--   that pull stopped is kept here and the next syncs continue older pages
--   from it until the provider has nothing older; then the row is deleted.
--   A row present = "history still loading" on the bank page.
--
--   Additive only (new table). Owned by the connections feature; cleaned up
--   with the account (ON DELETE CASCADE).
--
--   cursor:      the provider's opaque continuation for the next (older) page,
--                null when it gave none (the pull then walks again from the
--                newest page, keeping only rows on or before before_date).
--   before_date: the oldest date the pull reached (inclusive upper bound of
--                what is still to import).
--   rows_pulled: rows pulled so far by this history import (diagnostics).
create table if not exists public.connection_account_backfill (
  account_id  uuid primary key references public.accounts(id) on delete cascade,
  cursor      text,
  before_date date not null,
  rows_pulled integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
