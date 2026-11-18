-- 0033 · Per-budget change revision (client freshness signal).
--   budgets.revision is a monotonically increasing counter bumped, inside the
--   writing transaction, by ANY insert/update/delete on a budget-scoped table
--   (HTTP routes, the Temporal sync worker, bank webhooks, CLI, MCP, restore).
--   Clients poll GET /budget-revision and refetch when it changes. Triggers
--   (not handler code) so a future write path cannot forget to bump it.
--
--   Why DEFERRED constraint triggers: a plain trigger would update the budgets
--   row mid-transaction and hold that row lock until commit, serializing every
--   writer of a budget and deadlocking against handlers that lock other rows
--   in a different order. Deferred, the bump runs at COMMIT: the lock is taken
--   and released within the commit itself, so it cannot join a lock cycle. A
--   rolled-back write never bumps. Constraint triggers are row-level, so the
--   function dedupes per transaction (a transaction-local setting) and a
--   1.000-row import costs one budgets update, not 1.000.
alter table public.budgets
  add column if not exists revision bigint not null default 0;

create or replace function public.budget_revision_bump() returns trigger
language plpgsql as $$
declare
  bid uuid := case when tg_op = 'DELETE' then old.budget_id else new.budget_id end;
  flag text := 'syscd.rev_' || replace(bid::text, '-', '');
begin
  if coalesce(current_setting(flag, true), '') = '' then
    perform set_config(flag, '1', true);
    update public.budgets set revision = revision + 1 where id = bid;
  end if;
  -- A budget_id change (never done today) dirties the old budget too.
  if tg_op = 'UPDATE' and old.budget_id is distinct from new.budget_id then
    flag := 'syscd.rev_' || replace(old.budget_id::text, '-', '');
    if coalesce(current_setting(flag, true), '') = '' then
      perform set_config(flag, '1', true);
      update public.budgets set revision = revision + 1 where id = old.budget_id;
    end if;
  end if;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'accounts', 'assignments', 'budget_members', 'categories', 'category_bundles',
    'category_groups', 'category_notes', 'category_targets', 'month_notes',
    'payee_locations', 'payees', 'scheduled_subtransactions', 'scheduled_transactions',
    'subtransactions', 'transactions', 'txn_repeat_rules'
  ] loop
    execute format('drop trigger if exists budget_revision_bump on public.%I', t);
    execute format('create constraint trigger budget_revision_bump
      after insert or update or delete on public.%I
      deferrable initially deferred for each row
      execute function public.budget_revision_bump()', t);
  end loop;
end $$;
