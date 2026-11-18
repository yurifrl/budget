-- =============================================================================
-- 0019 · Health identity re-point — log_entry / user_profile → public.users
--   0005 pointed health ownership at auth.users, a stub the bootstrap creates
--   with zero rows — so every log/profile write died on the FK. The
--   authoritative identity store is public.users (0012), the same table
--   budgets (0013) and connections (0014) already reference, resolved
--   per-request by requireUser. Re-point both FKs, clean any orphaned rows
--   first, and drop the auth stub schema. Health routes no longer accept a
--   client user_id: the session supplies the owner.
-- =============================================================================

-- Orphans would block the new constraint; none should exist, but a data-
-- carrying DB that predates identity may hold unowned rows.
delete from public.log_entry
where not exists (select 1 from public.users u where u.id = log_entry.user_id);

delete from public.user_profile
where not exists (select 1 from public.users u where u.id = user_profile.user_id);

alter table public.log_entry
  drop constraint if exists log_entry_user_id_fkey,
  add constraint log_entry_user_id_fkey
    foreign key (user_id) references public.users (id) on delete cascade;

alter table public.user_profile
  drop constraint if exists user_profile_user_id_fkey,
  add constraint user_profile_user_id_fkey
    foreign key (user_id) references public.users (id) on delete cascade;

-- 0005's auth stub is superseded; nothing references it anymore.
drop schema if exists auth cascade;
