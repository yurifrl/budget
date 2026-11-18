-- 0028 · Category person (multi-user sharing, plan ownership).
--   A plan category may optionally belong to one person (a budget member), so
--   a household can split the Plan by who owns each envelope. NULL means
--   "Shared" and is the default, so existing data is unchanged. Membership is
--   validated in the API (isBudgetMember, server/budget/ownership.ts); removing
--   a member nulls their categories in that budget (members.ts), and the FK is
--   `on delete set null` so deleting a user never orphans a category.
alter table public.categories
  add column if not exists user_id uuid references public.users(id) on delete set null;

create index if not exists categories_user_idx on public.categories(user_id);
