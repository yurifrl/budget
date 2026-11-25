-- 0113 · Categorize page settings (budget-edxg). Additive only: one NEW table,
--   which the running syscd-app (sharing this database) never names.
--
--   confidence_threshold: suggestions below this 0..1 confidence are hidden
--   from categorize_queue_list. Applied at READ time, so changing it never
--   needs a re-run. 0.8 is the product default (the mock's 80%); absence of a
--   row means the default, so a budget that never opened the page has no row.
create table if not exists public.categorize_settings (
  budget_id            uuid primary key references public.budgets (id) on delete cascade,
  confidence_threshold real not null default 0.8
    check (confidence_threshold >= 0 and confidence_threshold <= 1),
  updated_at           timestamptz not null default now()
);
