-- 0032 · Category bundles (docs/category-bundles-design.md).
--   A bundle is a display-only roll-up of categories inside one category group.
--   categories.bundle_id → bundle.group_id = categories.group_id is enforced by
--   the handlers (server/budget/routes/category-bundles.ts), not the schema.
--   Deleting a bundle ("Ungroup") only clears bundle_id; categories stay.
create table if not exists public.category_bundles (
  id         uuid primary key default gen_random_uuid(),
  budget_id  uuid not null references public.budgets(id) on delete cascade,
  group_id   uuid not null references public.category_groups(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create index if not exists category_bundles_group_idx on public.category_bundles(group_id);
create index if not exists category_bundles_budget_idx on public.category_bundles(budget_id);
alter table public.categories
  add column if not exists bundle_id uuid references public.category_bundles(id) on delete set null;
